-- Keep vshard global so registered procedures and the interactive admin
-- console can resolve expressions such as vshard.router.info().
vshard = require("vshard")
local common = require("cluster_config")
local fiber = require("fiber")
local crud = require("crud")

box.cfg({
	listen = os.getenv("LISTEN") or "0.0.0.0:3301",
	memtx_memory = 64 * 1024 * 1024,
	wal_mode = "write",
	work_dir = "/var/lib/tarantool",
})
box.schema.upgrade()

box.once("router-users-v1", function()
	box.schema.user.create("app", { password = "app-secret", if_not_exists = true })
	box.schema.user.grant("app", "read,write,execute", "universe", nil, { if_not_exists = true })
end)

vshard.router.cfg({
	bucket_count = common.bucket_count,
	sharding = common.sharding,
})
vshard.router.bootstrap({ if_not_bootstrapped = true })
crud.init_router()

api = {}

local function bucket_for(id)
	-- vshard 0.1.42 requires the sharding key to be an array, even when the
	-- key contains a single field.
	return vshard.router.bucket_id_mpcrc32({ id })
end

local function first_crud_object(result)
	local row = result ~= nil and result.rows ~= nil and result.rows[1] or nil
	if row == nil then
		return box.NULL
	end
	local object = {}
	for field_no, field in ipairs(result.metadata or {}) do
		object[field.name] = row[field_no]
	end
	return object
end

local function crud_objects(result)
	local objects = {}
	for _, row in ipairs(result.rows or {}) do
		local object = {}
		for field_no, field in ipairs(result.metadata or {}) do
			object[field.name] = row[field_no]
		end
		table.insert(objects, object)
	end
	return objects
end

function api.bucket_id(id)
	return bucket_for(id)
end

function api.user_create(user)
	user.bucket_id = bucket_for(user.id)
	user.created_at = user.created_at or os.time()
	local result, err = crud.insert_object("users", user, {
		bucket_id = user.bucket_id,
		timeout = common.read_timeout,
	})
	if err ~= nil then
		error(tostring(err))
	end
	return first_crud_object(result)
end

function api.user_get(id)
	local bucket_id = bucket_for(id)
	local result, err = crud.get("users", { id }, {
		bucket_id = bucket_id,
		timeout = common.read_timeout,
		mode = "read",
		prefer_replica = true,
		balance = true,
	})
	if err ~= nil then
		error(tostring(err))
	end
	return first_crud_object(result)
end

function api.user_update(id, changes)
	local bucket_id = bucket_for(id)
	local operations = {}
	if changes.name ~= nil then
		table.insert(operations, { "=", "name", changes.name })
	end
	if changes.age ~= nil then
		table.insert(operations, { "=", "age", changes.age })
	end
	if changes.email ~= nil then
		table.insert(operations, { "=", "email", changes.email })
	end
	if #operations == 0 then
		return api.user_get(id)
	end
	local result, err = crud.update("users", { id }, operations, {
		bucket_id = bucket_id,
		timeout = common.read_timeout,
	})
	if err ~= nil then
		error(tostring(err))
	end
	return first_crud_object(result)
end

function api.user_delete(id)
	local bucket_id = bucket_for(id)
	local result, err = crud.delete("users", { id }, {
		bucket_id = bucket_id,
		timeout = common.read_timeout,
	})
	if err ~= nil then
		error(tostring(err))
	end
	return first_crud_object(result)
end

function api.users_by_age(id_in_bucket, minimum_age, limit)
	local bucket_id = bucket_for(id_in_bucket)
	return vshard.router.callro(bucket_id, "storage_api.users_by_age", { bucket_id, minimum_age, limit })
end

local function replicasets()
	local result = {}
	local routes, err = vshard.router.routeall()
	if routes == nil then
		error(tostring(err))
	end
	for _, replicaset in pairs(routes) do
		table.insert(result, replicaset)
	end
	if #result == 0 then
		error("no replica sets are configured")
	end
	return result
end

