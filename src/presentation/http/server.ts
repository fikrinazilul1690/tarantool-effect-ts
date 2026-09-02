import {BunHttpServer} from '@effect/platform-bun';
import {Effect, Layer} from 'effect';
import {HttpEffect, HttpRouter, HttpServerResponse} from 'effect/unstable/http';
import {HttpApiBuilder} from 'effect/unstable/httpapi';
import {BetterAuth} from '../../infrastructure/auth/better-auth';
import {ApiAuthorizationLive} from './auth-middleware';
import {Api} from './api';
import {SystemHandlers, UsersHandlers} from './handlers';
import {RequestSchemaErrorLive} from './schema-error-middleware';

const ApiRoutes = HttpApiBuilder.layer(Api, {openapiPath: '/openapi.json'}).pipe(
  Layer.provide(
    Layer.mergeAll(SystemHandlers, UsersHandlers).pipe(
      Layer.provide(ApiAuthorizationLive),
    ),
  ),
  Layer.provide(RequestSchemaErrorLive),
);

// Better Auth owns its public protocol, while application endpoints are
// schema-first Effect HttpApi routes.
const BetterAuthRoutes = Layer.unwrap(
  Effect.map(BetterAuth, (auth) => HttpRouter.add(
    '*',
    '/api/auth/*',
    HttpEffect.fromWebHandler(auth.handler),
  )),
);

const Routes = Layer.mergeAll(ApiRoutes, BetterAuthRoutes);

const durationEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 100 || value > 300_000) {
    throw new Error(`${name} must be an integer between 100 and 300000`);
  }
  return value;
};

const databaseTimeoutMs = durationEnv('TARANTOOL_OPERATION_TIMEOUT_MS', 4_000);
const databaseDrainMs = durationEnv('TARANTOOL_SHUTDOWN_DRAIN_MS', 10_000);
const httpRequestTimeoutMs = durationEnv('HTTP_REQUEST_TIMEOUT_MS', 5_000);
const gracefulShutdownMs = durationEnv('HTTP_GRACEFUL_SHUTDOWN_MS', 15_000);

if (databaseTimeoutMs >= httpRequestTimeoutMs) {
  throw new Error('TARANTOOL_OPERATION_TIMEOUT_MS must be lower than HTTP_REQUEST_TIMEOUT_MS');
}
if (databaseDrainMs >= gracefulShutdownMs) {
  throw new Error('TARANTOOL_SHUTDOWN_DRAIN_MS must be lower than HTTP_GRACEFUL_SHUTDOWN_MS');
}

export const HttpServerLive = HttpRouter.serve(Routes, {
  middleware: (request) => request.pipe(
    Effect.timeoutOrElse({
      duration: httpRequestTimeoutMs,
      orElse: () => Effect.succeed(HttpServerResponse.jsonUnsafe({
        success: false,
        error: {code: 'REQUEST_TIMEOUT', message: 'Request deadline exceeded'},
      }, {status: 504})),
    }),
  ),
}).pipe(
  Layer.provide(BunHttpServer.layer({
    port: Number(process.env.PORT ?? 3000),
    gracefulShutdownTimeout: gracefulShutdownMs,
  })),
);
