-- Keep vshard global so registered procedures and the interactive admin
-- console can resolve expressions such as vshard.router.info().
vshard = require('vshard')
local common = require('config')

box.cfg({
    listen = os.getenv('LISTEN') or '0.0.0.0:3301',
    memtx_memory = 64 * 1024 * 1024,
    wal_mode = 'write',
    work_dir = '/var/lib/tarantool',
})

box.once('router-users-v1', function()
    box.schema.user.create('app', {password = 'app-secret', if_not_exists = true})
    box.schema.user.grant('app', 'read,write,execute', 'universe', nil,
        {if_not_exists = true})
end)

vshard.router.cfg({
    bucket_count = common.bucket_count,
    sharding = common.sharding,
})
vshard.router.bootstrap({if_not_bootstrapped = true})

api = {}

local function bucket_for(id)
    return vshard.router.bucket_id_mpcrc32(id)
end

function api.bucket_id(id)
    return bucket_for(id)
end

function api.user_create(user)
    user.bucket_id = bucket_for(user.id)
    user.created_at = user.created_at or os.time()
    return vshard.router.callrw(user.bucket_id, 'storage_api.user_create', {user})
end

function api.user_get(id)
    local bucket_id = bucket_for(id)
    return vshard.router.callro(bucket_id, 'storage_api.user_get', {bucket_id, id})
end

function api.user_update(id, changes)
    local bucket_id = bucket_for(id)
    return vshard.router.callrw(bucket_id, 'storage_api.user_update', {bucket_id, id, changes})
end

function api.user_delete(id)
    local bucket_id = bucket_for(id)
    return vshard.router.callrw(bucket_id, 'storage_api.user_delete', {bucket_id, id})
end

function api.users_by_age(id_in_bucket, minimum_age, limit)
    local bucket_id = bucket_for(id_in_bucket)
    return vshard.router.callro(bucket_id, 'storage_api.users_by_age',
        {bucket_id, minimum_age, limit})
end

local function sorted_replicasets()
    local result = {}
    for uuid, replicaset in pairs(vshard.router.routeall()) do
        table.insert(result, {uuid = uuid, replicaset = replicaset})
    end
    table.sort(result, function(left, right) return left.uuid < right.uuid end)
    return result
end

local function decode_cursor(cursor, replicasets)
    if cursor == nil or cursor == box.NULL or cursor == '' then return 1, nil end
    if type(cursor) ~= 'string' then error('invalid cursor') end
    local uuid, position = string.match(cursor, '^rs:([^|]+)|(.*)$')
    if uuid == nil then error('invalid cursor') end
    for index, entry in ipairs(replicasets) do
        if entry.uuid == uuid then
            if position == '' then position = nil end
            return index, position
        end
    end
    error('cursor references a replica set that is not in the topology')
end

local function encode_cursor(entry, position)
    return 'rs:' .. entry.uuid .. '|' .. (position or '')
end