local function decode_cursor(cursor)
	if cursor == nil or cursor == box.NULL or cursor == "" then
		return 0, 1
	end
	if type(cursor) ~= "string" then
		error("invalid cursor")
	end
	local page_number, last_id = string.match(cursor, "^v1:(%d+):(%d+)$")
	if page_number == nil then
		error("invalid cursor")
	end
	return tonumber(last_id), tonumber(page_number)
end

local function scatter_call(mode, function_name, arguments)
	local targets = replicasets()
	local channel = fiber.channel(#targets)
	for _, target in ipairs(targets) do
		local replicaset = target
		fiber.create(function()
			-- replicaset:callro chooses the nearest node using vshard zone
			-- weights. All shards execute concurrently, bounding latency to
			-- the slowest local call rather than the sum of every call.
			local call = mode == "write" and replicaset.callrw or replicaset.callro
			local ok, result, err = pcall(call, replicaset, function_name, arguments, { timeout = common.read_timeout })
			if not ok then
				err, result = result, nil
			end
			channel:put({ success = ok and err == nil, result = result, err = err })
		end)
	end

	local results = {}
	for _ = 1, #targets do
		local response = channel:get(common.read_timeout + 0.1)
		if response == nil then
			error("scatter-gather read timed out")
		end
		if not response.success then
			error(tostring(response.err))
		end
		table.insert(results, response.result == nil and box.NULL or response.result)
	end
	return results
end

local function scatter_callro(function_name, arguments)
	return scatter_call("read", function_name, arguments)
end

local function scatter_callrw(function_name, arguments)
	return scatter_call("write", function_name, arguments)
end

function api.users_page(cursor, requested_limit)
	local limit = requested_limit or 20
	if type(limit) ~= "number" or limit % 1 ~= 0 or limit < 1 or limit > 100 then
		error("limit must be an integer between 1 and 100")
	end

	local last_id, current_page = decode_cursor(cursor)
	local selected, select_err = crud.select("users", { { ">", "id", last_id } }, {
		first = limit + 1,
		timeout = common.read_timeout,
		request_timeout = common.read_timeout,
		mode = "read",
		prefer_replica = true,
		balance = true,
		yield_every = 1000,
	})
	if select_err ~= nil then
		error(tostring(select_err))
	end

	local merged = crud_objects(selected)
	local total = 0
	for _, count in ipairs(scatter_callro("storage_api.users_total", {})) do
		total = total + count
	end

	local has_more = #merged > limit
	while #merged > limit do
		table.remove(merged)
	end
	local next_cursor = box.NULL
	if has_more then
		next_cursor = "v1:" .. (current_page + 1) .. ":" .. merged[#merged].id
	end

	local total_pages = math.ceil(total / limit)
	return {
		items = merged,
		next_cursor = next_cursor,
		has_more = has_more,
		totalPage = total_pages,
		currentPage = current_page,
	}
end

function api.transfer_age(first_id, second_id, amount)
	local first_bucket = bucket_for(first_id)
	local second_bucket = bucket_for(second_id)
	if first_bucket ~= second_bucket then
		error("both ids must map to the same bucket")
	end
	return vshard.router.callrw(first_bucket, "storage_api.transfer_age", { first_bucket, first_id, second_id, amount })
end

function api.cluster_info()
	local info = vshard.router.info()
	return { bucket_count = common.bucket_count, replicasets = info.replicasets }
end

local function auth_id(where)
	for _, condition in ipairs(where or {}) do
		if condition.field == "id" and (condition.operator == nil or condition.operator == "eq") then
			return condition.value
		end
	end
	return nil
end

local function auth_bucket(model, id)
	return vshard.router.bucket_id_strcrc32(model .. ":" .. id)
end

function api.auth_create(model, data)
	if type(data.id) ~= "string" then
		error("Better Auth record id must be a string")
	end
	local bucket_id = auth_bucket(model, data.id)
	return vshard.router.callrw(bucket_id, "storage_api.auth_create", { model, data, bucket_id })
end

function api.auth_find_many(model, where, limit, offset, sort_by)
	if sort_by == box.NULL then
		sort_by = nil
	end
	local requested = limit or 100
	local skipped = offset or 0
	if type(requested) ~= "number" or requested < 1 or requested > 1000 then
		error("auth query limit must be between 1 and 1000")
	end
	if type(skipped) ~= "number" or skipped < 0 or skipped > 10000 then
		error("auth query offset must be between 0 and 10000")
	end
	local rows = {}
	local id = auth_id(where)
	if id ~= nil then
		local shard_rows, err = vshard.router.callro(
			auth_bucket(model, id),
			"storage_api.auth_find",
			{ model, where or {}, requested + skipped, sort_by or box.NULL },
			{ timeout = common.read_timeout }
		)
		if shard_rows == nil then
			error(tostring(err))
		end
		rows = shard_rows
	else
		for _, shard_rows in
			ipairs(
				scatter_callro(
					"storage_api.auth_find",
					{ model, where or {}, requested + skipped, sort_by or box.NULL }
				)
			)
		do
			for _, row in ipairs(shard_rows) do
				table.insert(rows, row)
			end
		end
	end
	if sort_by ~= nil then
		table.sort(rows, function(left, right)
			if left[sort_by.field] == right[sort_by.field] then
				return left.id < right.id
			end
			if left[sort_by.field] == nil or left[sort_by.field] == box.NULL then
				return false
			end
			if right[sort_by.field] == nil or right[sort_by.field] == box.NULL then
				return true
			end
			if sort_by.direction == "desc" then
				return left[sort_by.field] > right[sort_by.field]
			end
			return left[sort_by.field] < right[sort_by.field]
		end)
	end
	local result, start = {}, skipped + 1
	for index = start, math.min(#rows, start + requested - 1) do
		table.insert(result, rows[index])
	end
	return result
end

function api.auth_count(model, where)
	local id = auth_id(where)
	if id ~= nil then
		local count, err = vshard.router.callro(
			auth_bucket(model, id),
			"storage_api.auth_count",
			{ model, where or {} },
			{ timeout = common.read_timeout }
		)
		if count == nil then
			error(tostring(err))
		end
		return count
	end
	local total = 0
	for _, count in ipairs(scatter_callro("storage_api.auth_count", { model, where or {} })) do
		total = total + count
	end
	return total
end

local function auth_mutate_one(model, where, changes, consume, increments)
	local id = auth_id(where)
	if id ~= nil then
		local row, err = vshard.router.callrw(
			auth_bucket(model, id),
			"storage_api.auth_update_one",
			{ model, where, changes or {}, consume or false, increments or {} },
			{ timeout = common.read_timeout }
		)
		if err ~= nil then
			error(tostring(err))
		end
		return row
	end
	local found = nil
	for _, row in
		ipairs(
			scatter_callrw(
				"storage_api.auth_update_one",
				{ model, where, changes or {}, consume or false, increments or {} }
			)
		)
	do
		if row ~= nil and row ~= box.NULL then
			if found ~= nil then
				error("auth uniqueness violation across shards")
			end
			found = row
		end
	end
	return found
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
	for _, changed in
		ipairs(scatter_callrw("storage_api.auth_update_many", { model, where, changes or {}, remove or false }))
	do
		count = count + changed
	end
	return count
end

box.schema.func.create("api.bucket_id", { if_not_exists = true })
box.schema.func.create("api.user_create", { if_not_exists = true })
box.schema.func.create("api.user_get", { if_not_exists = true })
box.schema.func.create("api.user_update", { if_not_exists = true })
box.schema.func.create("api.user_delete", { if_not_exists = true })
box.schema.func.create("api.users_by_age", { if_not_exists = true })
box.schema.func.create("api.users_page", { if_not_exists = true })
box.schema.func.create("api.transfer_age", { if_not_exists = true })
box.schema.func.create("api.cluster_info", { if_not_exists = true })
box.schema.func.create("api.auth_create", { if_not_exists = true })
box.schema.func.create("api.auth_find_many", { if_not_exists = true })
box.schema.func.create("api.auth_count", { if_not_exists = true })
box.schema.func.create("api.auth_update", { if_not_exists = true })
box.schema.func.create("api.auth_consume", { if_not_exists = true })
box.schema.func.create("api.auth_increment", { if_not_exists = true })
box.schema.func.create("api.auth_delete", { if_not_exists = true })
box.schema.func.create("api.auth_update_many", { if_not_exists = true })
