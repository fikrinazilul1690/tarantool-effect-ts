import {BunHttpServer} from '@effect/platform-bun';
import {Effect, Layer} from 'effect';
import {HttpEffect, HttpRouter} from 'effect/unstable/http';
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

export const HttpServerLive = HttpRouter.serve(Routes).pipe(
  Layer.provide(BunHttpServer.layer({port: Number(process.env.PORT ?? 3000)})),
);
