import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import {
  UserCursorPageSchema,
  UserSchema,
  type UserCursorPage,
} from "../src/domain/user/model";
import { AppConfigLive } from "../src/infrastructure/config";
import { BetterAuth, BetterAuthLive } from "../src/infrastructure/auth/better-auth";
import { EmailLive } from "../src/infrastructure/email/smtp-email";
import {
  TarantoolDb,
  TarantoolDbLive,
  TarantoolError,
  makeTarantoolDbLayer,
  parseRouters,
} from "../src/infrastructure/tarantool/client";

const runDb = <A, E>(effect: Effect.Effect<A, E, TarantoolDb>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(TarantoolDbLive), Effect.provide(AppConfigLive)),
  );

test("CRUD travels through the vshard router", () =>
  runDb(
    Effect.gen(function* () {
      const db = yield* TarantoolDb;
      const id = Date.now();
      const created = yield* db.call(UserSchema, "api.user_create", {
        id,
        email: `smoke-${id}@example.com`,
        name: "Smoke",
        age: 1,
      });
      expect(created).toBeInstanceOf(UserSchema);
      expect(created.id).toBe(id);
      expect((yield* db.call(UserSchema, "api.user_get", id)).name).toBe(
        "Smoke",
      );
      expect(
        (yield* db.call(UserSchema, "api.user_update", id, { age: 2 })).age,
      ).toBe(2);
      expect((yield* db.call(UserSchema, "api.user_delete", id)).id).toBe(id);
      expect(
        yield* db.call(Schema.NullOr(UserSchema), "api.user_get", id),
      ).toBeNull();
    }),
  ));

test("logical cursor pagination traverses all shards without duplicates", () =>
  runDb(
    Effect.gen(function* () {
      const db = yield* TarantoolDb;
      const seed = Date.now() + 10_000;
      const expectedIds: number[] = [];
      for (let offset = 0; offset < 5; offset += 1) {
        const id = seed + offset;
        expectedIds.push(id);
        yield* db.call(UserSchema, "api.user_create", {
          id,
          email: `cursor-${id}@example.com`,
          name: `Cursor ${offset}`,
          age: 20,
        });
      }

      let cursor: string | null = null;
      const seenIds: number[] = [];
      let expectedPage = 1;
      do {
        const page: UserCursorPage = yield* db.call(
          UserCursorPageSchema,
          "api.users_page",
          cursor,
          17,
        );
        expect(page.currentPage).toBe(expectedPage);
        expect(page.totalPage).not.toBeNull();
        expect(page.totalPage ?? 0).toBeGreaterThanOrEqual(page.currentPage);
        seenIds.push(...page.items.map(({ id }) => id));
        cursor = page.next_cursor;
        if (cursor !== null) {
          expect(cursor).toMatch(/^u1:\d+:\d+:\d+$/);
        }
        expectedPage += 1;
      } while (cursor !== null);

      expect(new Set(seenIds).size).toBe(seenIds.length);
      for (const id of expectedIds) expect(seenIds).toContain(id);
    }),
  ));

test("default cursor preserves users with the same creation timestamp", () =>
  runDb(
    Effect.gen(function* () {
      const db = yield* TarantoolDb;
      const createdAt = Date.now() + 100_000;
      const seed = createdAt + 100_000;
      const expectedIds = Array.from({length: 4}, (_, offset) => seed + offset);

      for (const id of expectedIds) {
        yield* db.call(UserSchema, "api.user_create", {
          id,
          email: `created-cursor-${id}@example.com`,
          name: `Created cursor ${id}`,
          age: 30,
          created_at: createdAt,
        });
      }

      let cursor: string | null = `u1:${createdAt}:0:1`;
      const seenIds: number[] = [];
      while (cursor !== null && seenIds.length < expectedIds.length) {
        const page: UserCursorPage = yield* db.call(
          UserCursorPageSchema,
          "api.users_page",
          cursor,
          2,
        );
        expect(page.items.every((user) => user.created_at === createdAt)).toBe(true);
        seenIds.push(...page.items.map((user) => user.id));

        if (page.next_cursor !== null) {
          const last = page.items.at(-1);
          expect(last).toBeDefined();
          expect(page.next_cursor).toMatch(
            new RegExp(`^u1:${createdAt}:${last?.id}:\\d+$`),
          );
        }
        cursor = page.next_cursor;
      }

      expect(seenIds).toEqual(expectedIds);
      expect(new Set(seenIds).size).toBe(expectedIds.length);
    }),
  ));

