-- Keep vshard global: its registered remote procedures are resolved by names
-- such as "vshard.storage.bucket_stat" through Tarantool's global namespace.
vshard = require("vshard")
local common = require("cluster_config")
local crud = require("crud")

local instance_uuid = assert(os.getenv("INSTANCE_UUID"), "INSTANCE_UUID is required")
local replicaset_uuid = assert(os.getenv("REPLICASET_UUID"), "REPLICASET_UUID is required")

local cfg = {
	listen = os.getenv("LISTEN") or "0.0.0.0:3301",
	instance_uuid = instance_uuid,
	replicaset_uuid = replicaset_uuid,
	bucket_count = common.bucket_count,
	sharding = common.sharding,
	memtx_memory = 128 * 1024 * 1024,
	wal_mode = "write",
	work_dir = "/var/lib/tarantool",
}

vshard.storage.cfg(cfg, instance_uuid)
if not box.info.ro then
	box.schema.upgrade()
end

-- CRUD preserves the authenticated router user when it invokes storage-side
-- functions. Provision the application principal on every storage so those
-- calls are authorized after routing; the storage endpoints remain private.
if not box.info.ro then
	box.once("storage-app-user-v1", function()
		box.schema.user.create("app", { password = "app-secret", if_not_exists = true })
		box.schema.user.grant("app", "read,write,execute", "universe", nil, { if_not_exists = true })
	end)
end

local function nullable(value)
	return value == nil and box.NULL or value
end

local function normalize_email(email)
	if type(email) ~= "string" then
		return nil
	end
	return string.lower(string.match(email, "^%s*(.-)%s*$"))
end

box.once("schema-v1", function()
	box.schema.user.create("storage", { password = "storage-secret", if_not_exists = true })
	box.schema.user.grant("storage", "read,write,execute", "universe", nil, { if_not_exists = true })

	local users = box.schema.space.create("users", {
		if_not_exists = true,
		engine = "memtx",
		format = {
			{ name = "id", type = "unsigned" },
			{ name = "bucket_id", type = "unsigned" },
			{ name = "email", type = "string" },
			{ name = "name", type = "string" },
			{ name = "age", type = "unsigned" },
			{ name = "created_at", type = "unsigned" },
		},
	})
	users:create_index("primary", { parts = { { field = "id", type = "unsigned" } }, if_not_exists = true })
	users:create_index(
		"bucket_id",
		{ parts = { { field = "bucket_id", type = "unsigned" } }, unique = false, if_not_exists = true }
	)
	users:create_index(
		"email",
		{ parts = { { field = "email", type = "string" } }, unique = true, if_not_exists = true }
	)
	users:create_index(
		"age",
		{ parts = { { field = "age", type = "unsigned" } }, unique = false, if_not_exists = true }
	)
end)

box.once("better-auth-schema-v1", function()
	local records = box.schema.space.create("auth_records", {
		if_not_exists = true,
		engine = "memtx",
		format = {
			{ name = "key", type = "string" },
			{ name = "bucket_id", type = "unsigned" },
			{ name = "model", type = "string" },
			{ name = "id", type = "string" },
			{ name = "data", type = "map" },
		},
	})
	records:create_index("primary", { parts = { { field = "key", type = "string" } }, if_not_exists = true })
	records:create_index(
		"bucket_id",
		{ parts = { { field = "bucket_id", type = "unsigned" } }, unique = false, if_not_exists = true }
	)
	records:create_index(
		"model",
		{ parts = { { field = "model", type = "string" } }, unique = false, if_not_exists = true }
	)
end)

