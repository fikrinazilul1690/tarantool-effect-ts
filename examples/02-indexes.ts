import {BunRuntime} from '@effect/platform-bun';
import {Effect} from 'effect';
import {TarantoolDb, TarantoolDbLive} from '../src/db';
import type {User} from '../src/types';

const program = Effect.gen(function*() {
  const db = yield* TarantoolDb;
  const seed = Date.now();
  for (let offset = 0; offset < 8; offset += 1) {
    const id = seed + offset;
    yield* db.call<User>('api.user_create', {
      id, email: `learner-${id}@example.com`, name: `Learner ${offset}`, age: 18 + offset,
    });
  }
  yield* Effect.log(yield* db.call<User[]>('api.users_by_age', seed, 21, 10));
}).pipe(Effect.provide(TarantoolDbLive));

BunRuntime.runMain(program);
