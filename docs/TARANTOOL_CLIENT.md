# Tarantool Client Implementation

The application accesses Tarantool through `TarantoolDbLive`, an Effect layer
implemented in `src/infrastructure/tarantool/client.ts`. It owns a bounded,
health-aware pool of vshard router connections. Application code never connects
directly to storage instances.

## Architecture

Each endpoint in `TARANTOOL_ROUTERS` has one multiplexed
`tarantool-driver` connection and its own runtime state:

- active and pending connection;
- in-flight request count;
- consecutive transport failures and circuit cooldown;
- half-open probe ownership;
- request, failure, rejection, and reconnect counters.

The pool also tracks total in-flight requests for its global bulkhead.
Connections are created concurrently at layer startup. Startup succeeds when at
least one router is reachable and fails with `TarantoolError.kind = unavailable`
when none are reachable.

```text
Effect application
       |
       v
TarantoolDbLive / RouterPool
       |
       +-- router A connection --> vshard --> storage replica set
       |
       +-- router B connection --> vshard --> storage replica set
```

Router endpoints must identify stateless vshard routers, not storage nodes.
Production deployments should supply the endpoint list through their service
discovery mechanism and place routers in independent failure domains.

## Router selection

Selection is health-aware least-connections, not unconditional round-robin:

1. Exclude endpoints already attempted by the request.
2. Exclude open circuits and a half-open circuit that already has a probe.
3. Exclude routers at the per-router concurrency limit.
4. Find the remaining routers with the lowest `inFlight` count.
5. Rotate among equally loaded routers with `selectionCursor`.

With equally loaded healthy routers this behaves like round-robin. Under load
or failure it favors a healthy router with more available capacity.

## Bulkheads and load shedding

The pool enforces two hard limits:

- `TARANTOOL_MAX_IN_FLIGHT` across all routers;
- `TARANTOOL_MAX_IN_FLIGHT_PER_ROUTER` for each router.

The client does not queue beyond these limits. It immediately fails with
`TarantoolError.kind = overloaded`, allowing the HTTP layer to shed work rather
than consuming unbounded memory or increasing tail latency.

## Circuit breaker and reconnection

Connection-establishment and classified transport failures increment the
router's consecutive-failure counter. At
`TARANTOOL_CIRCUIT_FAILURE_THRESHOLD`, the circuit opens until
`TARANTOOL_CIRCUIT_RESET_MS` has elapsed.

After the cooldown, only one request may use that router as a half-open probe.
A successful operation closes the circuit and clears consecutive failures. A
failed probe reopens it.

Failed connections are discarded and recreated on demand. The client cancels
`tarantool-driver`'s internal reconnect scheduling so it cannot bypass circuit
cooldowns or create an orphan connection. Reconnection and endpoint selection
belong exclusively to `RouterPool`.

`enableOfflineQueue` is disabled. A command must never remain hidden in the
driver and execute later after the application has already treated it as
failed.

## Retry and write safety

The service exposes two call methods with different contracts:

```ts
db.call(schema, "api.user_create", input)
db.callReadonly(schema, "api.users_page", cursor, limit)
```

`call` is the default for mutations and operations without a proven idempotency
contract. It may select another endpoint only if connecting fails before the
command is sent. Once execution begins, a transport failure or timeout is
returned and the command is never replayed. Tarantool may have committed a
write even when its response was lost.

`callReadonly` is reserved for repeatable, side-effect-free reads. It may try
other configured routers after classified transport failures. Each router is
attempted at most once, preventing an unbounded retry storm.

`ping` uses the same safe retry behavior because protocol ping has no side
effects.

Do not use `callReadonly` merely because a Lua function usually reads. Its
entire server-side execution path must be side-effect-free and safe to repeat.

## Deadlines

`TARANTOOL_CONNECT_TIMEOUT_MS` bounds initial socket connection. The driver
does not use that setting as a command deadline, so the pool separately applies
`TARANTOOL_OPERATION_TIMEOUT_MS` to every operation.

An operation timeout is a transport failure. The connection is discarded
because the client cannot know whether the command is still executing or
whether its response is still in flight. Ordinary calls are not retried.

The server validates this ordering at startup:

```text
TARANTOOL_OPERATION_TIMEOUT_MS < HTTP_REQUEST_TIMEOUT_MS
TARANTOOL_SHUTDOWN_DRAIN_MS    < HTTP_GRACEFUL_SHUTDOWN_MS
```

