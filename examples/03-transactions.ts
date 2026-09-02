import {BunRuntime} from '@effect/platform-bun';
import {Effect, Schema} from 'effect';
import {UserSchema} from '../src/domain/user/model';
import {AppConfigLive} from '../src/infrastructure/config';
import {TarantoolDb, TarantoolDbLive} from '../src/infrastructure/tarantool/client';

const program = Effect.gen(function*() {
  const db = yield* TarantoolDb;
  const firstId = Date.now();
  const wantedBucket = yield* db.call(Schema.Number, 'api.bucket_id', firstId);
  let secondId = firstId + 1;
  while ((yield* db.call(Schema.Number, 'api.bucket_id', secondId)) !== wantedBucket) secondId += 1;

  yield* db.call(UserSchema, 'api.user_create', {id: firstId, email: `a-${firstId}@example.com`, name: 'A', age: 40});
  yield* db.call(UserSchema, 'api.user_create', {id: secondId, email: `b-${secondId}@example.com`, name: 'B', age: 20});
  yield* Effect.log('Atomic result:', yield* db.call(Schema.Array(UserSchema), 'api.transfer_age', firstId, secondId, 5));
  yield* db.call(Schema.Array(UserSchema), 'api.transfer_age', firstId, secondId, 1000).pipe(
    Effect.catch((error) => Effect.log('Expected rollback:', error)),
  );
  yield* Effect.log(
    'Still consistent:',
    yield* db.call(UserSchema, 'api.user_get', firstId),
    yield* db.call(UserSchema, 'api.user_get', secondId),
  );
}).pipe(Effect.provide(TarantoolDbLive), Effect.provide(AppConfigLive));

BunRuntime.runMain(program);