box.once("better-auth-indexes-v2", function()
	box.space.auth_records:format({
		{ name = "key", type = "string" },
		{ name = "bucket_id", type = "unsigned" },
		{ name = "model", type = "string" },
		{ name = "id", type = "string" },
		{ name = "data", type = "map" },
		{ name = "email", type = "string", is_nullable = true },
		{ name = "token", type = "string", is_nullable = true },
		{ name = "userId", type = "string", is_nullable = true },
		{ name = "accountId", type = "string", is_nullable = true },
		{ name = "providerId", type = "string", is_nullable = true },
		{ name = "identifier", type = "string", is_nullable = true },
		{ name = "expiresAt", type = "scalar", is_nullable = true },
	})
	for _, tuple in box.space.auth_records.index.primary:pairs() do
		local data = tuple.data
		box.space.auth_records:replace({
			tuple.key,
			tuple.bucket_id,
			tuple.model,
			tuple.id,
			data,
			nullable(data.email),
			nullable(data.token),
			nullable(data.userId),
			nullable(data.accountId),
			nullable(data.providerId),
			nullable(data.identifier),
			nullable(data.expiresAt),
		})
	end
	for _, field in ipairs({ "email", "token", "userId", "accountId", "providerId", "identifier", "expiresAt" }) do
		box.space.auth_records:create_index("model_" .. field, {
			parts = {
				{ field = "model", type = "string" },
				{
					field = field,
					type = field == "expiresAt" and "scalar" or "string",
					is_nullable = true,
				},
				{ field = "id", type = "string" },
			},
			unique = false,
			if_not_exists = true,
		})
	end
end)

box.once("better-auth-email-index-v2", function()
	box.space.auth_records:create_index("email", {
		parts = {
			{ field = "email", type = "string" },
		},
		unique = true,
		if_not_exists = true,
	})
end)

box.once("better-auth-global-unique-indexes-v3", function()
	if box.space.auth_records.index.email ~= nil then
		box.space.auth_records.index.email:drop()
	end
	box.space.auth_records:format({
		{ name = "key", type = "string" },
		{ name = "bucket_id", type = "unsigned" },
		{ name = "model", type = "string" },
		{ name = "id", type = "string" },
		{ name = "data", type = "map" },
		{ name = "email", type = "string", is_nullable = true },
		{ name = "token", type = "string", is_nullable = true },
		{ name = "userId", type = "string", is_nullable = true },
		{ name = "accountId", type = "string", is_nullable = true },
		{ name = "providerId", type = "string", is_nullable = true },
		{ name = "identifier", type = "string", is_nullable = true },
		{ name = "expiresAt", type = "scalar", is_nullable = true },
		{ name = "normalizedEmail", type = "string", is_nullable = true },
	})
	for _, tuple in box.space.auth_records.index.primary:pairs() do
		local data = tuple.data
		box.space.auth_records:replace({
			tuple.key,
			tuple.bucket_id,
			tuple.model,
			tuple.id,
			data,
			nullable(data.email),
			nullable(data.token),
			nullable(data.userId),
			nullable(data.accountId),
			nullable(data.providerId),
			nullable(data.identifier),
			nullable(data.expiresAt),
			nullable(tuple.model == "user" and normalize_email(data.email) or nil),
		})
	end
	box.space.auth_records:create_index("unique_user_email", {
		parts = {
			{ field = "model", type = "string" },
			{ field = "normalizedEmail", type = "string", is_nullable = true, exclude_null = true },
		},
		unique = true,
		if_not_exists = true,
	})
	box.space.auth_records:create_index("unique_session_token", {
		parts = {
			{ field = "model", type = "string" },
			{ field = "token", type = "string", is_nullable = true, exclude_null = true },
		},
		unique = true,
		if_not_exists = true,
	})
	box.space.auth_records:create_index("unique_provider_account", {
		parts = {
			{ field = "model", type = "string" },
			{ field = "providerId", type = "string", is_nullable = true, exclude_null = true },
			{ field = "accountId", type = "string", is_nullable = true, exclude_null = true },
		},
		unique = true,
		if_not_exists = true,
	})
end)

box.once("better-auth-verification-created-at-v4", function()
	box.space.auth_records:format({
		{ name = "key", type = "string" },
		{ name = "bucket_id", type = "unsigned" },
		{ name = "model", type = "string" },
		{ name = "id", type = "string" },
		{ name = "data", type = "map" },
		{ name = "email", type = "string", is_nullable = true },
		{ name = "token", type = "string", is_nullable = true },
		{ name = "userId", type = "string", is_nullable = true },
		{ name = "accountId", type = "string", is_nullable = true },
		{ name = "providerId", type = "string", is_nullable = true },
		{ name = "identifier", type = "string", is_nullable = true },
		{ name = "expiresAt", type = "scalar", is_nullable = true },
		{ name = "normalizedEmail", type = "string", is_nullable = true },
		{ name = "createdAt", type = "scalar", is_nullable = true },
	})
	for _, tuple in box.space.auth_records.index.primary:pairs() do
		box.space.auth_records:update({ tuple.key }, { { "=", "createdAt", nullable(tuple.data.createdAt) } })
	end
	box.space.auth_records:create_index("verification_identifier_createdAt", {
		parts = {
			{ field = "model", type = "string" },
			{ field = "identifier", type = "string", is_nullable = true, exclude_null = true },
			{ field = "createdAt", type = "scalar", is_nullable = true, exclude_null = true },
			{ field = "id", type = "string" },
		},
		unique = true,
		if_not_exists = true,
	})
end)