function api.users_page(cursor, requested_limit)
    local limit = requested_limit or 20
    if type(limit) ~= 'number' or limit % 1 ~= 0 or limit < 1 or limit > 100 then
        error('limit must be an integer between 1 and 100')
    end

    local replicasets = sorted_replicasets()
    local shard_index, position = decode_cursor(cursor, replicasets)
    local items = {}
    local current_has_more = false

    while shard_index <= #replicasets and #items < limit do
        local entry = replicasets[shard_index]
        local page, err = entry.replicaset:callro('storage_api.users_fetch_page',
            {position or box.NULL, limit - #items})
        if page == nil then error(tostring(err)) end
        for _, user in ipairs(page.items) do table.insert(items, user) end

        current_has_more = page.has_more
        if current_has_more then
            position = page.position
        else
            shard_index = shard_index + 1
            position = nil
        end
    end

    local next_cursor = box.NULL
    if #items == limit and shard_index <= #replicasets then
        next_cursor = encode_cursor(replicasets[shard_index], position)
    end
    return {
        items = items,
        next_cursor = next_cursor,
        has_more = next_cursor ~= box.NULL,
    }
end

function api.transfer_age(first_id, second_id, amount)
    local first_bucket = bucket_for(first_id)
    local second_bucket = bucket_for(second_id)
    if first_bucket ~= second_bucket then error('both ids must map to the same bucket') end
    return vshard.router.callrw(first_bucket, 'storage_api.transfer_age',
        {first_bucket, first_id, second_id, amount})
end

function api.cluster_info()
    local info = vshard.router.info()
    return {bucket_count = common.bucket_count, replicasets = info.replicasets}
end

local function auth_all(model, where)
    local result = {}
    for _, replicaset in pairs(vshard.router.routeall()) do
        local rows, err = replicaset:callro('storage_api.auth_find', {model, where or {}})
        if rows == nil then error(tostring(err)) end
        for _, row in ipairs(rows) do table.insert(result, row) end
    end
    return result
end

function api.auth_create(model, data)
    if type(data.id) ~= 'string' then error('Better Auth record id must be a string') end
    local bucket_id = vshard.router.bucket_id_strcrc32(model .. ':' .. data.id)
    return vshard.router.callrw(bucket_id, 'storage_api.auth_create', {model, data, bucket_id})
end

function api.auth_find_many(model, where, limit, offset, sort_by)
    local rows = auth_all(model, where)
    if sort_by ~= nil then
        table.sort(rows, function(left, right)
            if sort_by.direction == 'desc' then return left[sort_by.field] > right[sort_by.field] end
            return left[sort_by.field] < right[sort_by.field]
        end)
    end
    local result, start = {}, (offset or 0) + 1
    for index = start, math.min(#rows, start + (limit or 100) - 1) do
        table.insert(result, rows[index])
    end
    return result
end

function api.auth_count(model, where) return #auth_all(model, where) end

local function auth_mutate_one(model, where, changes, consume, increments)
    for _, replicaset in pairs(vshard.router.routeall()) do
        local row, err = replicaset:callrw('storage_api.auth_update_one',
            {model, where, changes or {}, consume or false, increments or {}})
        if err ~= nil then error(tostring(err)) end
        if row ~= nil then return row end
    end
    return nil
end

function api.auth_update(model, where, changes)
    return auth_mutate_one(model, where, changes, false, {})
end
function api.auth_consume(model, where)
    return auth_mutate_one(model, where, {}, true, {})
end
function api.auth_increment(model, where, increments, changes)
    return auth_mutate_one(model, where, changes or {}, false, increments)
end
function api.auth_delete(model, where)
    auth_mutate_one(model, where, {}, true, {})
    return true
end
function api.auth_update_many(model, where, changes, remove)
    local count = 0
    for _, replicaset in pairs(vshard.router.routeall()) do
        local changed, err = replicaset:callrw('storage_api.auth_update_many',
            {model, where, changes or {}, remove or false})
        if changed == nil then error(tostring(err)) end
        count = count + changed
    end
    return count
end

box.schema.func.create('api.bucket_id', {if_not_exists = true})
box.schema.func.create('api.user_create', {if_not_exists = true})
box.schema.func.create('api.user_get', {if_not_exists = true})
box.schema.func.create('api.user_update', {if_not_exists = true})
box.schema.func.create('api.user_delete', {if_not_exists = true})
box.schema.func.create('api.users_by_age', {if_not_exists = true})
box.schema.func.create('api.users_page', {if_not_exists = true})
box.schema.func.create('api.transfer_age', {if_not_exists = true})
box.schema.func.create('api.cluster_info', {if_not_exists = true})
box.schema.func.create('api.auth_create', {if_not_exists = true})
box.schema.func.create('api.auth_find_many', {if_not_exists = true})
box.schema.func.create('api.auth_count', {if_not_exists = true})
box.schema.func.create('api.auth_update', {if_not_exists = true})
box.schema.func.create('api.auth_consume', {if_not_exists = true})
box.schema.func.create('api.auth_increment', {if_not_exists = true})
box.schema.func.create('api.auth_delete', {if_not_exists = true})
box.schema.func.create('api.auth_update_many', {if_not_exists = true})
