import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { UserRepository } from "../../domain/user/repository";
import { TarantoolDb } from "../../infrastructure/tarantool/client";
import { Api } from "./api";
import {
  HealthSuccess,
  ListUsersSuccess,
  MetricsSuccess,
  errorResponse,
} from "./schemas";
import { CurrentIdentity } from "./middleware";

export const SystemHandlers = HttpApiBuilder.group(
  Api,
  "system",
  Effect.fn(function* (handlers) {
    const db = yield* TarantoolDb;
    return handlers
      .handle("health", () =>
        Effect.succeed(
          HealthSuccess.make({
            data: {
              status: "ok" as const,
              runtime: "Effect v4 HttpApi + BunPlatform",
            },
          }),
        ),
      )
      .handle("metrics", () =>
        db.status.pipe(
          Effect.map((routers) =>
            MetricsSuccess.make({ data: { routers: [...routers] } }),
          ),
        ),
      );
  }),
);

export const UsersHandlers = HttpApiBuilder.group(
  Api,
  "users",
  Effect.fn(function* (handlers) {
    const users = yield* UserRepository;
    return handlers.handle("listUsers", ({ query }) =>
      Effect.gen(function* () {
        const limit = query.limit ?? 20;
        const identity = yield* CurrentIdentity;
        yield* Effect.logInfo(identity);
        return yield* users.list(
          { age: query.age, createdAt: query.createdAt },
          query.cursor ?? null,
          limit,
        ).pipe(
          Effect.map((page) => ListUsersSuccess.make({ data: page })),
          Effect.mapError(() =>
            errorResponse("DATABASE_ERROR", "Unable to list users"),
          ),
        );
      }),
    );
  }),
);
