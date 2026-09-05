# Learn Tarantool with vshard, Bun, and TypeScript

This is a runnable learning project, not a production cluster. It contains two
stateless vshard routers and two independent storage replica sets (one instance
each). The Bun application selects between router ports `3301` and `3304`.

```text
Bun/TypeScript -> routers :3301/:3304 -> bucket -> storage-1 :3302
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

The project runs Tarantool 3.8.0 with CRUD 1.7.5, vshard 0.1.42, checks 3.4.1,
and errors 2.2.1. Exact versions are declared in
`learn-tarantool-1.0.0-1.rockspec`, which is the single Lua dependency manifest
used by the image build. The Node connector is
community-supported, so
`src/infrastructure/tarantool/client.ts` keeps it behind a typed Effect service.

## Start here

```bash
bun install
make start
bun run start
make api
bun run example:all
bun test
```

The image build installs the pinned CRUD stack. The first build can take a few minutes.
Follow startup with `docker compose logs -f`. Stop the cluster with
`docker compose down`.

To erase the learning database and bootstrap fresh:

```bash
make reset
make up
```

Database files live in the Compose-managed `storage-1-data`, `storage-2-data`,
`router-data`, and `router-2-data` named volumes rather than the repository.
`make stop` preserves them. `make reset` permanently removes only these
project-scoped volumes; take a tested backup before using it on valuable data.

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
| Router 2 | `router-2` | `3301` | `app` | `app-secret` |
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
| `make typecheck` | strict TypeScript and LuaLS checking without running the application |
| `make lua-typecheck` | LuaLS annotations and diagnostics for Tarantool Lua files |

Lua checking requires
[Lua Language Server](https://github.com/LuaLS/lua-language-server) on `PATH`.
The repository's `.luarc.json` selects LuaJIT and recognizes globals supplied
by the Tarantool runtime. Editors using LuaLS pick up the same settings
automatically; the project does not maintain replacement definitions for
Tarantool's `box` API.

Read these files in order:

1. `tarantool/cluster_config.lua` — bucket count and topology.
2. `tarantool/storage.lua` — schema, indexes, CRUD, and transaction logic.
3. `tarantool/router.lua` — sharding key calculation and `callro`/`callrw`.
4. `src/domain/user/` — user models and repository contract.
5. `src/infrastructure/config.ts` — validated environment configuration service.
6. `src/infrastructure/tarantool/` — client and repository implementation.
7. `src/infrastructure/auth/` — Better Auth and its Tarantool adapter.
8. `src/presentation/http/` — Effect HttpApi contracts and server layer.
9. `src/main.ts` — application layer composition and BunRuntime.
10. `examples/` — application usage from TypeScript.

See [`docs/TARANTOOL_CLIENT.md`](docs/TARANTOOL_CLIENT.md) for the complete
availability, retry, deadline, metrics, and lifecycle design. The running
client keeps one multiplexed
connection per configured router and applies bounded concurrency, load
shedding, circuit breaking, and least-loaded router selection. The HTTP API
also applies token-bucket rate limiting with `HTTP_RATE_LIMIT_PER_WINDOW`
and `HTTP_RATE_LIMIT_WINDOW_MS`; the default in-memory limiter is scoped to
one API process.

For the complete risk register, target architecture, remediation requirements,
test program, and release checklist, read
[`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md). Passing the
smoke tests does not make this learning topology production-ready.

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
| `GET /metrics` | Tarantool pool saturation, failures, rejections, reconnects, and circuits |
| `GET /openapi.json` | OpenAPI 3.1 generated from Effect schemas |
| `GET /docs` | Scalar documentation for Effect HttpApi routes |
| `GET /api/users?limit=20&cursor=...` | Bearer-protected user objects with a logical ID cursor |
| `/api/auth/*` | Better Auth endpoints, including Scalar OpenAPI reference at `/api/auth/references` |

Public Effect API responses use a consistent envelope:

```json
{"success": true, "data": {}}
```

Export the endpoint's success schema and reuse that exact value in its handler.
`Schema.make` applies the constructor default for `success`, while
`HttpApiBuilder` still checks the returned type:

```ts
return db.call<CursorPage<User>>('api.users_page', cursor, limit).pipe(
  Effect.map((page) => ListUsersSuccess.make({data: page})),
);
```