test("one list API filters by exact age", () =>
  runDb(
    Effect.gen(function* () {
      const db = yield* TarantoolDb;
      const exactAge = Date.now() + 500_000;
      const seed = exactAge + 100_000;
      const expectedIds = Array.from({length: 5}, (_, offset) => seed + offset);

      for (const id of expectedIds) {
        yield* db.call(UserSchema, "api.user_create", {
          id,
          email: `age-cursor-${id}@example.com`,
          name: `Age cursor ${id}`,
          age: exactAge,
        });
      }

      let cursor: string | null = null;
      let filterBoundCursor: string | null = null;
      const seenIds: number[] = [];
      while (cursor !== null || seenIds.length === 0) {
        const page: UserCursorPage = yield* db.call(
          UserCursorPageSchema,
          "api.users_page",
          cursor,
          2,
          exactAge,
          null,
        );
        expect(page.items.every((user) => user.age === exactAge)).toBe(true);
        expect(page.totalPage).toBeNull();
        seenIds.push(...page.items.map((user) => user.id));

        if (page.next_cursor !== null) {
          filterBoundCursor ??= page.next_cursor;
          const last = page.items.at(-1);
          expect(last).toBeDefined();
          expect(page.next_cursor).toMatch(
            new RegExp(`^ua1:${exactAge}:${last?.id}:\\d+$`),
          );
        }
        cursor = page.next_cursor;
      }

      expect(seenIds).toEqual(expectedIds);
      expect(new Set(seenIds).size).toBe(expectedIds.length);
      expect(filterBoundCursor).not.toBeNull();
      const mismatchedFilter = yield* db.call(
        UserCursorPageSchema,
        "api.users_page",
        filterBoundCursor,
        2,
        exactAge + 1,
        null,
      ).pipe(Effect.exit);
      expect(mismatchedFilter._tag).toBe("Failure");
    }),
  ));

test("one list API filters by exact creation timestamp", () =>
  runDb(
    Effect.gen(function* () {
      const db = yield* TarantoolDb;
      const createdAt = Date.now() + 900_000;
      const seed = createdAt + 100_000;
      const expectedIds = Array.from({length: 5}, (_, offset) => seed + offset);

      for (const [offset, id] of expectedIds.entries()) {
        yield* db.call(UserSchema, "api.user_create", {
          id,
          email: `created-filter-${id}@example.com`,
          name: `Created filter ${id}`,
          age: 40 + offset,
          created_at: createdAt,
        });
      }

      let cursor: string | null = null;
      const seenIds: number[] = [];
      do {
        const page: UserCursorPage = yield* db.call(
          UserCursorPageSchema,
          "api.users_page",
          cursor,
          2,
          null,
          createdAt,
        );
        expect(page.items.every((user) => user.created_at === createdAt)).toBe(true);
        expect(page.totalPage).toBeNull();
        seenIds.push(...page.items.map((user) => user.id));
        cursor = page.next_cursor;
        if (cursor !== null) {
          expect(cursor).toMatch(new RegExp(`^uc1:${createdAt}:\\d+:\\d+$`));
        }
      } while (cursor !== null);

      expect(seenIds).toEqual(expectedIds);
    }),
  ));

