import {BunHttpServer, BunRuntime} from '@effect/platform-bun';
import {Effect, Layer} from 'effect';
import {HttpEffect, HttpRouter} from 'effect/unstable/http';
import {HttpApiBuilder} from 'effect/unstable/httpapi';
import {Api} from './api/api';
import {SystemHandlers, UsersHandlers} from './api/handlers';
import {RequestSchemaErrorLive} from './api/schema-error-middleware';
import {BetterAuth, BetterAuthLive} from './auth/auth';
import {TarantoolDbLive} from './db';
import {EmailLive} from './email';

const ApiRoutes = HttpApiBuilder.layer(Api, {openapiPath: '/openapi.json'}).pipe(
  Layer.provide([SystemHandlers, UsersHandlers]),
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

const HttpLive = HttpRouter.serve(Routes).pipe(
  Layer.provide(BunHttpServer.layer({port: Number(process.env.PORT ?? 3000)})),
  Layer.provide(BetterAuthLive),
  Layer.provide(EmailLive),
  Layer.provide(TarantoolDbLive),
);

Layer.launch(HttpLive).pipe(BunRuntime.runMain);
