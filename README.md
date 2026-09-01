# Learn Tarantool with vshard, Bun, and TypeScript

This is a runnable learning project, not a production cluster. It contains one
stateless vshard router and two independent storage replica sets (one instance
each). The Bun application connects only to the router on port `3301`.

```text
Bun/TypeScript -> router :3301 -> bucket -> storage-1 :3302
                                    `-----> storage-2 :3303
Community UI :8000 ------------------------^       ^
```

vshard divides the keyspace into 3,000 virtual buckets. The router hashes a
user ID to a bucket, discovers which replica set owns that bucket, and calls a
Lua stored function on that storage. Adding many virtual buckets makes later
rebalancing much finer-grained than sharding directly by physical server.

## Prerequisites

- Docker with Compose v2
- [Bun](https://bun.sh/) 1.x

The project pins Tarantool 2.11.8 because its classic Lua application model is
small and especially good for learning vshard. The binary protocol remains
compatible with Tarantool 3.x. The Node connector is community-supported, so
`src/db.ts` deliberately keeps it behind a tiny typed adapter.

## Start here

```bash
bun install
make start
bun run start
make api
bun run example:all
bun test
```

The selected official image includes the vshard rock. The first image download can take a few minutes.
Follow startup with `docker compose logs -f`. Stop the cluster with
`docker compose down`.

To erase the learning database and bootstrap fresh:

```bash
make reset
make up
```

`make reset` permanently removes only this project's `./data` directory.

## Community web UI

The Compose stack includes the open-source
[Basis Company Tarantool Admin](https://github.com/basis-company/tarantool-admin).
Open [http://localhost:8000](http://localhost:8000) after `make start`, or run
`make ui` to print the connection details.

Add these connections in the UI. These are Docker-network hostnames, because
the UI backend runs inside Compose:

| Name | Host | Port | User | Password |
| --- | --- | --- | --- | --- |
| Router | `router` | `3301` | `app` | `app-secret` |
| Storage 1 | `storage-1` | `3301` | `storage` | `storage-secret` |
| Storage 2 | `storage-2` | `3301` | `storage` | `storage-secret` |

Use the router connection for vshard status and routed function calls. Use the
storage connections to inspect the physical `users` and `_bucket` spaces on
each shard. The UI is a development/admin tool and is intentionally bound to a
host port here; do not expose it publicly without authentication and a secure
reverse proxy.

## Lessons and examples

| Command | What it demonstrates |
| --- | --- |
| `bun run start` | connection, authentication, ping, cluster information |
| `bun run example:crud` | create, point read, update, delete, missing tuple |
| `bun run example:indexes` | TREE secondary index and range iteration |
| `bun run example:transactions` | `box.atomic`, rollback, same-bucket constraint |
| `bun run example:sharding` | deterministic bucket IDs and replica-set routing |
| `bun run example:pagination` | global cursor pagination merged across shards |
| `bun test` | an end-to-end typed CRUD smoke test |
| `bun run typecheck` | strict TypeScript checking without running anything |

Read these files in order:

1. `tarantool/config.lua` — bucket count and topology.
2. `tarantool/storage.lua` — schema, indexes, CRUD, and transaction logic.
3. `tarantool/router.lua` — sharding key calculation and `callro`/`callrw`.
4. `src/db.ts` — `TarantoolDb` Effect service and scoped live layer.
5. `src/auth/tarantool-adapter.ts` — Better Auth database adapter.
6. `src/server.ts` — Effect v4 routes, BunHttpServer layer, and BunRuntime.
7. `examples/` — application usage from TypeScript.

## Effect v4 HTTP API and Better Auth

Install dependencies and start both layers:

```bash
bun install
make start
make api
```

The API listens on `http://localhost:3000`:

| Route | Purpose |
| --- | --- |
| `GET /health` | Effect server health check |
| `GET /openapi.json` | OpenAPI 3.1 generated from Effect schemas |
| `GET /api/users?limit=20&cursor=...` | Bearer-protected user objects with a `fetch_pos` cursor |
| `/api/auth/*` | Better Auth endpoints |

Public Effect API responses use a consistent envelope:

```json
{"success": true, "data": {}}
```

Errors include a stable machine-readable code:

```json
{"success": false, "error": {"code": "UNAUTHORIZED", "message": "..."}}
```

The Better Auth bearer plugin exposes `set-auth-token` on sign-up and sign-in.
Use either that signed value or the returned JSON `token` to access protected
application endpoints:

```bash
curl -H 'Authorization: Bearer YOUR_TOKEN' \
  'http://localhost:3000/api/users?limit=20'
```

### Postman

Import both files into Postman and select the **Learn Tarantool - Local**
environment:

- `postman/Learn-Tarantool.postman_collection.json`
- `postman/Local.postman_environment.json`

The collection contains health, OpenAPI, first/next user page, sign-up, sign-in,
current-session, and sign-out requests. Run **List Users - First Page** before
**List Users - Next Page** so its test script saves `next_cursor`. First run
**Sign Up with Email** or **Sign In with Email** to save `sessionToken`; user
requests send it as a bearer token. Postman's cookie jar also retains the
Better Auth session cookie. Clear the collection's `authEmail` variable to
generate a new unique account on the next sign-up.

Create an account and retain the session cookie:

```bash
curl -c /tmp/auth-cookies.txt \
  -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.com","password":"secure-password-123"}' \
  http://localhost:3000/api/auth/sign-up/email

curl -b /tmp/auth-cookies.txt http://localhost:3000/api/auth/get-session
```

Sign in later with `POST /api/auth/sign-in/email` using the same `email` and
`password` fields. Set `AUTH_DEBUG=true` when troubleshooting adapter calls.