local function create_email_outbox(name, engine)
	local outbox = box.schema.space.create(name, {
		if_not_exists = true,
		engine = engine,
		format = {
			{ name = "id", type = "string" },
			{ name = "bucket_id", type = "unsigned" },
			{ name = "payload", type = "map" },
			{ name = "status", type = "string" },
			{ name = "attempts", type = "unsigned" },
			{ name = "next_attempt_at", type = "unsigned" },
			{ name = "lease_owner", type = "string", is_nullable = true },
			{ name = "last_error", type = "string", is_nullable = true },
			{ name = "created_at", type = "unsigned" },
			{ name = "updated_at", type = "unsigned" },
		},
	})
	outbox:create_index("primary", {
		parts = { { field = "id", type = "string" } },
		if_not_exists = true,
	})
	outbox:create_index("bucket_id", {
		parts = { { field = "bucket_id", type = "unsigned" } },
		unique = false,
		if_not_exists = true,
	})
	outbox:create_index("due", {
		parts = {
			{ field = "status", type = "string" },
			{ field = "next_attempt_at", type = "unsigned" },
			{ field = "id", type = "string" },
		},
		unique = true,
		if_not_exists = true,
	})
	return outbox
end

box.once("email-outbox-v1", function()
	-- Queue growth during an SMTP outage must consume disk rather than the
	-- storage instance's fixed memtx arena.
	create_email_outbox("email_outbox", "vinyl")
end)

-- Early development builds briefly created v1 as memtx. Preserve any queued
-- rows while upgrading those installations to the production vinyl engine.
box.once("email-outbox-v2-vinyl", function()
	local current = box.space.email_outbox
	local replacement = box.space.email_outbox_vinyl
	if current == nil and replacement ~= nil then
		replacement:rename("email_outbox")
		return
	end
	if current == nil or current.engine == "vinyl" then
		return
	end
	replacement = create_email_outbox("email_outbox_vinyl", "vinyl")
	for _, tuple in current.index.primary:pairs() do
		replacement:replace(tuple)
	end
	current:drop()
	replacement:rename("email_outbox")
end)

box.once("users-counter-v1", function()
	local counters = box.schema.space.create("counters", {
		if_not_exists = true,
		engine = "memtx",
		format = {
			{ name = "name", type = "string" },
			{ name = "value", type = "integer" },
		},
	})
	counters:create_index("primary", {
		parts = { { field = "name", type = "string" } },
		if_not_exists = true,
	})
	-- One bounded migration scan initializes existing installations. Steady
	-- state never calls len()/count() and is safe if users later moves to vinyl.
	local total = 0
	for _ in box.space.users.index.primary:pairs() do
		total = total + 1
	end
	counters:replace({ "users", total })
end)

box.once("users-bucket-age-index-v1", function()
	box.space.users:create_index("bucket_age", {
		parts = {
			{ field = "bucket_id", type = "unsigned" },
			{ field = "age", type = "unsigned" },
			{ field = "id", type = "unsigned" },
		},
		unique = true,
		if_not_exists = true,
	})
end)

-- vshard tuple moves also execute on_replace, so each storage's O(1) counter
-- remains correct as buckets enter or leave during rebalancing.
box.space.users:on_replace(function(old, new)
	-- The master's counter mutation is replicated in the same WAL transaction;
	-- do not apply it a second time while replaying that transaction.
	if box.session.type() == "applier" then
		return
	end
	if old == nil and new ~= nil then
		box.space.counters:update({ "users" }, { { "+", "value", 1 } })
	elseif old ~= nil and new == nil then
		box.space.counters:update({ "users" }, { { "-", "value", 1 } })
	end
end)

local function ensure_bucket(bucket_id)
	if type(bucket_id) ~= "number" then
		error("bucket_id must be a number")
	end
end

storage_api = {}