test("one list API combines exact age and creation timestamp filters", () =>
  runDb(
    Effect.gen(function* () {
      const db = yield* TarantoolDb;
      const age = Date.now() + 1_300_000;
      const createdAt = Date.now() + 1_400_000;
      const seed = createdAt + 100_000;
      const expectedIds = Array.from({length: 5}, (_, offset) => seed + offset);

      for (const id of expectedIds) {
        yield* db.call(UserSchema, "api.user_create", {
          id,
          email: `combined-filter-${id}@example.com`,
          name: `Combined filter ${id}`,
          age,
          created_at: createdAt,
        });
      }
      yield* db.call(UserSchema, "api.user_create", {
        id: seed + 10,
        email: `combined-age-decoy-${seed}@example.com`,
        name: "Combined age decoy",
        age: age + 1,
        created_at: createdAt,
      });
      yield* db.call(UserSchema, "api.user_create", {
        id: seed + 11,
        email: `combined-created-decoy-${seed}@example.com`,
        name: "Combined created decoy",
        age,
        created_at: createdAt + 1,
      });

      let cursor: string | null = null;
      const seenIds: number[] = [];
      do {
        const page: UserCursorPage = yield* db.call(
          UserCursorPageSchema,
          "api.users_page",
          cursor,
          2,
          age,
          createdAt,
        );
        expect(page.items.every(
          (user) => user.age === age && user.created_at === createdAt,
        )).toBe(true);
        expect(page.totalPage).toBeNull();
        seenIds.push(...page.items.map((user) => user.id));
        cursor = page.next_cursor;
        if (cursor !== null) {
          expect(cursor).toMatch(
            new RegExp(`^uac1:${age}:${createdAt}:\\d+:\\d+$`),
          );
        }
      } while (cursor !== null);

      expect(seenIds).toEqual(expectedIds);
    }),
  ));

test("Better Auth token lookup and mutation use indexed cluster paths", () =>
  runDb(
    Effect.gen(function* () {
      const db = yield* TarantoolDb;
      const suffix = `${Date.now()}`;
      const id = `session-${suffix}`;
      const token = `token-${suffix}`;
      const userId = `user-${suffix}`;
      const record = { id, token, userId, expiresAt: Date.now() + 60_000 };

      const created = yield* db.call(
        Schema.Record(Schema.String, Schema.Unknown),
        "api.auth_create",
        "session",
        record,
      );
      const found = yield* db.call(
        Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
        "api.auth_find_many",
        "session",
        [{ field: "token", value: token }],
        1,
        0,
        null,
      );
      expect(found).toHaveLength(1);
      expect(found[0]?.id).toBe(created.id);

      const updated = yield* db.call(
        Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
        "api.auth_update",
        "session",
        [{ field: "token", value: token }],
        { ipAddress: "127.0.0.1" },
      );
      expect(updated?.ipAddress).toBe("127.0.0.1");
      expect(
        yield* db.call(Schema.Number, "api.auth_count", "session", [
          { field: "userId", value: userId },
        ]),
      ).toBe(1);

      yield* db.call(Schema.Boolean, "api.auth_delete", "session", [
        { field: "id", value: created.id },
      ]);
    }),
  ));