The custom adapter stores Better Auth's `user`, `session`, `account`, and
verification models as maps in the `auth_records` space. Records are sharded
by the stable hash of `model:id`; queries without an ID fan out through the
router. The learning adapter implements create, find, count, update, delete,
atomic consume, and atomic increment operations. It does not provide global
unique indexes or cross-shard transactions, so add dedicated unique lookup
spaces and production-grade replica sets before using this design in a real
authentication system.

The application is assembled as an Effect layer graph. `TarantoolDbLive`
acquires one connection when the application scope starts and disconnects it
during graceful shutdown. `BetterAuthLive` depends on that database service,
and the HTTP routes depend on both services. `BunHttpServer.layer` owns the
listener while `BunRuntime.runMain` handles execution, SIGINT, and SIGTERM.
Better Auth requires Promise-returning adapter methods, so `Effect.runPromise`
is used only at that external interface boundary.

## Data model

The `users` space stores tuples in this order:

```text
[id, bucket_id, email, name, age, created_at]
```

Its indexes are:

- `primary`: unique TREE index on `id`
- `bucket_id`: non-unique TREE index required by vshard
- `email`: unique TREE secondary index
- `age`: non-unique TREE secondary index for range queries

Every sharded tuple must contain its bucket ID. Do not connect to a storage and
insert a tuple directly from an application: doing that bypasses routing and
can put data on the wrong shard.

## Typed application usage

```ts
import {BunRuntime} from '@effect/platform-bun';
import {Effect} from 'effect';
import {TarantoolDb, TarantoolDbLive} from './src/db';
import type {User} from './src/types';

const program = Effect.gen(function*() {
  const db = yield* TarantoolDb;
  const user = yield* db.call<User>('api.user_create', {
    id: 101,
    email: 'grace@example.com',
    name: 'Grace',
    age: 35,
  });

  const readBack = yield* db.call<User | null>('api.user_get', user.id);
  yield* Effect.log(readBack);
}).pipe(Effect.provide(TarantoolDbLive));

BunRuntime.runMain(program);
```

### Cursor-based list API

`api.users_page(cursor, limit)` lists users across every shard. Replica sets are
visited in stable UUID order, and users within each shard are in ascending ID
order. The first cursor is `null`; pass `next_cursor` unchanged to the next
request. Limits must be between 1 and 100.

```ts
const first = yield* db.call<CursorPage<User>>('api.users_page', null, 25);
const next = first.next_cursor === null
  ? null
  : yield* db.call<CursorPage<User>>('api.users_page', first.next_cursor, 25);

console.table(first.items); // complete user objects, not only IDs
```

Response shape:

```ts
{
  items: User[];
  next_cursor: string | null; // opaque: do not parse or modify it
  has_more: boolean;
}
```

This uses Tarantool's native TREE-index pagination. Each storage calls
`index:select({}, {after = position, fetch_pos = true})`; `fetch_pos` produces
the base64 position used as `after` on the next request. Since positions belong
to a particular shard/index, the router cursor also records the active replica
set. Inserts after a shard's current position may appear later; deleted rows are
naturally skipped. A topology change can invalidate an outstanding cursor.

Configuration defaults are in `.env.example`. Bun automatically reads a local
`.env`, so copy it when you want to override the connection values.

## Why queries look different in a sharded database

Point operations have a sharding key (`id`), so the router sends them to one
bucket and one replica set. A query such as “all users aged at least 21” has no
single sharding key. The index example is intentionally shard-local: its first
ID chooses a bucket. A true cluster-wide query must fan out to every storage,
merge results, define a global ordering, and apply the limit after merging.
That is application logic, not a normal point lookup.

Transactions are likewise local to one Tarantool instance. The transaction
example searches for two IDs in the same bucket before calling `box.atomic`.
vshard does not turn this into a distributed ACID transaction across shards.

## Inspect the cluster

Open the router console:

```bash
docker compose exec router console
```

Useful Lua expressions:

```lua
vshard.router.info()
vshard.router.buckets_info()
vshard.router.bucket_id_mpcrc32(101)
box.info
```

Inspect a storage:

```bash
docker compose exec storage-1 console
```

```lua
vshard.storage.info()
box.space.users:len()
box.space.users.index.primary:select({101})
box.space.users.index.age:select({21}, {iterator = 'GE', limit = 10})
box.snapshot()
```

The storage ports `3302` and `3303` are exposed for learning and diagnostics.
A real deployment normally keeps them private and gives applications access
only to one or more routers.

## Important production gaps

This compact topology has no redundancy. In production, use multiple storage
replicas per replica set, multiple routers, automatic leader election/failover,
TLS, secrets outside source control, backups, monitoring, resource limits, and
a tested resharding/upgrade procedure. Pin the vshard rock version in the image
after validation instead of installing its newest compatible release.

## Troubleshooting

- `ECONNREFUSED`: wait for all three health checks; inspect Compose logs.
- authentication errors: use the router credentials from `.env.example`.
- duplicate key: examples use timestamps, but persisted data survives restarts;
  reset the learning data if an earlier interrupted run reused the same ID.
- Docker unavailable under WSL: enable Docker Desktop integration for this WSL
  distribution, then rerun `docker compose up --build -d`.

References: [vshard quick start](https://www.tarantool.io/en/doc/2.11/how-to/vshard_quick/),
[vshard router API](https://www.tarantool.io/docs/tarantool/en/3_x/reference/reference_rock/vshard/vshard_api/vshard_router),
and [Node.js connector documentation](https://www.tarantool.io/en/doc/latest/connector/community/nodejs/).
