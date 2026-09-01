import {BunRuntime} from '@effect/platform-bun';
import {Effect} from 'effect';
import {TarantoolDb, TarantoolDbLive} from '../src/db';
import type {CursorPage, User} from '../src/types';

const program = Effect.gen(function*() {
  const db = yield* TarantoolDb;
  const seed = Date.now();
  for (let offset = 0; offset < 7; offset += 1) {
    const id = seed + offset;
    yield* db.call<User>('api.user_create', {
      id, email: `page-${id}@example.com`, name: `Page User ${offset}`, age: 20 + offset,
    });
  }

  let cursor: string | null = null;
  let pageNumber = 1;
  do {
    const page: CursorPage<User> = yield* db.call<CursorPage<User>>('api.users_page', cursor, 10);
    yield* Effect.sync(() => console.dir({pageNumber, cursor, ...page}, {depth: null}));
    cursor = page.next_cursor;
    pageNumber += 1;
  } while (cursor !== null);
}).pipe(Effect.provide(TarantoolDbLive));

BunRuntime.runMain(program);