function storage_api.user_create(user)
	ensure_bucket(user.bucket_id)
	return box.atomic(function()
		local tuple = box.space.users:insert({
			user.id,
			user.bucket_id,
			user.email,
			user.name,
			user.age,
			user.created_at,
		})
		return tuple:tomap({ names_only = true })
	end)
end

function storage_api.user_get(bucket_id, id)
	ensure_bucket(bucket_id)
	local tuple = box.space.users:get({ id })
	if tuple == nil or tuple.bucket_id ~= bucket_id then
		return nil
	end
	return tuple:tomap({ names_only = true })
end

function storage_api.user_update(bucket_id, id, changes)
	ensure_bucket(bucket_id)
	local current = box.space.users:get({ id })
	if current == nil or current.bucket_id ~= bucket_id then
		return nil
	end
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
		return current:tomap({ names_only = true })
	end
	return box.space.users:update({ id }, operations):tomap({ names_only = true })
end

function storage_api.user_delete(bucket_id, id)
	ensure_bucket(bucket_id)
	return box.atomic(function()
		local current = box.space.users:get({ id })
		if current == nil or current.bucket_id ~= bucket_id then
			return nil
		end
		return box.space.users:delete({ id }):tomap({ names_only = true })
	end)
end

function storage_api.users_by_age(bucket_id, minimum_age, limit)
	ensure_bucket(bucket_id)
	local result = {}
	for _, tuple in box.space.users.index.bucket_age:pairs({ bucket_id, minimum_age }, { iterator = "GE" }) do
		if tuple.bucket_id ~= bucket_id then
			break
		end
		table.insert(result, tuple:tomap({ names_only = true }))
		if #result >= (limit or 20) then
			break
		end
	end
	return result
end

function storage_api.users_page_fragment(last_id, limit)
	local tuples = box.space.users.index.primary:select({ last_id }, {
		iterator = "GT",
		limit = limit,
	})
	local items = {}
	for index, tuple in ipairs(tuples) do
		items[index] = tuple:tomap({ names_only = true })
	end
	return {
		items = items,
		total = box.space.counters:get({ "users" }).value,
	}
end

function storage_api.users_total()
	return box.space.counters:get({ "users" }).value
end

function storage_api.transfer_age(bucket_id, first_id, second_id, amount)
	ensure_bucket(bucket_id)
	return box.atomic(function()
		local first = box.space.users:get({ first_id })
		local second = box.space.users:get({ second_id })
		if first == nil or second == nil then
			error("both users must exist")
		end
		if first.bucket_id ~= bucket_id or second.bucket_id ~= bucket_id then
			error("transaction cannot cross buckets")
		end
		if first.age < amount then
			error("age cannot become negative")
		end
		box.space.users:update({ first_id }, { { "-", "age", amount } })
		box.space.users:update({ second_id }, { { "+", "age", amount } })
		return {
			box.space.users:get({ first_id }):tomap({ names_only = true }),
			box.space.users:get({ second_id }):tomap({ names_only = true }),
		}
	end)
end

function storage_api.count(bucket_id)
	ensure_bucket(bucket_id)
	return box.space.users.index.bucket_id:count({ bucket_id })
end

