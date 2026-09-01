import {BunRuntime} from '@effect/platform-bun';
import {Effect} from 'effect';
import {TarantoolDb, TarantoolDbLive} from './db';
import type {ClusterInfo} from './types';

const program = Effect.gen(function*() {
  const db = yield* TarantoolDb;
  yield* db.ping;
  yield* Effect.logInfo('Connected to the vshard router.');
  const info = yield* db.call<ClusterInfo>('api.cluster_info');
  yield* Effect.sync(() => console.dir(info, {depth: 5}));
}).pipe(Effect.provide(TarantoolDbLive));

BunRuntime.runMain(program);
