-- Keep vshard global: its registered remote procedures are resolved by names
-- such as "vshard.storage.bucket_stat" through Tarantool's global namespace.
vshard = require('vshard')
local common = require('config')

local instance_uuid = assert(os.getenv('INSTANCE_UUID'), 'INSTANCE_UUID is required')
local replicaset_uuid = assert(os.getenv('REPLICASET_UUID'), 'REPLICASET_UUID is required')

local cfg = {
    listen = os.getenv('LISTEN') or '0.0.0.0:3301',
    instance_uuid = instance_uuid,
    replicaset_uuid = replicaset_uuid,
    bucket_count = common.bucket_count,
    sharding = common.sharding,
    memtx_memory = 128 * 1024 * 1024,
    wal_mode = 'write',
    work_dir = '/var/lib/tarantool',
}

vshard.storage.cfg(cfg, instance_uuid)

box.once('schema-v1', function()
    box.schema.user.create('storage', {password = 'storage-secret', if_not_exists = true})
    box.schema.user.grant('storage', 'read,write,execute', 'universe', nil,
        {if_not_exists = true})

    local users = box.schema.space.create('users', {
        if_not_exists = true,
        engine = 'memtx',
        format = {
            {name = 'id', type = 'unsigned'},
            {name = 'bucket_id', type = 'unsigned'},
            {name = 'email', type = 'string'},
            {name = 'name', type = 'string'},
            {name = 'age', type = 'unsigned'},
            {name = 'created_at', type = 'unsigned'},
        },
    })
    users:create_index('primary', {parts = {{field = 'id', type = 'unsigned'}}, if_not_exists = true})
    users:create_index('bucket_id', {parts = {{field = 'bucket_id', type = 'unsigned'}}, unique = false, if_not_exists = true})
    users:create_index('email', {parts = {{field = 'email', type = 'string'}}, unique = true, if_not_exists = true})
    users:create_index('age', {parts = {{field = 'age', type = 'unsigned'}}, unique = false, if_not_exists = true})
end)

box.once('better-auth-schema-v1', function()
    local records = box.schema.space.create('auth_records', {
        if_not_exists = true,
        engine = 'memtx',
        format = {
            {name = 'key', type = 'string'},
            {name = 'bucket_id', type = 'unsigned'},
            {name = 'model', type = 'string'},
            {name = 'id', type = 'string'},
            {name = 'data', type = 'map'},
        },
    })
    records:create_index('primary', {parts = {{field = 'key', type = 'string'}}, if_not_exists = true})
    records:create_index('bucket_id', {parts = {{field = 'bucket_id', type = 'unsigned'}}, unique = false, if_not_exists = true})
    records:create_index('model', {parts = {{field = 'model', type = 'string'}}, unique = false, if_not_exists = true})
end)

local function ensure_bucket(bucket_id)
    if type(bucket_id) ~= 'number' then error('bucket_id must be a number') end
end

storage_api = {}

function storage_api.user_create(user)
    ensure_bucket(user.bucket_id)
    local tuple = box.space.users:insert({
        user.id, user.bucket_id, user.email, user.name, user.age, user.created_at,
    })
    return tuple:tomap({names_only = true})
end

function storage_api.user_get(bucket_id, id)
    ensure_bucket(bucket_id)
    local tuple = box.space.users:get({id})
    if tuple == nil or tuple.bucket_id ~= bucket_id then return nil end
    return tuple:tomap({names_only = true})
end

function storage_api.user_update(bucket_id, id, changes)
    ensure_bucket(bucket_id)
    local current = box.space.users:get({id})
    if current == nil or current.bucket_id ~= bucket_id then return nil end
    local operations = {}
    if changes.name ~= nil then table.insert(operations, {'=', 'name', changes.name}) end
    if changes.age ~= nil then table.insert(operations, {'=', 'age', changes.age}) end
    if changes.email ~= nil then table.insert(operations, {'=', 'email', changes.email}) end
    if #operations == 0 then return current:tomap({names_only = true}) end
    return box.space.users:update({id}, operations):tomap({names_only = true})
end

function storage_api.user_delete(bucket_id, id)
    ensure_bucket(bucket_id)
    local current = box.space.users:get({id})
    if current == nil or current.bucket_id ~= bucket_id then return nil end
    return box.space.users:delete({id}):tomap({names_only = true})
end

function storage_api.users_by_age(bucket_id, minimum_age, limit)
    ensure_bucket(bucket_id)
    local result = {}
    for _, tuple in box.space.users.index.age:pairs({minimum_age}, {iterator = 'GE'}) do
        if tuple.bucket_id == bucket_id then
            table.insert(result, tuple:tomap({names_only = true}))
            if #result >= (limit or 20) then break end
        end
    end
    return result
end

-- Return one native Tarantool index page. `position` is the opaque base64
-- value previously returned by fetch_pos; box.NULL starts at the beginning.
function storage_api.users_fetch_page(position, limit)
    local after = position
    if after == nil or after == box.NULL or after == '' then after = box.NULL end

    local tuples, next_position = box.space.users.index.primary:select({}, {
        iterator = 'ALL',
        limit = limit,
        after = after,
        fetch_pos = true,
    })
    local items = {}
    for index, tuple in ipairs(tuples) do
        items[index] = tuple:tomap({names_only = true})
    end

    -- Probe without advancing the returned position, so an exact-size final
    -- page can still report has_more accurately.
    local has_more = false
    if next_position ~= nil then
        has_more = #box.space.users.index.primary:select({}, {
            iterator = 'ALL', limit = 1, after = next_position,
        }) > 0
    end
    return {
        items = items,
        position = next_position or box.NULL,
        has_more = has_more,
    }
