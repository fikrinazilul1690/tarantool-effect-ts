import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { HttpEffect, HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";
import { RateLimiter } from "effect/unstable/persistence";
import { BetterAuth } from "../../infrastructure/auth/better-auth";
import { AppConfig } from "../../infrastructure/config";
import { Api } from "./api";
import { SystemHandlers, UsersHandlers } from "./handlers";
import {
  ApiAuthorizationLive,
  ApiRateLimitLive,
  RequestSchemaErrorLive,
  RequestTimeoutLive,
  requestTimeoutResponse,
  withRequestTimeoutResponse,
} from "./middleware";

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
  Layer.provide(RequestTimeoutLive),
);

// Better Auth owns its public protocol, while application endpoints are
// schema-first Effect HttpApi routes.
const BetterAuthRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* BetterAuth;
    const { http } = yield* AppConfig;
    const authEffect = withRequestTimeoutResponse(
      HttpEffect.fromWebHandler(auth.handler),
      http.requestTimeoutMs,
      requestTimeoutResponse(),
    );
    return HttpRouter.add("*", "/api/auth/*", authEffect);
  }),
);

const Routes = Layer.mergeAll(
  ApiRoutes,
  BetterAuthRoutes,
  HttpApiScalar.layer(Api, {
    path: "/docs",
    scalar: { layout: "modern" },
  }),
);

export const HttpServerLive = Layer.unwrap(
  Effect.map(AppConfig, ({ http }) =>
    HttpRouter.serve(Routes).pipe(
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
