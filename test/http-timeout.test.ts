import {expect, test} from 'bun:test';
import {Effect, Layer} from 'effect';
import {HttpServerResponse} from 'effect/unstable/http';
import {AppConfig, type AppConfigShape} from '../src/infrastructure/config';
import {
  RequestTimeout,
  RequestTimeoutLive,
} from '../src/presentation/http/middleware/request-timeout';

test('RequestTimeout returns a typed 504 error when the handler exceeds its deadline', async () => {
  const config = {
    http: {
      port: 3000,
      requestTimeoutMs: 20,
      gracefulShutdownMs: 1_000,
      rateLimitPerWindow: 1_000,
      rateLimitWindowMs: 1_000,
    },
  } as unknown as AppConfigShape;

  const result = await Effect.runPromise(
    Effect.gen(function*() {
      const timeout = yield* RequestTimeout;
      const applyTimeout = timeout as unknown as (
        effect: Effect.Effect<any>
      ) => Effect.Effect<any, unknown>;
      return yield* Effect.result(applyTimeout(
        Effect.sleep('100 millis').pipe(
          Effect.as(HttpServerResponse.empty()),
        ),
      ));
    }).pipe(
      Effect.provide(RequestTimeoutLive),
      Effect.provide(Layer.succeed(AppConfig, config)),
    ),
  );

  expect(result._tag).toBe('Failure');
  if (result._tag === 'Failure') {
    expect(result.failure).toEqual({
      success: false,
      error: {
        code: 'REQUEST_TIMEOUT',
        message: 'Request deadline exceeded',
      },
    });
  }
});