test("Better Auth user email is globally unique after normalization", () =>
  runDb(
    Effect.gen(function* () {
      const db = yield* TarantoolDb;
      const suffix = `${Date.now()}-${crypto.randomUUID()}`;
      const recordSchema = Schema.Record(Schema.String, Schema.Unknown);
      const email = `uniqueness-${suffix}@example.com`;
      const emailWhere = [{ field: "email", value: email }];

      const attempts = yield* Effect.all([
        Effect.result(db.call(recordSchema, "api.auth_create", "user", {
          id: `email-race-a-${suffix}`,
          email: `  ${email.toUpperCase()}  `,
          name: "Email Race A",
          emailVerified: false,
        })),
        Effect.result(db.call(recordSchema, "api.auth_create", "user", {
          id: `email-race-b-${suffix}`,
          email,
          name: "Email Race B",
          emailVerified: false,
        })),
      ], { concurrency: 2 });

      expect(attempts.filter(({ _tag }) => _tag === "Success")).toHaveLength(1);
      expect(attempts.filter(({ _tag }) => _tag === "Failure")).toHaveLength(1);
      expect(yield* db.call(Schema.Number, "api.auth_count", "user", emailWhere)).toBe(1);

      const winner = attempts.find(({ _tag }) => _tag === "Success");
      if (winner?._tag !== "Success") return;
      const id = winner.success.id;
      expect(id).toMatch(/^b\d+_/);
      const byId = yield* db.call(
        Schema.Array(recordSchema),
        "api.auth_find_many",
        "user",
        [{ field: "id", value: id }],
        1,
        0,
        null,
      );
      expect(byId[0]?.id).toBe(id);

      const moved = yield* Effect.result(db.call(
        Schema.NullOr(recordSchema),
        "api.auth_update",
        "user",
        [{ field: "id", value: id }],
        { email: `different-${email}` },
      ));
      expect(moved._tag).toBe("Failure");
      yield* db.call(Schema.Boolean, "api.auth_delete", "user", [{ field: "id", value: id }]);
    }),
  ));

test("Better Auth session tokens are globally unique", () =>
  runDb(Effect.gen(function* () {
    const db = yield* TarantoolDb;
    const suffix = `${Date.now()}-${crypto.randomUUID()}`;
    const token = `session-token-${suffix}`;
    const recordSchema = Schema.Record(Schema.String, Schema.Unknown);
    const attempts = yield* Effect.all([
      Effect.result(db.call(recordSchema, "api.auth_create", "session", {
        id: `session-a-${suffix}`,
        token,
        userId: `user-a-${suffix}`,
        expiresAt: Date.now() + 60_000,
      })),
      Effect.result(db.call(recordSchema, "api.auth_create", "session", {
        id: `session-b-${suffix}`,
        token,
        userId: `user-b-${suffix}`,
        expiresAt: Date.now() + 60_000,
      })),
    ], { concurrency: 2 });

    expect(attempts.filter(({ _tag }) => _tag === "Success")).toHaveLength(1);
    expect(attempts.filter(({ _tag }) => _tag === "Failure")).toHaveLength(1);
    expect(yield* db.call(Schema.Number, "api.auth_count", "session", [
      { field: "token", value: token },
    ])).toBe(1);

    const winner = attempts.find(({ _tag }) => _tag === "Success");
    if (winner?._tag !== "Success") return;
    const changedToken = yield* Effect.result(db.call(
      Schema.NullOr(recordSchema),
      "api.auth_update",
      "session",
      [{ field: "id", value: winner.success.id }],
      { token: `${token}-changed` },
    ));
    expect(changedToken._tag).toBe("Failure");
    yield* db.call(Schema.Boolean, "api.auth_delete", "session", [
      { field: "id", value: winner.success.id },
    ]);
  })));

test("Better Auth provider accounts are globally unique by provider and account", () =>
  runDb(Effect.gen(function* () {
    const db = yield* TarantoolDb;
    const suffix = `${Date.now()}-${crypto.randomUUID()}`;
    const recordSchema = Schema.Record(Schema.String, Schema.Unknown);
    const createAccount = (id: string, providerId: string, accountId: string, userId: string) =>
      db.call(recordSchema, "api.auth_create", "account", { id, providerId, accountId, userId });

    const raced = yield* Effect.all([
      Effect.result(createAccount(`account-a-${suffix}`, "github", suffix, `user-a-${suffix}`)),
      Effect.result(createAccount(`account-b-${suffix}`, "github", suffix, `user-b-${suffix}`)),
    ], { concurrency: 2 });
    expect(raced.filter(({ _tag }) => _tag === "Success")).toHaveLength(1);
    expect(raced.filter(({ _tag }) => _tag === "Failure")).toHaveLength(1);

    const otherProvider = yield* createAccount(
      `account-c-${suffix}`, "google", suffix, `user-c-${suffix}`);
    const otherAccount = yield* createAccount(
      `account-d-${suffix}`, "github", `${suffix}-other`, `user-d-${suffix}`);
    expect(otherProvider.id).toMatch(/^b\d+_/);
    expect(otherAccount.id).toMatch(/^b\d+_/);

    const winner = raced.find(({ _tag }) => _tag === "Success");
    const ids = [otherProvider.id, otherAccount.id];
    if (winner?._tag === "Success") ids.push(winner.success.id);
    for (const id of ids) {
      yield* db.call(Schema.Boolean, "api.auth_delete", "account", [{ field: "id", value: id }]);
    }
  })));

