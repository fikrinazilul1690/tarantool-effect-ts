import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  OpenApi,
} from "effect/unstable/httpapi";
import { ApiAuthorization } from "./auth-middleware";
import { RequestSchemaError } from "./schema-error-middleware";
import {
  HealthSuccess,
  InternalErrorResponse,
  ListUsersSuccess,
} from "./schemas";

export class SystemApi extends HttpApiGroup.make("system", {
  topLevel: true,
}).add(
  HttpApiEndpoint.get("health", "/health", {
    success: HealthSuccess,
  }),
) { }

export class UsersApi extends HttpApiGroup.make("users")
  .add(
    HttpApiEndpoint.get("listUsers", "/api/users", {
      query: {
        limit: Schema.optional(
          Schema.NumberFromString.check(
            Schema.isInt(),
            Schema.isGreaterThan(0),
            Schema.isLessThanOrEqualTo(100),
          ),
        ),
        cursor: Schema.optional(Schema.String),
      },
      success: ListUsersSuccess,
      error: InternalErrorResponse,
    }),
  )
  .middleware(ApiAuthorization) { }

export class Api extends HttpApi.make("learn-tarantool-api")
  .add(SystemApi)
  .add(UsersApi)
  .middleware(RequestSchemaError)
  .annotateMerge(
    OpenApi.annotations({
      title: "Learn Tarantool API",
      version: "1.0.0",
      description:
        "Effect v4 HttpApi backed by Tarantool vshard and Better Auth bearer authentication.",
    }),
  ) { }
