import TarantoolConnection from 'tarantool-driver';
import {Context, Data, Effect, Layer} from 'effect';

export class TarantoolError extends Data.TaggedError('TarantoolError')<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface TarantoolDbShape {
  readonly ping: Effect.Effect<void, TarantoolError>;
  readonly call: <T>(name: string, ...args: ReadonlyArray<unknown>) => Effect.Effect<T, TarantoolError>;
}

export class TarantoolDb extends Context.Service<TarantoolDb, TarantoolDbShape>()(
  'learn-tarantool/TarantoolDb',
) {}

const acquire = Effect.tryPromise({
  try: async () => {
    const connection = new TarantoolConnection({
      host: process.env.TARANTOOL_HOST ?? '127.0.0.1',
      port: Number(process.env.TARANTOOL_PORT ?? 3301),
      username: process.env.TARANTOOL_USER ?? 'app',
      password: process.env.TARANTOOL_PASSWORD ?? 'app-secret',
      lazyConnect: true,
      timeout: 5_000,
    });
    await connection.connect();
    return connection;
  },
  catch: (cause) => new TarantoolError({operation: 'connect', cause}),
});

export const TarantoolDbLive = Layer.effect(
  TarantoolDb,
  Effect.acquireRelease(acquire, (connection) =>
    Effect.sync(() => connection.disconnect())).pipe(
    Effect.map((connection): TarantoolDbShape => TarantoolDb.of({
      ping: Effect.tryPromise({
        try: () => connection.ping().then(() => undefined),
        catch: (cause) => new TarantoolError({operation: 'ping', cause}),
      }),
      call: <T>(name: string, ...args: ReadonlyArray<unknown>) => Effect.tryPromise({
        try: async () => unwrap(await connection.call(name, ...args)) as T,
        catch: (cause) => new TarantoolError({operation: `call ${name}`, cause}),
      }),
    })),
  ),
);

function unwrap(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 ? unwrap(value[0]) : value;
}
