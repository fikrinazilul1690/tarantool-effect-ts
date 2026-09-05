import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import {
  HttpEffect,
  HttpRouter,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";
import { RateLimiter } from "effect/unstable/persistence";
import { BetterAuth } from "../../infrastructure/auth/better-auth";
import { AppConfig } from "../../infrastructure/config";
import { ApiAuthorizationLive } from "./auth-middleware";
import { Api } from "./api";
import { SystemHandlers, UsersHandlers } from "./handlers";
import { RequestSchemaErrorLive } from "./schema-error-middleware";
import { ApiRateLimitLive } from "./rate-limit-middleware";

const ApiRoutes = HttpApiBuilder.layer(Api, {
  openapiPath: "/openapi.json",
}).pipe(
  Layer.provide(
    Layer.mergeAll(SystemHandlers, UsersHandlers).pipe(
      Layer.provide(ApiAuthorizationLive),
    ),
  ),
  Layer.provide(RequestSchemaErrorLive),
  Layer.provide(ApiRateLimitLive),
);

// Better Auth owns its public protocol, while application endpoints are
// schema-first Effect HttpApi routes.
const BetterAuthRoutes = Layer.unwrap(
  Effect.map(BetterAuth, (auth) =>
    HttpRouter.add("*", "/api/auth/*", HttpEffect.fromWebHandler(auth.handler)),
  ),
);

const Routes = Layer.mergeAll(
  ApiRoutes,
  BetterAuthRoutes,
  HttpApiScalar.layer(Api, {
    path: "/docs",
    scalar: {layout: "modern"},
  }),
);

export const HttpServerLive = Layer.unwrap(
  Effect.map(AppConfig, ({ http }) =>
    HttpRouter.serve(Routes, {
      middleware: (request) =>
        request.pipe(
          Effect.timeoutOrElse({
            duration: http.requestTimeoutMs,
            orElse: () =>
              Effect.succeed(
                HttpServerResponse.jsonUnsafe(
                  {
                    success: false,
                    error: {
                      code: "REQUEST_TIMEOUT",
                      message: "Request deadline exceeded",
                    },
                  },
                  { status: 504 },
                ),
              ),
          }),
        ),
    }).pipe(
      Layer.provide(
        BunHttpServer.layer({
          port: http.port,
          gracefulShutdownTimeout: http.gracefulShutdownMs,
        }),
      ),
    ),
  ),
).pipe(
  Layer.provide(
    RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)),
  ),
);