The upstream proxy or load balancer deadline should be longer than the HTTP
deadline. A client timeout cannot cancel work already accepted by Tarantool, so
Lua procedures must also remain bounded and cooperative.

## Effect lifecycle

`AppConfigLive` evaluates Effect `Config` from the active `ConfigProvider` and
validates it with Effect Schema once at composition time. This keeps production
environment loading and deterministic in-memory test providers behind the same
service boundary.
`TarantoolDbLive` consumes its Tarantool section, and
`makeTarantoolDbLayer()` constructs the service with `Effect.acquireRelease`:

- acquire and validate configuration;
- connect to all router endpoints concurrently;
- expose typed `ping`, `status`, `call`, and `callReadonly` effects;
- on release, mark the pool as draining;
- reject new operations and wait for in-flight work up to
  `TARANTOOL_SHUTDOWN_DRAIN_MS`;
- disconnect all remaining sockets.

The Bun HTTP server owns listener shutdown. Its graceful timeout is longer than
the database drain budget, so dependency finalization has time to finish.

## Response validation and errors

Every call requires an Effect `Schema.ConstraintDecoder`. Tarantool driver
responses may contain one or more single-element protocol envelopes;
`decodeEnvelope` tries each unwrapped candidate and rejects malformed responses
as `TarantoolError.kind = response`.

Error kinds are:

| Kind | Meaning |
| --- | --- |
| `configuration` | Invalid endpoint or numeric configuration |
| `unavailable` | No eligible/reachable router or pool is draining |
| `overloaded` | Global or per-router concurrency capacity is exhausted |
| `transport` | Socket, connection, DNS, timeout, or equivalent transport failure |
| `response` | Response does not satisfy the requested Effect schema |

## Metrics and status

`db.status` returns each router's endpoint, circuit state, in-flight requests,
failure streak, retry time, and cumulative counters. `GET /metrics` exports the
same snapshot as JSON:

```json
{
  "success": true,
  "data": {
    "routers": [
      {
        "endpoint": "127.0.0.1:3301",
        "state": "closed",
        "inFlight": 0,
        "consecutiveFailures": 0,
        "retryAt": null,
        "requests": 10,
        "failures": 0,
        "rejections": 0,
        "reconnects": 1
      }
    ]
  }
}
```

Restrict this endpoint to the monitoring network because endpoint labels expose
internal topology. Production systems can bridge the snapshot to OpenTelemetry
or use a JSON exporter for Prometheus. Bulkhead and circuit thresholds must be
tuned with representative load, fault, and soak tests.

## Configuration

```env
TARANTOOL_ROUTERS=router-a.internal:3301,router-b.internal:3301
TARANTOOL_USER=app
TARANTOOL_PASSWORD=use-a-secret-provider
TARANTOOL_CONNECT_TIMEOUT_MS=5000
TARANTOOL_OPERATION_TIMEOUT_MS=4000
TARANTOOL_MAX_IN_FLIGHT=256
TARANTOOL_MAX_IN_FLIGHT_PER_ROUTER=128
TARANTOOL_CIRCUIT_FAILURE_THRESHOLD=3
TARANTOOL_CIRCUIT_RESET_MS=5000
TARANTOOL_SHUTDOWN_DRAIN_MS=10000
HTTP_REQUEST_TIMEOUT_MS=5000
HTTP_GRACEFUL_SHUTDOWN_MS=15000
```

`TARANTOOL_HOST` and `TARANTOOL_PORT` are compatibility fallbacks used only
when `TARANTOOL_ROUTERS` is absent. Production should configure at least two
router endpoints. HTTP, authentication, and SMTP configuration is supplied by
the same `AppConfig` service, including cross-service validation that the
database deadline precedes the HTTP deadline and database drain precedes HTTP
graceful shutdown.

## Driver type compatibility

The project uses `tarantool-driver` 3.1.x with
`@types/tarantool-driver` 3.0.4. The community declarations omit the runtime
`ping()` method and `enableOfflineQueue` option even though both are implemented
and documented by the driver. The client contains narrow local compatibility
types for only those members; it does not maintain a global declaration file.

## Verification

Run the cluster before integration tests:

```sh
make start
bun run typecheck
bun test
```

The integration suite covers routed CRUD, rebalance-safe logical pagination,
indexed Better Auth access, startup with an unavailable preferred router, and
typed failure when the entire router pool is unreachable.