Do not use `endpoint.success` to construct the result. It is a runtime
`ReadonlySet` because an endpoint may declare multiple response
representations, so it does not expose one typed `.make()` method.

Request validation belongs in endpoint schemas rather than handlers. The
global `RequestSchemaError` middleware transforms Effect decoding failures for
query, payload, path, and header inputs into the standard response envelope:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Query validation failed",
    "fields": {
      "limit": ["Expected an integer"]
    }
  }
}
```

Handlers therefore receive already decoded values and only handle domain or
database failures. Response-encoding schema failures remain server defects and
are not mislabeled as invalid client input.

Errors include a stable machine-readable code:

```json
{"success": false, "error": {"code": "UNAUTHORIZED", "message": "..."}}
```

JSON responses from `/api/auth/*` use the same envelope. Better Auth redirects,
empty responses, cookies, and headers such as `set-auth-token` pass through
unchanged. The server-side `auth.api` interface also remains native so the
authorization middleware can validate sessions without encoding and decoding
HTTP envelopes.

The Better Auth bearer plugin exposes `set-auth-token` after verification and
sign-in. Use either that signed value or the sign-in JSON `token` to access
protected application endpoints:

```bash
curl -H 'Authorization: Bearer YOUR_TOKEN' \
  'http://localhost:3000/api/users?limit=20'
```

### Postman

Import both files into Postman and select the **Learn Tarantool - Local**
environment:

- `postman/Learn-Tarantool.postman_collection.json`
- `postman/Local.postman_environment.json`

The collection contains health, OpenAPI, pagination, email verification, and
session requests. Run **List Users - First Page** before
**List Users - Next Page** so its test script saves `next_cursor`. First run
**Sign In with Email** after verifying the account to save `sessionToken`; user
requests send it as a bearer token. Clear the collection's `authEmail` variable
to generate a new unique account on the next sign-up.

### Real email verification

Email/password accounts must verify their address before sign-in. Sign-up and
unverified sign-in both send a one-hour verification link. With delivery
disabled, the development server logs the link. For Gmail delivery:

1. Enable 2-Step Verification on a Google account.
2. Create an App Password; normal Google passwords are not accepted for SMTP.
3. Copy `.env.example` to `.env` and set `EMAIL_DELIVERY_ENABLED=true`,
   `SMTP_USER`, `SMTP_PASSWORD`, and `EMAIL_FROM`.
4. Restart `make api`. SMTP connections are established by the outbox worker;
   provider outages do not prevent the API from starting or accepting queued
   verification emails.

For another provider, change `SMTP_HOST`, `SMTP_PORT`, and `SMTP_SECURE`.
Never commit `.env` or an App Password. A production service should enqueue
email work instead of waiting for SMTP inside the authentication request.

The `email_outbox` vinyl space stores queued jobs on the bucket derived from
their logical ID. Each API process runs an Effect-scoped worker and claims due
jobs from every replica set concurrently. Claims are atomic, owner-specific
leases; an interrupted worker leaves the row recoverable after `EMAIL_LEASE_MS`.
Delivery concurrency is bounded by `EMAIL_WORKER_CONCURRENCY`. Failures use
jittered exponential backoff through `EMAIL_RETRY_BASE_MS` and
`EMAIL_RETRY_MAX_MS`; jobs become `dead` after `EMAIL_MAX_ATTEMPTS`.

`EMAIL_SEND_TIMEOUT_MS` bounds SMTP connection and send latency and must be
shorter than the lease. `EMAIL_WORKER_BATCH_SIZE` is applied per shard, so size
worker capacity for `batch size × replica-set count`. SMTP delivery is
at-least-once: a crash after the provider accepts mail but before acknowledgement
can produce a duplicate. Dead-letter redrive, retention, provider idempotency,
and queue metrics remain production checklist items.

For a future SQL-backed Effect Workflow/Cluster replacement, including typed
workflow contracts, durable submission, SMTP activities, runner layers, and a
staged migration from this outbox, see
[`docs/EFFECT_CLUSTER_EMAIL_WORKFLOW.md`](docs/EFFECT_CLUSTER_EMAIL_WORKFLOW.md).

Create an account; Better Auth waits only for a durable Tarantool outbox insert
and returns without waiting for SMTP. An Effect worker leases and delivers the
email in the background. Sign-up returns no token until the recipient verifies
the address:

```bash
curl -c /tmp/auth-cookies.txt \
  -H 'content-type: application/json' \
  -H 'origin: http://localhost:3000' \
  -d '{"name":"Ada","email":"ada@example.com","password":"secure-password-123"}' \
  http://localhost:3000/api/auth/sign-up/email

# Click the received link, then sign in with POST /api/auth/sign-in/email.
```

Sign in later with `POST /api/auth/sign-in/email` using the same `email` and
`password` fields. Set `AUTH_DEBUG=true` when troubleshooting adapter calls.
Browser clients send `Origin` automatically. Non-browser clients that retain
cookies, including Postman and curl cookie jars, must send an `Origin` matching
`APP_ORIGIN`; Better Auth rejects a missing origin to prevent CSRF. Do not work
around `MISSING_OR_NULL_ORIGIN` by disabling Better Auth's origin or CSRF
checks.

When signup uses an already registered email, Better Auth keeps its synthetic
success response to prevent account enumeration. The `onExistingUserSignUp`
hook sends a security notification to the persisted account owner; notification
failures are logged and do not change the response seen by the requester. This
hook does not resend a verification link and never receives or includes the
attempted password. Production still requires a shared per-IP/per-email rate
limiter and a durable email outbox to prevent notification abuse and remove
SMTP from the request path.

The custom adapter stores Better Auth's `user`, `session`, `account`, and
verification models as maps in the `auth_records` space. New records use
model-aware logical bucket keys: normalized email for users, token for sessions,
`[providerId, accountId]` for accounts, and identifier for verification rows.
The router prefixes returned IDs with the selected bucket (`b<bucket>_<id>`),
so subsequent ID-only reads and writes remain O(1) and rebalance-safe. User
email, session token, and provider-account indexes are unique on storage; since
equal logical keys always select the same vshard bucket, those constraints are
cluster-wide. Verification identifiers intentionally allow multiple values but
all values for one identifier are co-located for atomic consumption.

Frequently queried fields (`email`, `token`, `userId`, `accountId`,
`providerId`, `identifier`, and `expiresAt`) are duplicated into nullable tuple
fields with index-aware query paths. Email routing and comparison trim outer
whitespace and lowercase the address. Shard-key updates are rejected: email,
token, provider-account identity, and verification identifier changes require
an explicit migration rather than silently stranding a record. Non-unique
multi-row queries, such as listing sessions by `userId`, still scatter to all
replica sets concurrently. Query limits and offsets are capped at 1,000 and
10,000 respectively.

The [Tarantool CRUD module](https://github.com/tarantool/crud) is initialized on
every router and storage. User point operations and the global primary-ID scan
use CRUD for routing, schema discovery, yielding, replica preferences, and
rebalance-aware scatter/merge. Exact counters remain custom: a storage
`on_replace` trigger updates each shard's counter in the same transaction, and
the router reads those counters concurrently. Better Auth also remains custom
because its map payload needs normalized compound indexes and operation-aware
transaction paths that generic CRUD does not provide.

CRUD does not make nested map fields indexable, provide global uniqueness, or
create cross-shard transactions. Public cursors therefore remain logical
value-based tokens owned by this application, rather than CRUD or physical
replica-set state.

Global uniqueness and cross-record transactions remain separate architectural
concerns. Model-aware routing now enforces the core uniqueness domains, but the
custom adapter still declares `transaction: false`: Better Auth creates a user
and credential account with separate calls that cannot roll back together.
Production deployment also requires an explicit migration for records created
by the former `model:id` routing scheme; restarting old data directly does not
move it to the new canonical buckets.

The application is assembled as an Effect layer graph. `TarantoolDbLive`
acquires one connection per configured router. During shutdown the HTTP
listener drains first; the pool rejects new work, waits up to
`TARANTOOL_SHUTDOWN_DRAIN_MS`, and then closes every connection.
`BetterAuthLive` depends on that database service,
and the HTTP routes depend on both services. `BunHttpServer.layer` owns the
listener while `BunRuntime.runMain` handles execution, SIGINT, and SIGTERM.
Keep `TARANTOOL_OPERATION_TIMEOUT_MS` below `HTTP_REQUEST_TIMEOUT_MS`, and the
HTTP timeout below the upstream proxy deadline.
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
import type {User} from './src/domain/user/model';
import {AppConfigLive} from './src/infrastructure/config';
import {TarantoolDb, TarantoolDbLive} from './src/infrastructure/tarantool/client';

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
}).pipe(Effect.provide(TarantoolDbLive), Effect.provide(AppConfigLive));

BunRuntime.runMain(program);
```

### Cursor-based list API

`api.users_page(cursor, limit)` lists users across every shard. Replica sets are
queried concurrently and the router merges users in ascending ID order. The
first cursor is `null`; pass `next_cursor` unchanged to the next request. The
cursor contains only the last logical user ID and page number, so it remains
valid when buckets move between replica sets. Limits must be between 1 and 100.

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
  totalPage: number;
  currentPage: number;
  lastCursor: null; // retained for compatibility; exact lookup is not O(1)
}
```

`totalPage` is calculated from transactional per-storage counters returned with
the page fragments. Inserts, deletes, and vshard tuple moves update those
counters through an `on_replace` trigger in the same transaction. `lastCursor`
is always `null`: an exact final-page cursor needs an order-statistics index and
must not be simulated by replaying every page.

Each storage performs a bounded `GT` scan on the primary ID index. The router
requests `limit + 1` rows concurrently from every replica set, de-duplicates by
ID (including during bucket movement), sorts, and returns one page. Configure
replica `zone` values and the vshard `weights` distance matrix in multi-DC
deployments; `replicaset:callro` then selects the nearest available node.

Configuration defaults are documented in `.env.example`. Bun loads a local
`.env`, then `AppConfigLive` evaluates an Effect `Config` description once
during layer startup. `Config.schema` and Effect Schema trim and transform
strings into URLs, booleans, ports, and bounded integers; the final application
schema validates router endpoints, SMTP requirements, and cross-service
deadline ordering. The resulting immutable snapshot is shared by Tarantool,
HTTP, Better Auth, and SMTP. Invalid input fails through the typed `ConfigError`
channel before the application begins accepting traffic.

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
box.space.counters:get({'users'})
box.space.users.index.primary:select({101})
box.space.users.index.age:select({21}, {iterator = 'GE', limit = 10})
box.snapshot()
```

The storage ports `3302` and `3303` are exposed for learning and diagnostics.
A real deployment normally keeps them private and gives applications access
only to one or more routers.

## Important production gaps

This compact topology has no redundancy and intentionally uses development
credentials and exposed diagnostic ports. Do not deploy it unchanged. The
complete production gap analysis and acceptance criteria are maintained in
[`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md).

## Production readiness task list

A checked item means the control is implemented in this repository and has
corresponding automated or live integration coverage where practical. It does
not mean the entire system is production-ready; every unchecked release
blocker still needs implementation and evidence.

### Tarantool data and query safety

- [x] Route point reads and writes by stable vshard bucket keys.
- [x] Use logical value-based pagination cursors instead of replica-set UUIDs
      or physical shard indexes.
- [x] Paginate the current global user stream by its unique primary ID, avoiding
      ties and physical-topology state.
- [x] Perform bounded index scans on storage and scatter-gather concurrently
      across shards.
- [x] Maintain record counters atomically instead of using `space:len()` on
      Vinyl-compatible paths.
- [x] Use indexed Better Auth lookup, count, update, and delete paths.
- [x] Run CRUD 1.7.5 on every router and storage for generic user point CRUD
      and global indexed selection.
- [x] Pin Tarantool 3.8.0 and CRUD's vshard/checks/errors dependencies to exact
      release versions.
- [ ] Before adding pagination ordered by `age`, `created_at`, or another
      non-unique field, implement and test a `[secondary_value, primary_id]`
      cursor.
- [x] Enforce cluster-wide uniqueness for normalized Better Auth user emails,
      session tokens, and `[providerId, accountId]`, with concurrent race tests.
- [ ] Provide rollback/reconciliation guarantees for Better Auth workflows that
      write multiple records, including user plus credential-account signup.
- [ ] Build a staged migration for legacy `model:id`-sharded auth records,
      including duplicate preflight, conflict resolution, and canonical-bucket
      movement before enabling model-aware reads.
- [ ] Implement and test versioned, rolling schema migrations with rollback or
      forward-fix procedures.

### Client availability and overload protection

- [x] Support multiple router endpoints with one multiplexed connection per
      endpoint.
- [x] Select the least-loaded healthy router and rotate among equal candidates.
- [x] Apply global and per-router bulkheads with immediate load shedding.
- [x] Apply circuit breaking, a single half-open probe, and pool-owned
      reconnection.
- [x] Disable the driver's offline queue and automatic reconnect race.
- [x] Never replay ambiguous ordinary calls or writes; retry only explicitly
      repeatable `callReadonly` operations and `ping`.
- [x] Coordinate database and HTTP deadlines and validate their ordering at
      startup.
- [x] Drain in-flight work and close router connections during graceful
      shutdown.
- [x] Export per-router saturation, rejection, failure, reconnect, and circuit
      state through `/metrics`.
- [ ] Tune deadlines, bulkheads, circuit thresholds, and alerts using
      production-representative load, fault, and soak tests.
- [ ] Integrate production service discovery and deploy routers across
      independent hosts or zones.

### Topology, durability, and recovery

- [x] Run two stateless routers in the local Docker topology.
- [ ] Run multiple storage replicas per replica set across independent failure
      domains.
- [ ] Implement and destructively test automated or supervised storage
      failover and leader discovery.
- [ ] Run redundant application instances behind health-aware load balancing.
- [ ] Define and approve consistency, region, RPO, and RTO requirements.
- [ ] Automate encrypted off-host backups and continuously monitor them.
- [ ] Pass scheduled restore, point-in-time recovery, and disaster-recovery
      exercises.
- [ ] Test bucket rebalancing under concurrent production traffic.

### Security and dependency controls

- [x] Validate API inputs and database responses with Effect schemas and typed
      error channels.
- [x] Protect application user routes with Better Auth authorization.
- [ ] Remove development credential fallbacks and load all secrets from a
      production secret manager with rotation.
- [ ] Explicitly configure production origins, secure cookies, trusted proxies,
      and a shared distributed authentication rate limiter.
- [ ] Encrypt external and cluster traffic and enforce private network policy.
- [ ] Remove public storage/Admin exposure or protect it with authenticated,
      audited administrative access.
- [ ] Pin dependencies and container images to reviewed exact versions or
      digests and enable vulnerability/SBOM scanning.
- [ ] Complete threat modeling, dependency review, and external penetration
      testing.

### HTTP, email, and operations

- [x] Expose schema-first HTTP endpoints and generated OpenAPI documentation.
- [x] Separate cheap process health from Tarantool pool metrics.
- [ ] Add dependency-aware readiness that verifies router reachability and
      vshard bucket coverage without turning liveness into a dependency check.
- [ ] Restrict `/metrics` to the monitoring network and integrate it with the
      production telemetry backend.
- [ ] Add structured logs, distributed traces, dashboards, SLOs, alerts, and
      operational runbooks.
- [x] Remove SMTP delivery from authentication request latency using a durable,
      vshard-aware Tarantool outbox with atomic leases, bounded Effect workers,
      retry limits, jittered exponential backoff, and dead-letter state.
- [ ] Export outbox depth, lease, attempt, delivery, retry, timeout, and
      dead-letter metrics; add redrive and retention operations.
- [ ] Encrypt or minimize verification secrets stored in the outbox and use an
      SMTP provider idempotency key where supported to reduce duplicate mail.
- [ ] Add HTTP header/body/concurrency limits and distributed abuse controls.
- [ ] Pass correctness, race, failover, network-partition, security, load, and
      long-running soak test programs.
- [ ] Obtain database, security, platform, and service-owner production
      approval.

## Troubleshooting

- `ECONNREFUSED`: wait for both routers and both storages to become healthy;
  inspect Compose logs.
- authentication errors: use the router credentials from `.env.example`.
- duplicate key: examples use timestamps, but persisted data survives restarts;
  reset the learning data if an earlier interrupted run reused the same ID.
- Docker unavailable under WSL: enable Docker Desktop integration for this WSL
  distribution, then rerun `docker compose up --build -d`.

References: [vshard quick start](https://www.tarantool.io/en/doc/latest/how-to/vshard_quick/),
[vshard router API](https://www.tarantool.io/docs/tarantool/en/3_x/reference/reference_rock/vshard/vshard_api/vshard_router),
and [Node.js connector documentation](https://www.tarantool.io/en/doc/latest/connector/community/nodejs/).
