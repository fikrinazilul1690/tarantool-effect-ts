# Sharding Related Spaces with vshard

Choose a sharding key from the aggregate that owns each record. Related data
should share a bucket when it must be read or changed atomically, but an entire
relationship graph should not be forced into one bucket.

vshard guarantees that tuples with the same `bucket_id` are stored on the same
replica set. During rebalancing, it moves tuples with that bucket ID from every
participating sharded space. Each such space must contain a non-null bucket
field and a non-unique TREE `bucket_id` index. See the official
[vshard schema and routing guide](https://github.com/tarantool/vshard#defining-schema).

## Recommended ownership model

For users, personal posts, organizations, and memberships, use these ownership
boundaries:

| Space | Sharding key | Canonical purpose |
| --- | --- | --- |
| `users` | `user_id` | User aggregate root |
| `posts` | `user_id` | Personal posts owned by a user |
| `organizations` | `organization_id` | Organization aggregate root |
| `organization_members` | `organization_id` | Canonical membership and authorization data |
| `user_organizations` | `user_id` | User-facing membership projection |

Do not calculate a personal post bucket from `[user_id, organization_id]`.
Personal posts have no organization owner, a user may join several
organizations, and membership changes must not change a post's sharding key.

## Stable bucket functions

Use exactly the same canonical input and hashing function for every record in
one aggregate:

```lua
---@param user_id integer
---@return integer
local function user_bucket_id(user_id)
	return vshard.router.bucket_id_mpcrc32({ user_id })
end

---@param organization_id string
---@return integer
local function organization_bucket_id(organization_id)
	return vshard.router.bucket_id_mpcrc32({ "organization:" .. organization_id })
end
```

If existing users use `{ user_id }`, personal posts must also use `{ user_id }`.
Hashing `{ "user:" .. user_id }` for posts would produce a different result
and break co-location. The organization prefix creates a stable key namespace;
it does not make a bucket ID unique. Hash collisions between unrelated owners
are expected and safe.

A bucket ID is routing metadata, not an identity or uniqueness guarantee. Every
lookup must still check the logical owner and record key.

## Personal posts schema

A personal post belongs to the user aggregate:

```lua
box.once("posts-schema-v1", function()
	local posts = box.schema.space.create("posts", {
		if_not_exists = true,
		format = {
			{ name = "id", type = "string" },
			{ name = "bucket_id", type = "unsigned" },
			{ name = "user_id", type = "unsigned" },
			{ name = "title", type = "string" },
			{ name = "created_at", type = "unsigned" },
		},
	})

	posts:create_index("primary", {
		parts = {
			{ field = "user_id", type = "unsigned" },
			{ field = "id", type = "string" },
		},
		unique = true,
		if_not_exists = true,
	})
	posts:create_index("bucket_id", {
		parts = { { field = "bucket_id", type = "unsigned" } },
		unique = false,
		if_not_exists = true,
	})
	posts:create_index("by_user_created", {
		parts = {
			{ field = "user_id", type = "unsigned" },
			{ field = "created_at", type = "unsigned" },
			{ field = "id", type = "string" },
		},
		unique = true,
		if_not_exists = true,
	})
end)
```

The compound primary key enforces post-ID uniqueness within one user. It does
not enforce cluster-wide uniqueness for `post.id` by itself. Use globally
generated IDs or a separate uniqueness design if the ID must be unique across
all users.

Because a post is routed by its owner, point APIs should accept both identifiers:

```text
get_post(user_id, post_id)
delete_post(user_id, post_id)
```

`post_id` alone cannot determine the correct bucket without another directory
or lookup service.

## Atomic user and post operations

Calculate the bucket at the router and make one write call:

```lua
---@param user_id integer
---@param post table<string, unknown>
function api.post_create(user_id, post)
	local bucket_id = user_bucket_id(user_id)
	return vshard.router.callrw(bucket_id, "storage_api.post_create", {
		bucket_id,
		user_id,
		post,
	})
end
```

Validate ownership and mutate both spaces inside one storage transaction:

```lua
---@param bucket_id integer
---@param user_id integer
---@param post table<string, unknown>
function storage_api.post_create(bucket_id, user_id, post)
	ensure_bucket(bucket_id)
	return box.atomic(function()
		local user = box.space.users:get({ user_id })
		if user == nil or user.bucket_id ~= bucket_id then
			error("user not found")
		end

		return box.space.posts:insert({
			post.id,
			bucket_id,
			user_id,
			post.title,
			post.created_at,
		})
	end)
end
```

This transaction is local and atomic because both records use the user bucket.
A vshard request should modify only records belonging to its routed bucket.

## Organizations and membership

An organization and its canonical membership records use the organization
bucket. This supports single-shard operations such as:

- creating an organization and its initial owner membership;
- checking `[organization_id, user_id]` authorization;
- changing a member's role;
- listing an organization's members.

Authorization does not need to load the user tuple. The authenticated identity
provides `user_id`, and the router checks the canonical membership on the
organization bucket:

```lua
---@param organization_id string
---@param user_id integer
function api.organization_member_get(organization_id, user_id)
	local bucket_id = organization_bucket_id(organization_id)
	return vshard.router.callrw(bucket_id, "storage_api.organization_member_get", {
		bucket_id,
		organization_id,
		user_id,
	})
end
```

`callrw` is intentional even though the procedure only reads: it routes the
authorization check to the master so a recently revoked membership is not
accepted because of replica lag. Use `callro` only when the authorization policy
explicitly permits bounded stale reads.

One membership cannot be co-located with both its user and organization unless
those aggregates happen to hash to the same bucket. Make
`organization_members` canonical, then maintain `user_organizations` as a
user-bucket projection for efficient "my organizations" queries.

## Cross-bucket membership workflow

Creating a canonical organization membership and its user projection is not a
single Tarantool transaction. Use an outbox-driven, idempotent workflow:

1. On the organization bucket, update `organization_members` and insert an
   outbox event in the same `box.atomic` transaction.
2. Commit before acknowledging success.
3. A durable worker consumes the event and upserts `user_organizations` on the
   user bucket.
4. Record an event ID or monotonically increasing membership version so replay
   is harmless and older events cannot overwrite newer state.
5. Retry only the idempotent projection operation. Never replay an ambiguous
   canonical write.
6. Reconcile the projection periodically from canonical membership records.

The projection is eventually consistent. Authorization must continue to read
the canonical organization-side record rather than trusting a possibly stale
user-side projection.

User deletion has the same boundary: mark the user deleted locally, emit a
durable event, and clean memberships asynchronously. Do not attempt one large
transaction spanning every organization bucket.

## Organization-owned posts

If posts later support organization ownership, model ownership explicitly:

```text
owner_type = "user" | "organization"
owner_id
```

Route a personal post with the existing user sharding key and an organization
post with the organization sharding key. Do not use a nullable
`organization_id` to silently change routing rules. The router should derive
the bucket from an explicit owner type and reject unsupported combinations.

## Hot-owner tradeoff

Co-location improves transactions and owner-scoped queries, but a bucket is the
smallest vshard rebalancing unit. One user or organization with a very large or
hot dataset cannot be split across storage replica sets while all its records
retain one bucket ID.

For potentially unbounded owners, partition only the high-volume child data:

```text
post_bucket = hash(["user-posts", user_id, partition_number])
```

This sacrifices single-bucket transactions and requires the application to
merge partitions. Keep the user profile and small transactional metadata in the
original user bucket, and introduce partitioning only when measured load or
size justifies the added complexity.

## Review checklist

- The sharding key represents stable ownership and never changes with a role or
  membership update.
- Every related space that participates in vshard has a non-null `bucket_id`
  and non-unique TREE index.
- Router and storage recompute or validate the same canonical bucket ID.
- Local `box.atomic` transactions touch only tuples belonging to the routed
  bucket.
- Point APIs include enough ownership information to route without scatter.
- Unique constraints are evaluated in the correct logical ownership domain.
- Cross-bucket projections use transactional outboxes, idempotency, ordering,
  retries, and reconciliation.
- Authorization reads canonical membership data.
- Rebalancing tests prove all related tuples move together.
- Load tests check for hot or oversized owner buckets before production.
