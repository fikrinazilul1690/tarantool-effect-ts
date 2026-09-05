import { Effect, Layer } from "effect";
import { HttpApiMiddleware } from "effect/unstable/httpapi";
import { RateLimiter } from "effect/unstable/persistence";
import { AppConfig } from "../../../infrastructure/config";
import { RateLimitedResponse, errorResponse } from "../schemas";

export class ApiRateLimit extends HttpApiMiddleware.Service<
  ApiRateLimit,
  { requires: AppConfig | RateLimiter.RateLimiter }
>()("learn-tarantool/api/RateLimit", { error: RateLimitedResponse }) { }

export const ApiRateLimitLive = Layer.effect(
  ApiRateLimit,
  Effect.gen(function* () {
    const { http } = yield* AppConfig;
    const limiter = yield* RateLimiter.RateLimiter;
    return ApiRateLimit.of((httpEffect) =>
      limiter
        .consume({
          algorithm: "token-bucket",
          onExceeded: "fail",
          key: "http:api",
          limit: http.rateLimitPerWindow,
          tokens: 1,
          window: `${http.rateLimitWindowMs} millis`,
        })
        .pipe(
          // Map only RateLimiter.consume failures. Errors from authorization or
          // endpoint handlers must pass through unchanged.
          Effect.mapError(() =>
            errorResponse("RATE_LIMITED", "Too many requests")
          ),
          Effect.flatMap(() => httpEffect),
        ),
    );
  }),
);
