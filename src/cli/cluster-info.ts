import {BunRuntime} from '@effect/platform-bun';
import {Effect} from 'effect';
import {ClusterInfoSchema} from '../domain/cluster/model';
import {TarantoolDb, TarantoolDbLive} from '../infrastructure/tarantool/client';

const program = Effect.gen(function*() {
  const db = yield* TarantoolDb;
  yield* db.ping;
  yield* Effect.logInfo('Connected to the vshard router.');
  const info = yield* db.call(ClusterInfoSchema, 'api.cluster_info');
  yield* Effect.sync(() => console.dir(info, {depth: 5}));
}).pipe(Effect.provide(TarantoolDbLive));

BunRuntime.runMain(program);
