import {BunRuntime} from '@effect/platform-bun';
import {Effect} from 'effect';
import {TarantoolDb, TarantoolDbLive} from '../src/db';
import type {User} from '../src/types';

const program = Effect.gen(function*() {
  const db = yield* TarantoolDb;
  const firstId = Date.now();
  const wantedBucket = yield* db.call<number>('api.bucket_id', firstId);
  let secondId = firstId + 1;
  while ((yield* db.call<number>('api.bucket_id', secondId)) !== wantedBucket) secondId += 1;

  yield* db.call<User>('api.user_create', {id: firstId, email: `a-${firstId}@example.com`, name: 'A', age: 40});
  yield* db.call<User>('api.user_create', {id: secondId, email: `b-${secondId}@example.com`, name: 'B', age: 20});
  yield* Effect.log('Atomic result:', yield* db.call<User[]>('api.transfer_age', firstId, secondId, 5));
  yield* db.call('api.transfer_age', firstId, secondId, 1000).pipe(
    Effect.catch((error) => Effect.log('Expected rollback:', error)),
  );
  yield* Effect.log(
    'Still consistent:',
    yield* db.call<User>('api.user_get', firstId),
    yield* db.call<User>('api.user_get', secondId),
  );
}).pipe(Effect.provide(TarantoolDbLive));

BunRuntime.runMain(program);
