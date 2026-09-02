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

local function normalize_email(email)
	if type(email) ~= "string" then
		return nil
	end
	return string.lower(string.match(email, "^%s*(.-)%s*$"))
end

local function auth_condition(where, field)
	for _, condition in ipairs(where or {}) do
		if condition.field == field and (condition.operator == nil or condition.operator == "eq") then
			return condition.value
		end
	end
	return nil
end

local function encoded_auth_bucket(id)
	if type(id) ~= "string" then
		return nil
	end
	local encoded = string.match(id, "^b(%d+)_")
	local bucket_id = tonumber(encoded)
	if bucket_id == nil or bucket_id < 1 or bucket_id > common.bucket_count then
		return nil
	end
	return bucket_id
end

local function auth_unique_bucket(model, data)
	if model == "user" then
		local email = normalize_email(data.email)
		if email == nil or email == "" then
			error("Better Auth user email is required")
		end
		return vshard.router.bucket_id_strcrc32("user-email:" .. email)
	end
	if model == "session" then
		if type(data.token) ~= "string" or data.token == "" then
			error("Better Auth session token is required")
		end
		return vshard.router.bucket_id_strcrc32("session-token:" .. data.token)
	end
	if model == "account" then
		if type(data.providerId) ~= "string" or type(data.accountId) ~= "string" then
			error("Better Auth account providerId and accountId are required")
		end
		return vshard.router.bucket_id_strcrc32("account:" .. data.providerId .. ":" .. data.accountId)
	end
	if model == "verification" then
		if type(data.identifier) ~= "string" or data.identifier == "" then
			error("Better Auth verification identifier is required")
		end
		return vshard.router.bucket_id_strcrc32("verification:" .. data.identifier)
	end
	return vshard.router.bucket_id_strcrc32(model .. ":" .. data.id)
end

local function auth_where_bucket(model, where)
	local id = auth_condition(where, "id")
	local bucket_id = encoded_auth_bucket(id)
	if bucket_id ~= nil then
		return bucket_id
	end
	if model == "user" then
		local email = normalize_email(auth_condition(where, "email"))
		if email ~= nil and email ~= "" then
			return vshard.router.bucket_id_strcrc32("user-email:" .. email)
		end
	elseif model == "session" then
		local token = auth_condition(where, "token")
		if type(token) == "string" and token ~= "" then
			return vshard.router.bucket_id_strcrc32("session-token:" .. token)
		end
	elseif model == "account" then
		local provider_id = auth_condition(where, "providerId")
		local account_id = auth_condition(where, "accountId")
		if type(provider_id) == "string" and type(account_id) == "string" then
			return vshard.router.bucket_id_strcrc32("account:" .. provider_id .. ":" .. account_id)
		end
	elseif model == "verification" then
		local identifier = auth_condition(where, "identifier")
		if type(identifier) == "string" and identifier ~= "" then
			return vshard.router.bucket_id_strcrc32("verification:" .. identifier)
		end
	end
	return nil
end

function api.auth_create(model, data)
	if type(data.id) ~= "string" then
		error("Better Auth record id must be a string")
	end
	local bucket_id = auth_unique_bucket(model, data)
	local supplied_bucket = encoded_auth_bucket(data.id)
	if supplied_bucket ~= nil and supplied_bucket ~= bucket_id then
		error("Better Auth record id belongs to a different bucket")
	end
	if supplied_bucket == nil then
		data.id = "b" .. bucket_id .. "_" .. data.id
	end
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
	local bucket_id = auth_where_bucket(model, where)
	if bucket_id ~= nil then
		local shard_rows, err = vshard.router.callro(
			bucket_id,
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
	local bucket_id = auth_where_bucket(model, where)
	if bucket_id ~= nil then
		local count, err = vshard.router.callro(
			bucket_id,
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
	local bucket_id = auth_where_bucket(model, where)
	if bucket_id ~= nil then
		local row, err = vshard.router.callrw(
			bucket_id,
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

local function email_outbox_bucket(id)
	local encoded = encoded_auth_bucket(id)
	if encoded ~= nil then
		return encoded
	end
	return vshard.router.bucket_id_strcrc32("email-outbox:" .. id)
end

function api.email_outbox_enqueue(job)
	if type(job) ~= "table" or type(job.id) ~= "string" or type(job.payload) ~= "table" then
		error("invalid email outbox job")
	end
	local bucket_id = email_outbox_bucket(job.id)
	if encoded_auth_bucket(job.id) == nil then
		job.id = "b" .. bucket_id .. "_" .. job.id
	end
	return vshard.router.callrw(
		bucket_id,
		"storage_api.email_outbox_enqueue",
		{ job, bucket_id },
		{ timeout = common.read_timeout }
	)
end

function api.email_outbox_claim(owner, now, lease_ms, limit)
	if type(owner) ~= "string" or type(now) ~= "number" or type(lease_ms) ~= "number" then
		error("invalid email outbox claim")
	end
	if type(limit) ~= "number" or limit < 1 or limit > 1000 then
		error("email outbox claim limit must be between 1 and 1000 per shard")
	end
	local jobs = {}
	for _, shard_jobs in ipairs(scatter_callrw(
		"storage_api.email_outbox_claim",
		{ owner, now, lease_ms, limit }
	)) do
		for _, job in ipairs(shard_jobs) do
			table.insert(jobs, job)
		end
	end
	return jobs
end

function api.email_outbox_ack(id, owner)
	local bucket_id = email_outbox_bucket(id)
	return vshard.router.callrw(
		bucket_id,
		"storage_api.email_outbox_ack",
		{ id, owner },
		{ timeout = common.read_timeout }
	)
end

function api.email_outbox_claim_one(id, owner, now, lease_ms)
	local bucket_id = email_outbox_bucket(id)
	return vshard.router.callrw(
		bucket_id,
		"storage_api.email_outbox_claim_one",
		{ id, owner, now, lease_ms },
		{ timeout = common.read_timeout }
	)
end

function api.email_outbox_fail(id, owner, retry_at, max_attempts, last_error, now)
	local bucket_id = email_outbox_bucket(id)
	return vshard.router.callrw(
		bucket_id,
		"storage_api.email_outbox_fail",
		{ id, owner, retry_at, max_attempts, last_error, now },
		{ timeout = common.read_timeout }
	)
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
box.schema.func.create("api.email_outbox_enqueue", { if_not_exists = true })
box.schema.func.create("api.email_outbox_claim", { if_not_exists = true })
box.schema.func.create("api.email_outbox_claim_one", { if_not_exists = true })
box.schema.func.create("api.email_outbox_ack", { if_not_exists = true })
box.schema.func.create("api.email_outbox_fail", { if_not_exists = true })