test("Better Auth verification identifiers are co-located but may have multiple values", () =>
  runDb(Effect.gen(function* () {
    const db = yield* TarantoolDb;
    const suffix = `${Date.now()}-${crypto.randomUUID()}`;
    const identifier = `verify-${suffix}`;
    const recordSchema = Schema.Record(Schema.String, Schema.Unknown);
    const firstCreatedAt = new Date(Date.now() - 1_000).toISOString();
    const secondCreatedAt = new Date().toISOString();
    const first = yield* db.call(recordSchema, "api.auth_create", "verification", {
      id: `verification-a-${suffix}`,
      identifier,
      value: "first",
      expiresAt: Date.now() + 60_000,
      createdAt: firstCreatedAt,
    });
    const second = yield* db.call(recordSchema, "api.auth_create", "verification", {
      id: `verification-b-${suffix}`,
      identifier,
      value: "second",
      expiresAt: Date.now() + 60_000,
      createdAt: secondCreatedAt,
    });

    const firstId = String(first.id);
    const secondId = String(second.id);
    expect(firstId.match(/^b(\d+)_/)?.[1]).toBe(secondId.match(/^b(\d+)_/)?.[1]);
    expect(yield* db.call(Schema.Number, "api.auth_count", "verification", [
      { field: "identifier", value: identifier },
    ])).toBe(2);
    const latest = yield* db.call(Schema.Array(recordSchema), "api.auth_find_many", "verification", [
      { field: "identifier", value: identifier },
    ], 1, 0, { field: "createdAt", direction: "desc" });
    expect(latest[0]?.value).toBe("second");
    for (const id of [firstId, secondId]) {
      yield* db.call(Schema.Boolean, "api.auth_delete", "verification", [{ field: "id", value: id }]);
    }
  })));

test("Better Auth signup creates one user and its credential account", async () => {
  const suffix = `${Date.now()}-${crypto.randomUUID()}`;
  const email = `signup-${suffix}@example.com`;
  await Effect.runPromise(Effect.gen(function* () {
    const auth = yield* BetterAuth;
    const db = yield* TarantoolDb;
    const startedAt = performance.now();
    const response = yield* Effect.promise(() => auth.handler(new Request(
      "http://localhost:3000/api/auth/sign-up/email",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify({ name: "Signup Integration", email, password: "secure-password-123" }),
      },
    )));
    const requestDurationMs = performance.now() - startedAt;
    expect(response.status).toBe(200);
    // SMTP is performed by the durable worker; the request waits only for the
    // Tarantool outbox acknowledgement.
    expect(requestDurationMs).toBeLessThan(1_000);
    const payload = (yield* Effect.promise(() => response.json())) as {
      success: boolean;
      data?: { user?: { id?: string; email?: string } };
    };
    expect(payload.success).toBe(true);
    expect(payload.data?.user?.id).toMatch(/^b\d+_/);
    expect(payload.data?.user?.email).toBe(email);

    const userId = payload.data?.user?.id;
    expect(yield* db.call(Schema.Number, "api.auth_count", "user", [
      { field: "email", value: email },
    ])).toBe(1);
    expect(yield* db.call(Schema.Number, "api.auth_count", "account", [
      { field: "userId", value: userId },
    ])).toBe(1);

    yield* db.call(Schema.Number, "api.auth_update_many", "account", [
      { field: "userId", value: userId },
    ], {}, true);
    yield* db.call(Schema.Boolean, "api.auth_delete", "user", [
      { field: "email", value: email },
    ]);
  }).pipe(
    Effect.provide(BetterAuthLive),
    Effect.provide(EmailLive),
    Effect.provide(TarantoolDbLive),
    Effect.provide(AppConfigLive),
  ));
}, 15_000);

