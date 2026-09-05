import {BunRuntime} from '@effect/platform-bun';
import {Effect} from 'effect';
import {
  UserCursorPageSchema,
  UserSchema,
  type UserCursorPage,
} from '../src/domain/user/model';
import {AppConfigLive} from '../src/infrastructure/config';
import {TarantoolDb, TarantoolDbLive} from '../src/infrastructure/tarantool/client';

const program = Effect.gen(function*() {
  const db = yield* TarantoolDb;
  const seed = Date.now();
  for (let offset = 0; offset < 7; offset += 1) {
    const id = seed + offset;
    yield* db.call(UserSchema, 'api.user_create', {
      id, email: `page-${id}@example.com`, name: `Page User ${offset}`, age: 20 + offset,
    });
  }

  let cursor: string | null = null;
  let pageNumber = 1;
  do {
    const page: UserCursorPage = yield* db.call(UserCursorPageSchema, 'api.users_page', cursor, 10);
    yield* Effect.sync(() => console.dir({pageNumber, cursor, ...page}, {depth: null}));
    cursor = page.next_cursor;
    pageNumber += 1;
  } while (cursor !== null);

  let ageCursor: string | null = null;
  do {
    const page: UserCursorPage = yield* db.call(
      UserCursorPageSchema,
      'api.users_page',
      ageCursor,
      10,
      23,
      null,
    );
    yield* Effect.sync(() => console.dir({age: 23, ageCursor, ...page}, {depth: null}));
    ageCursor = page.next_cursor;
  } while (ageCursor !== null);
}).pipe(Effect.provide(TarantoolDbLive), Effect.provide(AppConfigLive));

BunRuntime.runMain(program);
