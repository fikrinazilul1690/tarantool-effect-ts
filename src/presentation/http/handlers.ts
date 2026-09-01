import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { UserRepository } from "../../domain/user/repository";
import { Api } from "./api";
import { HealthSuccess, ListUsersSuccess, errorResponse } from "./schemas";

export const SystemHandlers = HttpApiBuilder.group(Api, "system", (handlers) =>
  handlers.handle("health", () =>
    Effect.succeed(HealthSuccess.make({
      data: {
        status: "ok" as const,
        runtime: "Effect v4 HttpApi + BunPlatform",
      },
    })),
  ),
);

export const UsersHandlers = HttpApiBuilder.group(
  Api,
  "users",
  Effect.fn(function* (handlers) {
    const users = yield* UserRepository;
    return handlers.handle("listUsers", ({ query }) => {
      const limit = query.limit ?? 20;
      return users
        .list(query.cursor ?? null, limit)
        .pipe(
          Effect.map((page) => ListUsersSuccess.make({ data: page })),
          Effect.mapError(() => errorResponse("DATABASE_ERROR", "Unable to list users")),
        );
    });
  }),
);
