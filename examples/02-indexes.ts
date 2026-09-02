import {BunRuntime} from '@effect/platform-bun';
import {Effect, Schema} from 'effect';
import {UserSchema} from '../src/domain/user/model';
import {AppConfigLive} from '../src/infrastructure/config';
import {TarantoolDb, TarantoolDbLive} from '../src/infrastructure/tarantool/client';

const program = Effect.gen(function*() {
  const db = yield* TarantoolDb;
  const seed = Date.now();
  for (let offset = 0; offset < 8; offset += 1) {
    const id = seed + offset;
    yield* db.call(UserSchema, 'api.user_create', {
      id, email: `learner-${id}@example.com`, name: `Learner ${offset}`, age: 18 + offset,
    });
  }
  yield* Effect.log(yield* db.call(Schema.Array(UserSchema), 'api.users_by_age', seed, 21, 10));
}).pipe(Effect.provide(TarantoolDbLive), Effect.provide(AppConfigLive));

BunRuntime.runMain(program);
