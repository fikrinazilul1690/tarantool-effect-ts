import {BunRuntime} from '@effect/platform-bun';
import {Effect} from 'effect';
import {TarantoolDb, TarantoolDbLive} from '../src/db';
import type {ClusterInfo} from '../src/types';

const program = Effect.gen(function*() {
  const db = yield* TarantoolDb;
  for (const id of [1, 2, 42, 1000, 99999]) {
    yield* Effect.log({id, bucketId: yield* db.call<number>('api.bucket_id', id)});
  }
  const info = yield* db.call<ClusterInfo>('api.cluster_info');
  yield* Effect.sync(() => console.dir(info, {depth: 6}));
  yield* Effect.log('The client knows only the router; vshard maps buckets to storage replica sets.');
}).pipe(Effect.provide(TarantoolDbLive));

BunRuntime.runMain(program);
