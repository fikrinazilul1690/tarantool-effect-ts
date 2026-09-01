import {BunRuntime} from '@effect/platform-bun';
import {Effect, Schema} from 'effect';
import {UserSchema} from '../src/domain/user/model';
import {TarantoolDb, TarantoolDbLive} from '../src/infrastructure/tarantool/client';

const program = Effect.gen(function*() {
  const db = yield* TarantoolDb;
  const id = Date.now();
  yield* Effect.log('CREATE', yield* db.call(UserSchema, 'api.user_create', {
    id, email: `ada-${id}@example.com`, name: 'Ada', age: 36,
  }));
  yield* Effect.log('READ', yield* db.call(Schema.NullOr(UserSchema), 'api.user_get', id));
  yield* Effect.log('UPDATE', yield* db.call(UserSchema, 'api.user_update', id, {name: 'Ada Lovelace', age: 37}));
  yield* Effect.log('DELETE', yield* db.call(UserSchema, 'api.user_delete', id));
  yield* Effect.log('READ MISSING', yield* db.call(Schema.NullOr(UserSchema), 'api.user_get', id));
}).pipe(Effect.provide(TarantoolDbLive));

BunRuntime.runMain(program);
