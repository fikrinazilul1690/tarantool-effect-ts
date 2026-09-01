import TarantoolConnection from 'tarantool-driver';
import {Context, Data, Effect, Layer, Schema} from 'effect';

export class TarantoolError extends Data.TaggedError('TarantoolError')<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export interface TarantoolDbShape {
  readonly ping: Effect.Effect<void, TarantoolError>;
  readonly call: <A>(
    schema: Schema.ConstraintDecoder<A>,
    name: string,
    ...args: ReadonlyArray<unknown>
  ) => Effect.Effect<A, TarantoolError>;
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
      call: <A>(schema: Schema.ConstraintDecoder<A>, name: string, ...args: ReadonlyArray<unknown>) => Effect.tryPromise({
        try: () => connection.call(name, ...args),
        catch: (cause) => new TarantoolError({operation: `call ${name}`, cause}),
      }).pipe(
        Effect.flatMap((response) => decodeEnvelope(schema, response)),
        Effect.mapError((cause) => cause instanceof TarantoolError
          ? cause
          : new TarantoolError({operation: `decode ${name}`, cause})),
      ),
    })),
  ),
);

function decodeEnvelope<A>(schema: Schema.ConstraintDecoder<A>, response: unknown) {
  const candidates: Array<unknown> = [response];
  let value = response;
  while (Array.isArray(value) && value.length === 1) {
    value = value[0];
    candidates.push(value);
  }

  const decode = Schema.decodeUnknownEffect(schema);
  const attempt = (index: number): Effect.Effect<A, unknown> => decode(candidates[index]).pipe(
    Effect.catch((error) => index + 1 < candidates.length
      ? attempt(index + 1)
      : Effect.fail(error)),
  );
  return attempt(0);
}