local function compare(actual, condition)
	local expected = condition.value
	local operator = condition.operator or "eq"
	if condition.mode == "insensitive" and type(actual) == "string" and type(expected) == "string" then
		actual, expected = string.lower(actual), string.lower(expected)
	end
	if operator == "eq" then
		return actual == expected
	end
	if operator == "ne" then
		return actual ~= expected
	end
	if operator == "lt" then
		return actual ~= nil and actual < expected
	end
	if operator == "lte" then
		return actual ~= nil and actual <= expected
	end
	if operator == "gt" then
		return actual ~= nil and actual > expected
	end
	if operator == "gte" then
		return actual ~= nil and actual >= expected
	end
	if operator == "contains" then
		return type(actual) == "string" and string.find(actual, expected, 1, true) ~= nil
	end
	if operator == "starts_with" then
		return type(actual) == "string" and string.sub(actual, 1, #expected) == expected
	end
	if operator == "ends_with" then
		return type(actual) == "string" and string.sub(actual, -#expected) == expected
	end
	if operator == "in" or operator == "not_in" then
		local found = false
		for _, value in ipairs(expected) do
			if actual == value then
				found = true
				break
			end
		end
		return operator == "in" and found or not found
	end
	error("unsupported where operator: " .. tostring(operator))
end

local function matches(model, data, where)
	if where == nil or #where == 0 then
		return true
	end
	local first = where[1]
	local first_actual = data[first.field]
	if model == "user" and first.field == "email" then
		first_actual = normalize_email(first_actual)
		first = {
			field = first.field,
			value = normalize_email(first.value),
			operator = first.operator,
			connector = first.connector,
			mode = first.mode,
		}
	end
	local result = compare(first_actual, first)
	for index = 2, #where do
		local condition = where[index]
		local actual = data[condition.field]
		if model == "user" and condition.field == "email" then
			actual = normalize_email(actual)
			condition = {
				field = condition.field,
				value = normalize_email(condition.value),
				operator = condition.operator,
				connector = condition.connector,
				mode = condition.mode,
			}
		end
		if condition.connector == "OR" then
			result = result or compare(actual, condition)
		else
			result = result and compare(actual, condition)
		end
	end
	return result
end

function storage_api.auth_create(model, data, bucket_id)
	local key = model .. ":" .. data.id
	box.space.auth_records:insert({
		key,
		bucket_id,
		model,
		data.id,
		data,
		nullable(data.email),
		nullable(data.token),
		nullable(data.userId),
		nullable(data.accountId),
		nullable(data.providerId),
		nullable(data.identifier),
		nullable(data.expiresAt),
		nullable(model == "user" and normalize_email(data.email) or nil),
		nullable(data.createdAt),
	})
	return data
end

local auth_indexes = {
	email = "unique_user_email",
	token = "unique_session_token",
	userId = "model_userId",
	accountId = "model_accountId",
	providerId = "model_providerId",
	identifier = "model_identifier",
	expiresAt = "model_expiresAt",
}

local auth_iterators = {
	eq = "EQ",
	lt = "LT",
	lte = "LE",
	gt = "GT",
	gte = "GE",
}

local function model_bounded_pairs(index, model, key, iterator)
	local gen, param, state = index:pairs(key, { iterator = iterator })
	return function(inner_param, inner_state)
		local next_state, tuple = gen(inner_param, inner_state)
		if tuple == nil or tuple.model ~= model then
			return nil
		end
		return next_state, tuple
	end,
		param,
		state
end

local function auth_scan(model, where, sort_by)
	for index, condition in ipairs(where or {}) do
		if index > 1 and condition.connector == "OR" then
			error("OR auth queries require a dedicated union query plan")
		end
	end
	if where ~= nil then
		for _, condition in ipairs(where) do
			if condition.field == "id" and (condition.operator == nil or condition.operator == "eq") then
				local tuple = box.space.auth_records:get({ model .. ":" .. condition.value })
				return function(_, state)
					if state or tuple == nil then
						return nil
					end
					return true, tuple
				end,
					nil,
					false
			end
		end
	end
	if model == "verification" and sort_by ~= nil and sort_by ~= box.NULL and sort_by.field == "createdAt" then
		for _, condition in ipairs(where or {}) do
			if condition.field == "identifier" and (condition.operator == nil or condition.operator == "eq") then
				return model_bounded_pairs(
					box.space.auth_records.index.verification_identifier_createdAt,
					model,
					{ model, condition.value },
					sort_by.direction == "desc" and "REQ" or "EQ"
				)
			end
		end
	end

	if sort_by ~= nil and sort_by ~= box.NULL and auth_indexes[sort_by.field] ~= nil then
		return model_bounded_pairs(
			box.space.auth_records.index[auth_indexes[sort_by.field]],
			model,
			{ model },
			sort_by.direction == "desc" and "REQ" or "EQ"
		)
	end
	if where ~= nil then
		for _, condition in ipairs(where) do
			local iterator = auth_iterators[condition.operator or "eq"]
			if auth_indexes[condition.field] ~= nil and iterator ~= nil then
				local value = condition.value
				if model == "user" and condition.field == "email" then
					value = normalize_email(value)
				end
				return model_bounded_pairs(
					box.space.auth_records.index[auth_indexes[condition.field]],
					model,
					{ model, value },
					iterator
				)
			end
		end
	end
	if where ~= nil and #where > 0 then
		error("auth query has no usable index")
	end
	return box.space.auth_records.index.model:pairs({ model }, { iterator = "EQ" })
end

function storage_api.auth_find(model, where, limit, sort_by)
	local result = {}
	local scanned = 0
	for _, tuple in auth_scan(model, where, sort_by) do
		if matches(model, tuple.data, where) then
			table.insert(result, tuple.data)
			if limit ~= nil and limit ~= box.NULL and #result >= limit then
				break
			end
		end
		scanned = scanned + 1
		if scanned % 1000 == 0 then
			require("fiber").yield()
		end
	end
	return result
end

function storage_api.auth_count(model, where)
	local total, scanned = 0, 0
	for _, tuple in auth_scan(model, where, box.NULL) do
		if matches(model, tuple.data, where) then
			total = total + 1
		end
		scanned = scanned + 1
		if scanned % 1000 == 0 then
			require("fiber").yield()
		end
	end
	return total
end

local function replace_auth_data(tuple, data)
	box.space.auth_records:replace({
		tuple.key,
		tuple.bucket_id,
		tuple.model,
		tuple.id,
		data,
		nullable(data.email),
		nullable(data.token),
		nullable(data.userId),
		nullable(data.accountId),
		nullable(data.providerId),
		nullable(data.identifier),
		nullable(data.expiresAt),
		nullable(tuple.model == "user" and normalize_email(data.email) or nil),
		nullable(data.createdAt),
	})
end

local function reject_shard_key_change(model, tuple, changes)
	if model == "user" and changes.email ~= nil and normalize_email(changes.email) ~= tuple.normalizedEmail then
		error("user email changes require an explicit cross-bucket migration")
	end
	if model == "session" and changes.token ~= nil and changes.token ~= tuple.token then
		error("session token is immutable")
	end
	if model == "account" then
		if changes.providerId ~= nil and changes.providerId ~= tuple.providerId then
			error("account providerId is immutable")
		end
		if changes.accountId ~= nil and changes.accountId ~= tuple.accountId then
			error("account accountId is immutable")
		end
	end
	if model == "verification" and changes.identifier ~= nil and changes.identifier ~= tuple.identifier then
		error("verification identifier is immutable")
	end
end

function storage_api.auth_update_one(model, where, changes, consume, increments)
	return box.atomic(function()
		for _, tuple in auth_scan(model, where, box.NULL) do
		if matches(model, tuple.data, where) then
				local data = tuple.data
				if consume then
					box.space.auth_records:delete({ tuple.key })
					return data
				end
				reject_shard_key_change(model, tuple, changes)
				for field, value in pairs(changes or {}) do
					data[field] = value
				end
				for field, delta in pairs(increments or {}) do
					data[field] = (data[field] or 0) + delta
				end
				replace_auth_data(tuple, data)
				return data
			end
		end
		return nil
	end)
end

function storage_api.auth_update_many(model, where, changes, remove)
	return box.atomic(function()
		local keys = {}
		for _, tuple in auth_scan(model, where, box.NULL) do
		if matches(model, tuple.data, where) then
				table.insert(keys, tuple.key)
			end
		end
		for _, key in ipairs(keys) do
			if remove then
				box.space.auth_records:delete({ key })
			else
				local tuple = box.space.auth_records:get({ key })
				reject_shard_key_change(model, tuple, changes)
				local data = tuple.data
				for field, value in pairs(changes or {}) do
					data[field] = value
				end
				replace_auth_data(tuple, data)
			end
		end
		return #keys
	end)
end

function storage_api.email_outbox_enqueue(job, bucket_id)
	return box.atomic(function()
		local existing = box.space.email_outbox:get({ job.id })
		if existing ~= nil then
			return existing.id
		end
		box.space.email_outbox:insert({
			job.id,
			bucket_id,
			job.payload,
			"pending",
			0,
			job.created_at,
			box.NULL,
			box.NULL,
			job.created_at,
			job.created_at,
		})
		return job.id
	end)
end

local function claim_due(status, owner, now, lease_until, limit, jobs)
	local ids = {}
	for _, tuple in box.space.email_outbox.index.due:pairs({ status, 0 }, { iterator = "GE" }) do
		if tuple.status ~= status or tuple.next_attempt_at > now or #jobs + #ids >= limit then
			break
		end
		table.insert(ids, tuple.id)
	end
	-- Do not mutate the indexed fields while its iterator is active: collect a
	-- bounded set of primary keys first, then lease those exact rows atomically.
	for _, id in ipairs(ids) do
		local tuple = box.space.email_outbox:get({ id })
		if tuple ~= nil and tuple.status == status and tuple.next_attempt_at <= now then
		local updated = box.space.email_outbox:update({ tuple.id }, {
			{ "=", "status", "processing" },
			{ "+", "attempts", 1 },
			{ "=", "next_attempt_at", lease_until },
			{ "=", "lease_owner", owner },
			{ "=", "updated_at", now },
		})
		table.insert(jobs, { id = updated.id, payload = updated.payload, attempts = updated.attempts })
		end
	end
end

function storage_api.email_outbox_claim(owner, now, lease_ms, limit)
	return box.atomic(function()
		local jobs = {}
		local lease_until = now + lease_ms
		-- Expired processing leases are reclaimed first, then new work. Both
		-- paths are bounded index scans and never scan the full outbox.
		claim_due("processing", owner, now, lease_until, limit, jobs)
		if #jobs < limit then
			claim_due("pending", owner, now, lease_until, limit, jobs)
		end
		return jobs
	end)
end

function storage_api.email_outbox_claim_one(id, owner, now, lease_ms)
	return box.atomic(function()
		local tuple = box.space.email_outbox:get({ id })
		if tuple == nil or (tuple.status ~= "pending" and tuple.status ~= "processing") then
			return nil
		end
		if tuple.next_attempt_at > now then
			return nil
		end
		local updated = box.space.email_outbox:update({ id }, {
			{ "=", "status", "processing" },
			{ "+", "attempts", 1 },
			{ "=", "next_attempt_at", now + lease_ms },
			{ "=", "lease_owner", owner },
			{ "=", "updated_at", now },
		})
		return { id = updated.id, payload = updated.payload, attempts = updated.attempts }
	end)
end

function storage_api.email_outbox_ack(id, owner)
	return box.atomic(function()
		local tuple = box.space.email_outbox:get({ id })
		if tuple == nil or tuple.status ~= "processing" or tuple.lease_owner ~= owner then
			return false
		end
		box.space.email_outbox:delete({ id })
		return true
	end)
end

function storage_api.email_outbox_fail(id, owner, retry_at, max_attempts, last_error, now)
	return box.atomic(function()
		local tuple = box.space.email_outbox:get({ id })
		if tuple == nil or tuple.status ~= "processing" or tuple.lease_owner ~= owner then
			return false
		end
		local status = tuple.attempts >= max_attempts and "dead" or "pending"
		box.space.email_outbox:update({ id }, {
			{ "=", "status", status },
			{ "=", "next_attempt_at", retry_at },
			{ "=", "lease_owner", box.NULL },
			{ "=", "last_error", last_error },
			{ "=", "updated_at", now },
		})
		return true
	end)
end

box.schema.func.create("storage_api.user_create", { if_not_exists = true })
box.schema.func.create("storage_api.user_get", { if_not_exists = true })
box.schema.func.create("storage_api.user_update", { if_not_exists = true })
box.schema.func.create("storage_api.user_delete", { if_not_exists = true })
box.schema.func.create("storage_api.users_by_age", { if_not_exists = true })
box.schema.func.create("storage_api.users_page_fragment", { if_not_exists = true })
box.schema.func.create("storage_api.users_total", { if_not_exists = true })
box.schema.func.create("storage_api.transfer_age", { if_not_exists = true })
box.schema.func.create("storage_api.count", { if_not_exists = true })
box.schema.func.create("storage_api.auth_create", { if_not_exists = true })
box.schema.func.create("storage_api.auth_find", { if_not_exists = true })
box.schema.func.create("storage_api.auth_count", { if_not_exists = true })
box.schema.func.create("storage_api.auth_update_one", { if_not_exists = true })
box.schema.func.create("storage_api.auth_update_many", { if_not_exists = true })
box.schema.func.create("storage_api.email_outbox_enqueue", { if_not_exists = true })
box.schema.func.create("storage_api.email_outbox_claim", { if_not_exists = true })
box.schema.func.create("storage_api.email_outbox_claim_one", { if_not_exists = true })
box.schema.func.create("storage_api.email_outbox_ack", { if_not_exists = true })
box.schema.func.create("storage_api.email_outbox_fail", { if_not_exists = true })

-- Initialize after application spaces and formats exist so CRUD can publish a
-- consistent schema and install its rebalance-safe storage procedures.
crud.init_storage({ async = false })
