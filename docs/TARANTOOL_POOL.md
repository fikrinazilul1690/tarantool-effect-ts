# Tarantool Connection Pool

`tarantool-driver` does not include a pool. Each connection can already multiplex concurrent requests, so benchmark before replacing the current single-connection `TarantoolDbLive`. A small pool can provide additional sockets, workload distribution, and resilience against a stalled connection.

## Effect Service and Layer

The following implementation acquires every connection inside the layer scope, closes all of them during shutdown, and selects connections round-robin.

```ts
import TarantoolConnection from "tarantool-driver";
import { Context, Data, Effect, Layer, Ref, Schema } from "effect";

export class TarantoolPoolError extends Data.TaggedError("TarantoolPoolError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface TarantoolPoolShape {
  readonly size: number;
  readonly call: <A>(
    schema: Schema.ConstraintDecoder<A>,
    name: string,
    ...args: ReadonlyArray<unknown>
  ) => Effect.Effect<A, TarantoolPoolError>;
}

export class TarantoolPool extends Context.Service<
  TarantoolPool,
  TarantoolPoolShape
>()("learn-tarantool/TarantoolPool") {}

const acquireConnection = (index: number) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const connection = new TarantoolConnection({
          host: process.env.TARANTOOL_HOST ?? "127.0.0.1",
          port: Number(process.env.TARANTOOL_PORT ?? 3301),
          username: process.env.TARANTOOL_USER ?? "app",
          password: process.env.TARANTOOL_PASSWORD ?? "app-secret",
          lazyConnect: true,
          timeout: 5_000,
        });
        await connection.connect();
        return connection;
      },
      catch: (cause) => new TarantoolPoolError({
        operation: `connect[${index}]`,
        cause,
      }),
    }),
    (connection) => Effect.sync(() => connection.disconnect()),
  );

export const TarantoolPoolLive = Layer.effect(
  TarantoolPool,
  Effect.gen(function*() {
    const size = Number(process.env.TARANTOOL_POOL_SIZE ?? 4);
    if (!Number.isInteger(size) || size < 1 || size > 32) {
      return yield* Effect.fail(new TarantoolPoolError({
        operation: "configure",
        cause: new Error("TARANTOOL_POOL_SIZE must be between 1 and 32"),
      }));
    }

    const connections = yield* Effect.forEach(
      Array.from({ length: size }, (_, index) => index),
      acquireConnection,
      { concurrency: "unbounded" },
    );
    const nextIndex = yield* Ref.make(0);

    const call = <A>(
      schema: Schema.ConstraintDecoder<A>,
      name: string,
      ...args: ReadonlyArray<unknown>
    ) =>
      Effect.gen(function*() {
        const connection = yield* Ref.modify(nextIndex, (current) => [
          connections[current % connections.length]!,
          current + 1,
        ] as const);
        const response = yield* Effect.tryPromise({
          try: () => connection.call(name, ...args),
          catch: (cause) => new TarantoolPoolError({
            operation: `call ${name}`,
            cause,
          }),
        });
        return yield* decodeEnvelope(schema, response).pipe(
          Effect.mapError((cause) => new TarantoolPoolError({
            operation: `decode ${name}`,
            cause,
          })),
        );
      });

    return TarantoolPool.of({ size, call });
  }),
);

function decodeEnvelope<A>(schema: Schema.ConstraintDecoder<A>, response: unknown) {
  const candidates = [response];
  let value = response;
  while (Array.isArray(value) && value.length === 1) {
    value = value[0];
    candidates.push(value);
  }
  const decode = Schema.decodeUnknownEffect(schema);
  const attempt = (index: number): Effect.Effect<A, unknown> =>
    decode(candidates[index]).pipe(
      Effect.catch((error) => index + 1 < candidates.length
        ? attempt(index + 1)
        : Effect.fail(error)),
    );
  return attempt(0);
}
```

## Usage

```ts
const program = Effect.gen(function*() {
  const pool = yield* TarantoolPool;
  return yield* pool.call(UserCursorPageSchema, "api.users_page", null, 20);
}).pipe(Effect.provide(TarantoolPoolLive));
```

Configure the pool without committing secrets:

```env
TARANTOOL_POOL_SIZE=4
```

## Operational Notes

- Start with two to four connections and measure throughput and latency.
- Round-robin distributes calls but does not impose a concurrency limit. Add an Effect semaphore if each connection needs bounded in-flight work.
- Every connection targets the vshard router, not individual storage nodes.
- Driver reconnection still operates independently for each connection.
- Pooling multiplies open sockets, authentication work, queues, and memory.
- For multiple router instances, assign different router addresses across connections instead of treating storage instances as pool members.
- Test partial acquisition failure, shutdown cleanup, concurrent calls, reconnection, and malformed pool sizes before production use.
