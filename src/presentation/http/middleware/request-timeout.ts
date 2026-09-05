import { Effect, Layer } from "effect";
import { HttpApiMiddleware } from "effect/unstable/httpapi";
import { AppConfig } from "../../../infrastructure/config";
import { HttpServerResponse } from "effect/unstable/http";
import { RequestTimeoutResponse, errorResponse } from "../schemas";

export const requestTimeoutResponse = () => HttpServerResponse.jsonUnsafe({
  success: false,
  error: { code: "REQUEST_TIMEOUT", message: "Request deadline exceeded" },
}, { status: 504 });

export const withRequestTimeoutResponse = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  duration: number,
  response: A,
): Effect.Effect<A, E, R> => effect.pipe(
  Effect.timeoutOrElse({
    duration,
    orElse: () => Effect.succeed(response),
  }),
);

export class RequestTimeout extends HttpApiMiddleware.Service<
  RequestTimeout,
  { requires: AppConfig }
>()("learn-tarantool/api/RequestTimeout", { error: RequestTimeoutResponse }) { }

export const RequestTimeoutLive = Layer.effect(
  RequestTimeout,
  Effect.gen(function* () {
    const { http } = yield* AppConfig;
    return RequestTimeout.of((httpEffect) =>
      httpEffect.pipe(
        Effect.timeoutOrElse({
          duration: http.requestTimeoutMs,
          orElse: () => Effect.fail(
            errorResponse("REQUEST_TIMEOUT", "Request deadline exceeded"),
          ),
        }),
      ),
    );
  }),
);