test("email outbox durably leases, retries, reclaims, and acknowledges a job", () =>
  runDb(Effect.gen(function* () {
    const db = yield* TarantoolDb;
    const now = Date.now();
    const owner = `worker-${crypto.randomUUID()}`;
    const jobSchema = Schema.Struct({
      id: Schema.String,
      payload: Schema.Struct({
        kind: Schema.Literal("verification"),
        to: Schema.String,
        name: Schema.String,
        verificationUrl: Schema.String,
      }),
      attempts: Schema.Number,
    });
    const nullableJob = Schema.NullOr(jobSchema);
    const id = yield* db.call(Schema.String, "api.email_outbox_enqueue", {
      id: crypto.randomUUID(),
      payload: {
        kind: "verification",
        to: "outbox-test@example.com",
        name: "Outbox Test",
        verificationUrl: "https://example.com/verify/test-token",
      },
      created_at: now,
    });
    expect(id).toMatch(/^b\d+_/);

    const first = yield* db.call(nullableJob, "api.email_outbox_claim_one", id, owner, now, 5_000);
    expect(first?.attempts).toBe(1);
    expect(first?.payload.kind).toBe("verification");
    expect(yield* db.call(nullableJob, "api.email_outbox_claim_one", id, "other", now, 5_000))
      .toBeNull();

    const retryAt = now + 10_000;
    expect(yield* db.call(
      Schema.Boolean,
      "api.email_outbox_fail",
      id,
      owner,
      retryAt,
      3,
      "temporary SMTP failure",
      now,
    )).toBe(true);
    expect(yield* db.call(nullableJob, "api.email_outbox_claim_one", id, owner, retryAt - 1, 5_000))
      .toBeNull();

    const second = yield* db.call(nullableJob, "api.email_outbox_claim_one", id, owner, retryAt, 5_000);
    expect(second?.attempts).toBe(2);
    expect(yield* db.call(Schema.Boolean, "api.email_outbox_ack", id, owner)).toBe(true);
    expect(yield* db.call(Schema.Boolean, "api.email_outbox_ack", id, owner)).toBe(false);
  })));

test("client skips an unavailable router before sending a request", async () => {
  const layer = makeTarantoolDbLayer({
    routers: parseRouters("127.0.0.1:1,127.0.0.1:3301"),
    connectTimeoutMs: 250,
    circuitFailureThreshold: 1,
    circuitResetMs: 1_000,
  });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* TarantoolDb;
      yield* db.ping;
      return yield* db.status;
    }).pipe(Effect.provide(layer)),
  );

  expect(result).toHaveLength(2);
  expect(result[0]?.state).toBe("open");
  expect(result[0]?.failures).toBeGreaterThanOrEqual(1);
  expect(result[1]?.state).toBe("closed");
  expect(result[1]?.requests).toBeGreaterThanOrEqual(1);
  expect(result[1]?.reconnects).toBeGreaterThanOrEqual(1);
});

test("client classifies an unreachable router pool as unavailable", async () => {
  const layer = makeTarantoolDbLayer({
    routers: parseRouters("127.0.0.1:1"),
    connectTimeoutMs: 250,
  });
  let failure: unknown;
  try {
    await Effect.runPromise(TarantoolDb.pipe(Effect.provide(layer)));
  } catch (cause) {
    failure = cause;
  }

  expect(failure).toBeInstanceOf(TarantoolError);
  expect((failure as TarantoolError).kind).toBe("unavailable");
});
