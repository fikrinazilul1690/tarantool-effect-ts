# Production readiness

This repository is a learning environment, not a production-ready system. The
smoke tests prove that the happy-path router, pagination, and Better Auth calls
work. They do not prove availability, security, durability, transactional
integrity, operability, or behavior under load and failure.

Do not approve a production deployment until every **Blocker** below is either
closed or explicitly accepted by the responsible engineering and security
owners. Production readiness is a property of the deployed system, including
its network, secret manager, orchestrator, monitoring, backups, and operating
procedures—not only this source tree.

## Recommended architecture

The lowest-risk architecture separates globally transactional identity data
from horizontally sharded application data:

```text
Clients
   |
Load balancer / TLS / rate limiting
   |
2+ Bun + Effect API instances
   |---------------- Transactional email queue / worker
   |---------------- Shared rate limiter (for example, Redis)
   |---------------- PostgreSQL + official Better Auth adapter
   `---------------- 2+ Tarantool vshard routers
                              |
                     2+ shards, 3 replicas each
                     spread across failure domains
```

Tarantool remains a strong fit for sharded domain data. A transactional
relational database is the simpler and safer fit for Better Auth because user
email, session token, and provider identity uniqueness are global invariants.

Keeping Better Auth entirely on Tarantool is possible, but requires a separate
design review. The design must co-locate every transaction and uniqueness
invariant, or provide an external uniqueness/transaction coordinator. Neither
vshard nor the CRUD module can atomically reserve an email in one bucket and
create an ID-sharded user in another bucket.

## Blockers

### Tarantool topology and failover

Current state:

- Each replica set contains one storage instance. Losing it loses access to
  that shard and may lose data not present in a verified backup.
- The local topology has two stateless routers, but both run on the same Docker
  host and therefore still share a failure domain.
- Master selection is static. There is no automated or supervised failover.
- Instances share the same local Docker host and therefore the same failure
  domain.

Required state:

- Run at least two, preferably three, storage instances per replica set.
- Spread replicas across independent hosts/zones and validate quorum behavior.
- Run at least two routers behind health-aware load balancing.
- Configure and test automated or supervised leader election and router master
  discovery.
- Run controlled master-loss, replica-loss, router-loss, and network-partition
  tests. Record recovery time and acceptable data-loss objectives.

Tarantool recommends three or more storage instances per replica set for
redundancy. See the
[vshard architecture](https://tarantool.io/docs/tarantool/en/3_x/platform/sharding/vshard_architecture).

### Better Auth integrity

Current state:

- The custom adapter declares `transaction: false`.
- Normalized user email, session token, and `[providerId, accountId]` are routed
  by their logical value and protected by storage-local unique indexes. Equal
  keys therefore meet on one vshard bucket and are globally unique.
- IDs returned for new auth records encode their logical bucket, allowing
  ID-only point operations without a scatter or physical replica-set identity.
- Shard-key mutation is rejected instead of leaving a record on a bucket that
  no longer matches its lookup key.
- Legacy records created with `model:id` routing have no automatic staged
  migration to canonical model-aware buckets.
- Better Auth plugin upgrades can introduce models, fields, `OR` predicates, or
  query patterns not supported by the custom planner.

Required state:

- Provide real rollback for multi-record signup, linking, session, verification,
  consume, and increment workflows.
- Implement a preflight/backfill/conflict-resolution migration for legacy auth
  data before deploying model-aware routing to an existing cluster.
- Resolve every mutate-one request to exactly one bucket before writing; remove
  the legacy scatter fallback after migration completion.
- Generate and compare the required Better Auth schema for every upgrade.
- Run the upstream adapter conformance tests plus local race and failure tests.

Better Auth documents email and session-token uniqueness and the account
identity constraint in its
[database schema](https://better-auth.com/docs/concepts/database). Its custom
adapter guide warns that nontransactional adapters have weaker integrity and
rollback guarantees:
[create a database adapter](https://better-auth.com/docs/beta/guides/create-a-db-adapter).

### Credentials and authorization

Current state:

- Router and storage passwords are embedded in Lua, topology configuration,
  Compose, examples, and documentation.
- The `app` and `storage` users receive `read,write,execute` on `universe`.
- The application and cluster-internal identities are not separated with
  least-privilege roles.

Required state:

- Inject credentials from a production secret manager; never bake them into an
  image or configuration committed to Git.
- Rotate all development credentials before connecting to production data.
- Grant the application user execute access only to the public `api.*`
  procedures it needs.
- Use the built-in `sharding` role and narrowly scoped procedure permissions for
  router-to-storage traffic.
- Use separate administration, replication, sharding, migration, backup, and
  application identities.
- Define rotation and emergency-revocation procedures and audit their use.

See [Tarantool credentials](https://tarantool.io/docs/tarantool/en/3_x/platform/connections_and_auth/credentials).

### Network exposure and encryption

Current state:

- The router, both storages, and the community Admin UI publish host ports.
- iproto and HTTP traffic are plaintext.
- The Admin image uses the mutable `latest` tag.
- There is no ingress policy, firewall policy, authenticated administration
  boundary, or trusted reverse-proxy configuration.

Required state:

- Keep storage, replication, and administrative ports on private networks.
- Expose only a controlled HTTPS application/load-balancer endpoint.
- Encrypt iproto and replication traffic with supported TLS, a service mesh, or
  a private VPN, including cross-datacenter traffic.
- Remove the Admin UI from production or protect a pinned image behind strong
  authentication, authorization, TLS, and network restrictions.
- Configure trusted proxies explicitly; never trust arbitrary forwarded IP or
  protocol headers.
- Add network policies that permit only required application and cluster flows.

See the [Tarantool security audit](https://www.tarantool.io/docs/tarantool/en/3_x/platform/security/audit).

### Application database connectivity

Current state:

- `TarantoolDbLive` creates one multiplexed connection per endpoint in
  `TARANTOOL_ROUTERS` and selects the least-loaded healthy router.
- Global and per-router bulkheads reject excess work immediately. Consecutive
  transport failures open a circuit; one half-open probe is admitted after the
  cooldown, and discarded connections reconnect on demand.
- A request may select another router only when connection establishment fails
  before sending the command. Ambiguous failed writes are never replayed;
  `ping`, which is safe to repeat, may try another router.
- The Docker topology exposes two router endpoints, and the integration suite
  verifies startup with an unavailable preferred endpoint.
- Database calls have a shorter deadline than HTTP requests, and Bun's graceful
  shutdown deadline exceeds the pool drain. `/metrics` exports per-router
  saturation, rejection, failure, reconnect, and circuit state. Production
  thresholds still require sustained fault, load, and soak testing.

Required state:

- Supply router endpoints through production service discovery and place them
  in independent failure domains.
- Tune bulkhead, circuit, and alert thresholds from production-representative
  load tests and scrape `/metrics` or bridge its snapshot to OpenTelemetry.
- Keep the database deadline below the HTTP and upstream deadlines. Only
  `callReadonly` retries a classified transport failure; ordinary calls never
  replay an ambiguous write.
- Benchmark one multiplexed connection versus a small bounded pool. See
  [TARANTOOL_POOL.md](./TARANTOOL_POOL.md).
- Preserve shutdown ordering: stop the listener, drain requests, reject new
  database work, then close connections after the bounded pool drain.

### Readiness and deployment safety

Current state:

- `/health` returns `ok` without checking Tarantool, vshard bucket discovery,
  Better Auth dependencies, or email infrastructure.
- Compose health checks test only whether the process answers, not whether the
  complete shard topology is usable.
- The API process is not part of the deployment topology.

Required state:

- Keep a cheap liveness endpoint that reports process health only.
- Add readiness checks for the router connection, known bucket coverage, and
  required dependencies.
- Stop routing traffic before readiness fails during shutdown or migration.
- Add startup probes so slow recovery does not trigger restart loops.
- Use immutable image digests, non-root users, read-only filesystems where
  possible, resource requests/limits, and graceful termination deadlines.

## High-priority risks

### Versions and dependency supply chain

- Tarantool 3.8.0, CRUD 1.7.5, vshard 0.1.42, checks 3.4.1, and errors 2.2.1
  are installed at exact release versions and pass the live integration suite
  against preserved data upgraded from 2.11.
- The image is still referenced by a version tag rather than an immutable
  digest, and the application continues to use direct Lua `box.cfg`/vshard
  configuration instead of a production configuration orchestrator.
- `effect` and `@effect/platform-bun` are release candidates, and the HTTP code
  imports `unstable/http` and `unstable/httpapi`.
- Several `package.json` versions use caret ranges or `latest`.

Required work:

- Maintain a compatibility matrix for Tarantool, vshard, CRUD, Bun,
  Better Auth, Effect, the connector, and the Admin UI.
- Pin exact package, rock, image, and image-digest versions.
- Scan images and dependencies for vulnerabilities and licenses.
- Use a staged upgrade procedure with backward-compatible schemas, canaries,
  rollback, and data-format compatibility tests.
- Prefer stable Effect APIs before declaring the HTTP service production-ready.

### Schema migrations

Current migrations use `box.once`. Some scan or rewrite existing spaces during
startup. This is unsuitable as a complete rolling-migration system: a large
rewrite can delay startup, block the cooperative transaction thread, or make
old and new application versions incompatible.

Required work:

- Create explicit, versioned, observable migrations with preflight checks.
- Separate additive schema deployment, background backfill, index build, code
  rollout, constraint activation, and old-field removal.
- Make every rollout compatible with both the previous and next application
  version.
- Test migrations with production-scale copies and a rollback/forward-fix plan.
- Run `vshard.router.bootstrap()` as an explicit controlled operation, not a
  normal router-startup side effect.

### Backups and disaster recovery

There is no automated backup, off-host retention, encryption, integrity check,
restore drill, or documented RPO/RTO.

Required work:

- Define RPO and RTO with business owners.
- Schedule snapshots and preserve the required WAL range for point-in-time
  recovery.
- Copy encrypted backups to independent storage and failure domains.
- Retain at least two recent snapshots and monitor backup age and failures.
- Perform automated restore verification and regular full disaster-recovery
  exercises.
- Document shard-by-shard and complete-cluster recovery procedures.

See [Tarantool backups](https://tarantool.io/docs/tarantool/en/3_x/admin/backups).

### Multi-datacenter behavior

The code calls `replicaset:callro`, but the topology defines neither replica
zones nor a zone-distance weights matrix. With one master per shard there is no
local replica to prefer. Cluster-wide list and auth queries contact every shard;
if shards span regions, their latency and data transfer become WAN-scatter.

Required work:

- Define router and replica zones plus tested distance weights.
- Place a readable replica of every required shard near each read-serving
  router, subject to the chosen consistency model.
- Keep global scatter endpoints off latency-sensitive request paths or replace
  them with regional/materialized query models.
- Define acceptable replication lag for authentication and revocation reads.
- Add cross-region latency, packet-loss, partition, and failover tests.

### Pagination and distributed consistency

The logical ID cursor survives topology changes and avoids physical shard
positions, but it is not a distributed snapshot. During traversal:

- inserts below the cursor are not observed;
- inserts above it may appear;
- deletes remove records that a prior count included;
- `totalPage` can change between requests;
- reads from replicas may reflect different replication points.

Required work:

- Document these semantics in the public API contract, or provide a snapshot/
  materialized-view mechanism when stable exports are required.
- Do not promise an exact final-page cursor without a distributed
  order-statistics design.
- Load-test scatter memory as shard count and page size grow.

### Counters

User totals are maintained transactionally through an `on_replace` trigger,
including tuple movement. They still need operational protection:

- periodic reconciliation against a controlled offline/analytics scan;
- alerts for negative or divergent counters;
- migration and recovery tests;
- rebalance tests proving source decrement and destination increment behavior;
- documented consistency semantics when totals are read from lagging replicas.

### Better Auth operational security

Current state:

- The server falls back to a development secret when the environment is absent.
- Secret rotation is not configured.
- Rate limiting relies on environment defaults and would be per-process memory.
- Proxy-derived client IP behavior is not configured.
- Verification email is durably enqueued during authentication and delivered
  asynchronously by the Effect worker.
- Disabled delivery logs verification URLs, which contain secrets.
- There is no password-reset delivery path, shared abuse control, or auth audit
  pipeline documented here.

Required state:

- Fail startup in production unless HTTPS base URL, explicit trusted origins,
  strong secrets, and required email/rate-limit configuration are present.
- Use Better Auth versioned secrets and a tested rotation procedure.
- Use a shared rate-limit backend and endpoint-specific rules for signup,
  signin, verification, reset, and token endpoints.
- Configure trusted proxies and client-IP extraction explicitly.
- Complete the existing durable outbox with provider idempotency, delivery
  metrics, dead-letter redrive/retention, and verification-secret protection.
- Never log tokens, verification URLs, passwords, cookies, authorization
  headers, SMTP credentials, or sensitive adapter payloads.
- Add security event logging and alerts for credential abuse and anomalous
  session activity.

See the Better Auth documentation for
[options and secret rotation](https://better-auth.com/docs/reference/options)
and [rate limiting](https://better-auth.com/docs/concepts/rate-limit).

### Effect and HTTP service

Required production controls include:

- typed configuration with startup validation instead of scattered
  `process.env` reads and insecure defaults;
- HTTP server request, header, and body limits;
- per-request deadlines and cancellation propagation to database/email calls;
- typed transient/permanent error classification rather than collapsing all
  database failures into one response;
- structured logs with request/trace IDs and mandatory redaction;
- OpenTelemetry traces, latency/error metrics, and service-level objectives;
- bounded concurrency and overload responses;
- graceful shutdown with readiness removal and in-flight request draining;
- explicit reverse-proxy and CORS behavior;
- dependency health included in readiness, not liveness.

The Promise boundaries around Better Auth and Nodemailer are legitimate, but
their failures, cancellation limitations, timeouts, and shutdown behavior must
be observed and tested.

### Observability and operations

Add dashboards and alerts for at least:

- HTTP request rate, latency, status, saturation, and auth outcomes;
- Effect fiber/runtime failures and unhandled defects;
- connector connection state, reconnects, call latency, timeouts, and errors;
- router bucket discovery, wrong-bucket responses, shard availability, and
  scatter fan-out latency;
- replication lag, elections, read-only/orphan state, WAL/disk growth, memory,
  snapshot age, and backup success;
- rebalancer state, moved buckets, safe-mode state if CRUD is adopted, and
  counter reconciliation;
- SMTP queue depth, retries, bounces, and dead letters;
- rate-limit decisions and suspicious authentication activity.

Create runbooks for every alert and assign an owner and escalation path.

## Tarantool CRUD architecture

CRUD 1.7.5 is initialized on every router and storage. Generic user
create/get/update/delete operations and global primary-ID selection use CRUD.
This replaces hand-written point routing and page-fragment merge logic with
schema-aware routing, yielding, replica preferences, and rebalance-aware
scatter/merge.

The application deliberately retains custom logic for exact O(1) counters,
same-bucket transactions, public logical cursors, and Better Auth's normalized
compound indexes. Storage `on_replace` triggers update counters in the same
transaction for CRUD writes and bucket moves; the router reads one counter per
shard concurrently.

CRUD does **not** remove the need for:

- normalized and indexed tuple fields;
- deterministic compound indexes;
- a deliberate sharding key;
- global uniqueness or cross-shard transaction design;
- zone-aware topology;
- bounded result sets and reviewed query plans.

Remaining production validation:

1. Translate and test every Better Auth operator and sort pattern before moving
   any of those specialized paths to CRUD.
2. Verify pagination tokens remain logical and rebalance-safe for the public
   API contract.
3. Benchmark GC pressure, storage tuple lookup, merge memory, and WAN behavior.
4. Test safe-mode entry/exit, rebalancing, mixed-version rolling upgrades, and
   downgrade/forward-fix procedures under concurrent traffic.

See the [CRUD project documentation](https://github.com/tarantool/crud).

## Required test program

The current integration smoke tests are necessary but far from sufficient. Add:

### Correctness

- pagination boundaries, identical sort values, empty shards, malformed and
  old cursors, concurrent inserts/deletes, and large IDs;
- all Better Auth core and enabled-plugin adapter operations;
- every supported predicate, range, sort, offset, and limit;
- global email/token/account uniqueness races;
- consume/increment contention and rollback behavior;
- counter reconciliation and migration from existing data.

### Failure and resilience

- router termination and reconnection;
- master loss before, during, and after a write;
- replica lag and stale authentication reads;
- bucket movement during pagination, reads, writes, and counter updates;
- partial scatter timeout and slow shard behavior;
- network partitions, DNS failure, packet loss, and cross-region latency;
- SMTP timeout, duplicate delivery, queue outage, and retry exhaustion;
- disk-full, WAL failure, snapshot failure, restart, and restore.

### Security

- authorization boundaries for every function and space;
- secret and token redaction;
- origin, proxy-header, cookie, CSRF, CORS, and TLS configuration;
- signup/signin/reset abuse and distributed rate-limit behavior;
- dependency, container, and infrastructure scans;
- external penetration test and threat-model review.

### Performance

- representative and peak point-read/write throughput;
- scatter queries as shard count grows;
- auth latency with shared rate limiting and email queuing;
- long-running soak tests, memory growth, GC pauses, and connection recovery;
- rebalance and backup impact under production load.

## Production acceptance checklist

The system may be considered for production only when all applicable items are
checked and linked to evidence:

- [ ] Target platform, regions, consistency model, RPO, and RTO are approved.
- [ ] Better Auth database architecture and global invariants are approved.
- [ ] Every replica set is redundant across failure domains.
- [ ] Router and application tiers have no single instance dependency.
- [ ] Automated/supervised failover has passed destructive tests.
- [ ] Credentials are external, rotated, and least-privileged.
- [ ] External and cluster traffic is encrypted and network-restricted.
- [ ] Admin and storage ports are not publicly exposed.
- [ ] Dependencies and images are exact-version/digest pinned and scanned.
- [ ] Stable Effect APIs are used or RC/unstable risk is formally accepted.
- [ ] Versioned rolling migrations and rollback/forward-fix plans are tested.
- [ ] Backups are encrypted, off-host, monitored, and restore-tested.
- [ ] Liveness, readiness, startup, and graceful-shutdown behavior is tested.
- [ ] Reconnect, retry, deadline, circuit-breaker, and overload policies work.
- [ ] Better Auth secrets, origins, cookies, proxies, and shared rate limits are
      explicitly configured.
- [x] Email SMTP delivery is decoupled from auth requests through a durable
  vshard-aware outbox with leases, bounded workers, retries, and dead-letter
  state.
- [ ] Encrypt or minimize verification secrets in outbox payloads, implement
  dead-letter redrive/retention, export worker metrics, and complete sustained
  SMTP fault/load testing.
- [ ] Logs, metrics, traces, dashboards, alerts, and runbooks are operational.
- [ ] Correctness, race, failover, rebalance, security, load, and soak tests pass.
- [ ] Disaster recovery and credential-rotation exercises pass.
- [ ] Security, database, platform, and service owners approve the release.

## Suggested delivery order

1. Decide the Better Auth persistence architecture and deployment platform.
2. Establish private networking, secret management, and least privilege.
3. Build redundant Tarantool replica sets, routers, and application instances.
4. Pin/upgrade Tarantool, vshard, and all application dependencies.
5. Implement production connectivity, readiness, deadlines, and graceful drain.
6. Implement auth uniqueness/transactions, shared rate limiting, and email queue.
7. Build migrations, backups, restore automation, telemetry, alerts, and runbooks.
8. Complete failure, security, load, soak, and disaster-recovery testing.
9. Perform staged rollout with canaries and explicit rollback criteria.

This order is intentional: polishing application handlers before resolving
identity integrity, redundancy, credentials, and recovery would not make the
system production-ready.
