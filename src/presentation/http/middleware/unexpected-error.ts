import { Effect } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

export const withUnexpectedErrorResponse = <E, R>(
  httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  httpEffect.pipe(
    Effect.catchDefect((defect) =>
      Effect.logError("Unhandled HTTP request defect", defect).pipe(
        Effect.as(
          HttpServerResponse.jsonUnsafe(
            {
              success: false,
              error: {
                code: "INTERNAL_SERVER_ERROR",
                message: "An unexpected error occurred",
              },
            },
            { status: 500 },
          ),
        ),
      ),
    ),
  );

export const UnexpectedErrorLive = HttpRouter.middleware(
  withUnexpectedErrorResponse,
  { global: true },
);
