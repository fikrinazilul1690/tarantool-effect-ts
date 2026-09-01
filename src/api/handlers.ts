import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { TarantoolDb } from "../db";
import type { CursorPage, User } from "../types";
import { Api } from "./api";
import { ApiAuthorizationLive } from "./auth-middleware";
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

const UsersHandlersNoDeps = HttpApiBuilder.group(
  Api,
  "users",
  Effect.fn(function* (handlers) {
    const db = yield* TarantoolDb;
    return handlers.handle("listUsers", ({ query }) => {
      const limit = query.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return Effect.fail(
          errorResponse(
            "INVALID_LIMIT",
            "limit must be an integer between 1 and 100",
          ),
        );
      }
      return db
        .call<CursorPage<User>>("api.users_page", query.cursor ?? null, limit)
        .pipe(
          Effect.map((page) => ListUsersSuccess.make({ data: page })),
          Effect.mapError((e) => {
            console.log(e);
            return errorResponse("DATABASE_ERROR", "Unable to list users");
          }),
        );
    });
  }),
);

export const UsersHandlers = UsersHandlersNoDeps.pipe(
  Layer.provide(ApiAuthorizationLive),
);
