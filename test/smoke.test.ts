import {expect, test} from 'bun:test';
import {Effect, Schema} from 'effect';
import {UserCursorPageSchema, UserSchema, type UserCursorPage} from '../src/domain/user/model';
import {
  TarantoolDb,
  TarantoolDbLive,
  TarantoolError,
  makeTarantoolDbLayer,
  parseRouters,
} from '../src/infrastructure/tarantool/client';

const runDb = <A, E>(effect: Effect.Effect<A, E, TarantoolDb>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TarantoolDbLive)));

test('CRUD travels through the vshard router', () => runDb(Effect.gen(function*() {
  const db = yield* TarantoolDb;
  const id = Date.now();
  const created = yield* db.call(UserSchema, 'api.user_create', {id, email: `smoke-${id}@example.com`, name: 'Smoke', age: 1});
  expect(created).toBeInstanceOf(UserSchema);
  expect(created.id).toBe(id);
  expect((yield* db.call(UserSchema, 'api.user_get', id)).name).toBe('Smoke');
  expect((yield* db.call(UserSchema, 'api.user_update', id, {age: 2})).age).toBe(2);
  expect((yield* db.call(UserSchema, 'api.user_delete', id)).id).toBe(id);
  expect(yield* db.call(Schema.NullOr(UserSchema), 'api.user_get', id)).toBeNull();
})));

test('logical cursor pagination traverses all shards without duplicates', () => runDb(Effect.gen(function*() {
  const db = yield* TarantoolDb;
  const seed = Date.now() + 10_000;
  const expectedIds: number[] = [];
  for (let offset = 0; offset < 5; offset += 1) {
    const id = seed + offset;
    expectedIds.push(id);
    yield* db.call(UserSchema, 'api.user_create', {
      id, email: `cursor-${id}@example.com`, name: `Cursor ${offset}`, age: 20,
    });
  }

  let cursor: string | null = null;
  const seenIds: number[] = [];
  let expectedPage = 1;
  do {
    const page: UserCursorPage = yield* db.call(UserCursorPageSchema, 'api.users_page', cursor, 17);
    expect(page.currentPage).toBe(expectedPage);
    expect(page.totalPage).toBeGreaterThanOrEqual(page.currentPage);
    expect(page.lastCursor).toBeNull();
    seenIds.push(...page.items.map(({id}) => id));
    cursor = page.next_cursor;
    if (cursor !== null) {
      expect(cursor).toMatch(/^v1:\d+:\d+$/);
    }
    expectedPage += 1;
  } while (cursor !== null);

  expect(new Set(seenIds).size).toBe(seenIds.length);
  for (const id of expectedIds) expect(seenIds).toContain(id);
})));

test('Better Auth token lookup and mutation use indexed cluster paths', () => runDb(Effect.gen(function*() {
  const db = yield* TarantoolDb;
  const suffix = `${Date.now()}`;
  const id = `session-${suffix}`;
  const token = `token-${suffix}`;
  const userId = `user-${suffix}`;
  const record = {id, token, userId, expiresAt: Date.now() + 60_000};

  yield* db.call(Schema.Record(Schema.String, Schema.Unknown),
    'api.auth_create', 'session', record);
  const found = yield* db.call(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
    'api.auth_find_many', 'session', [{field: 'token', value: token}], 1, 0, null);
  expect(found).toHaveLength(1);
  expect(found[0]?.id).toBe(id);

  const updated = yield* db.call(
    Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
    'api.auth_update', 'session', [{field: 'token', value: token}], {ipAddress: '127.0.0.1'});
  expect(updated?.ipAddress).toBe('127.0.0.1');
  expect(yield* db.call(Schema.Number, 'api.auth_count',
    'session', [{field: 'userId', value: userId}])).toBe(1);

  yield* db.call(Schema.Boolean, 'api.auth_delete',
    'session', [{field: 'id', value: id}]);
})));

test('client skips an unavailable router before sending a request', async () => {
  const layer = makeTarantoolDbLayer({
    routers: parseRouters('127.0.0.1:1,127.0.0.1:3301'),
    connectTimeoutMs: 250,
    circuitFailureThreshold: 1,
    circuitResetMs: 1_000,
  });
  const result = await Effect.runPromise(Effect.gen(function*() {
    const db = yield* TarantoolDb;
    yield* db.ping;
    return yield* db.status;
  }).pipe(Effect.provide(layer)));

  expect(result).toHaveLength(2);
  expect(result[0]?.state).toBe('open');
  expect(result[0]?.failures).toBeGreaterThanOrEqual(1);
  expect(result[1]?.state).toBe('closed');
  expect(result[1]?.requests).toBeGreaterThanOrEqual(1);
  expect(result[1]?.reconnects).toBeGreaterThanOrEqual(1);
});

test('client classifies an unreachable router pool as unavailable', async () => {
  const layer = makeTarantoolDbLayer({
    routers: parseRouters('127.0.0.1:1'),
    connectTimeoutMs: 250,
  });
  let failure: unknown;
  try {
    await Effect.runPromise(TarantoolDb.pipe(Effect.provide(layer)));
  } catch (cause) {
    failure = cause;
  }

  expect(failure).toBeInstanceOf(TarantoolError);
  expect((failure as TarantoolError).kind).toBe('unavailable');
});
