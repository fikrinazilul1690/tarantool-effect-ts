import {expect, test} from 'bun:test';
import {Effect} from 'effect';
import {TarantoolDb, TarantoolDbLive} from '../src/db';
import type {CursorPage, User} from '../src/types';

const runDb = <A, E>(effect: Effect.Effect<A, E, TarantoolDb>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TarantoolDbLive)));

test('CRUD travels through the vshard router', () => runDb(Effect.gen(function*() {
  const db = yield* TarantoolDb;
  const id = Date.now();
  const created = yield* db.call<User>('api.user_create', {id, email: `smoke-${id}@example.com`, name: 'Smoke', age: 1});
  expect(created.id).toBe(id);
  expect((yield* db.call<User>('api.user_get', id)).name).toBe('Smoke');
  expect((yield* db.call<User>('api.user_update', id, {age: 2})).age).toBe(2);
  expect((yield* db.call<User>('api.user_delete', id)).id).toBe(id);
  expect(yield* db.call<User | null>('api.user_get', id)).toBeNull();
})));

test('fetch_pos pagination traverses all shards without duplicates', () => runDb(Effect.gen(function*() {
  const db = yield* TarantoolDb;
  const seed = Date.now() + 10_000;
  const expectedIds: number[] = [];
  for (let offset = 0; offset < 5; offset += 1) {
    const id = seed + offset;
    expectedIds.push(id);
    yield* db.call<User>('api.user_create', {
      id, email: `cursor-${id}@example.com`, name: `Cursor ${offset}`, age: 20,
    });
  }

  let cursor: string | null = null;
  const seenIds: number[] = [];
  do {
    const page: CursorPage<User> = yield* db.call<CursorPage<User>>('api.users_page', cursor, 17);
    seenIds.push(...page.items.map(({id}) => id));
    cursor = page.next_cursor;
  } while (cursor !== null);

  expect(new Set(seenIds).size).toBe(seenIds.length);
  for (const id of expectedIds) expect(seenIds).toContain(id);
})));