end

function storage_api.transfer_age(bucket_id, first_id, second_id, amount)
    ensure_bucket(bucket_id)
    return box.atomic(function()
        local first = box.space.users:get({first_id})
        local second = box.space.users:get({second_id})
        if first == nil or second == nil then error('both users must exist') end
        if first.bucket_id ~= bucket_id or second.bucket_id ~= bucket_id then
            error('transaction cannot cross buckets')
        end
        if first.age < amount then error('age cannot become negative') end
        box.space.users:update({first_id}, {{'-', 'age', amount}})
        box.space.users:update({second_id}, {{'+', 'age', amount}})
        return {
            box.space.users:get({first_id}):tomap({names_only = true}),
            box.space.users:get({second_id}):tomap({names_only = true}),
        }
    end)
end

function storage_api.count(bucket_id)
    ensure_bucket(bucket_id)
    return box.space.users.index.bucket_id:count({bucket_id})
end

function storage_api.users_total()
    return box.space.users:len()
end

local function compare(actual, condition)
    local expected = condition.value
    local operator = condition.operator or 'eq'
    if condition.mode == 'insensitive' and type(actual) == 'string' and type(expected) == 'string' then
        actual, expected = string.lower(actual), string.lower(expected)
    end
    if operator == 'eq' then return actual == expected end
    if operator == 'ne' then return actual ~= expected end
    if operator == 'lt' then return actual ~= nil and actual < expected end
    if operator == 'lte' then return actual ~= nil and actual <= expected end
    if operator == 'gt' then return actual ~= nil and actual > expected end
    if operator == 'gte' then return actual ~= nil and actual >= expected end
    if operator == 'contains' then return type(actual) == 'string' and string.find(actual, expected, 1, true) ~= nil end
    if operator == 'starts_with' then return type(actual) == 'string' and string.sub(actual, 1, #expected) == expected end
    if operator == 'ends_with' then return type(actual) == 'string' and string.sub(actual, -#expected) == expected end
    if operator == 'in' or operator == 'not_in' then
        local found = false
        for _, value in ipairs(expected) do if actual == value then found = true break end end
        return operator == 'in' and found or not found
    end
    error('unsupported where operator: ' .. tostring(operator))
end

local function matches(data, where)
    if where == nil or #where == 0 then return true end
    local result = compare(data[where[1].field], where[1])
    for index = 2, #where do
        local condition = where[index]
        if condition.connector == 'OR' then
            result = result or compare(data[condition.field], condition)
        else
            result = result and compare(data[condition.field], condition)
        end
    end
    return result
end

function storage_api.auth_create(model, data, bucket_id)
    local key = model .. ':' .. data.id
    box.space.auth_records:insert({key, bucket_id, model, data.id, data})
    return data
end

function storage_api.auth_find(model, where)
    local result = {}
    for _, tuple in box.space.auth_records.index.model:pairs({model}, {iterator = 'EQ'}) do
        if matches(tuple.data, where) then table.insert(result, tuple.data) end
    end
    return result
end

function storage_api.auth_update_one(model, where, changes, consume, increments)
    return box.atomic(function()
        for _, tuple in box.space.auth_records.index.model:pairs({model}, {iterator = 'EQ'}) do
            if matches(tuple.data, where) then
                local data = tuple.data
                if consume then
                    box.space.auth_records:delete({tuple.key})
                    return data
                end
                for field, value in pairs(changes or {}) do data[field] = value end
                for field, delta in pairs(increments or {}) do data[field] = (data[field] or 0) + delta end
                box.space.auth_records:update({tuple.key}, {{'=', 'data', data}})
                return data
            end
        end
        return nil
    end)
end

function storage_api.auth_update_many(model, where, changes, remove)
    return box.atomic(function()
        local keys = {}
        for _, tuple in box.space.auth_records.index.model:pairs({model}, {iterator = 'EQ'}) do
            if matches(tuple.data, where) then table.insert(keys, tuple.key) end
        end
        for _, key in ipairs(keys) do
            if remove then
                box.space.auth_records:delete({key})
            else
                local tuple = box.space.auth_records:get({key})
                local data = tuple.data
                for field, value in pairs(changes or {}) do data[field] = value end
                box.space.auth_records:update({key}, {{'=', 'data', data}})
            end
        end
        return #keys
    end)
end

box.schema.func.create('storage_api.user_create', {if_not_exists = true})
box.schema.func.create('storage_api.user_get', {if_not_exists = true})
box.schema.func.create('storage_api.user_update', {if_not_exists = true})
box.schema.func.create('storage_api.user_delete', {if_not_exists = true})
box.schema.func.create('storage_api.users_by_age', {if_not_exists = true})
box.schema.func.create('storage_api.users_fetch_page', {if_not_exists = true})
box.schema.func.create('storage_api.users_total', {if_not_exists = true})
box.schema.func.create('storage_api.transfer_age', {if_not_exists = true})
box.schema.func.create('storage_api.count', {if_not_exists = true})
box.schema.func.create('storage_api.auth_create', {if_not_exists = true})
box.schema.func.create('storage_api.auth_find', {if_not_exists = true})
box.schema.func.create('storage_api.auth_update_one', {if_not_exists = true})
box.schema.func.create('storage_api.auth_update_many', {if_not_exists = true})
