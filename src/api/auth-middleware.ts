import {Context, Effect, Layer, Redacted} from 'effect';
import {HttpApiMiddleware, HttpApiSecurity} from 'effect/unstable/httpapi';
import {BetterAuth} from '../auth/auth';
import {UnauthorizedResponse, errorResponse} from './schemas';

export interface AuthenticatedIdentity {
  readonly user: {
    readonly id: string;
    readonly name: string;
    readonly email: string;
  };
  readonly session: {
    readonly id: string;
    readonly token: string;
    readonly userId: string;
  };
}

export class CurrentIdentity extends Context.Service<CurrentIdentity, AuthenticatedIdentity>()(
  'learn-tarantool/api/CurrentIdentity',
) {}

export class ApiAuthorization extends HttpApiMiddleware.Service<ApiAuthorization, {
  provides: CurrentIdentity;
  requires: BetterAuth;
}>()('learn-tarantool/api/Authorization', {
  requiredForClient: true,
  security: {bearer: HttpApiSecurity.bearer},
  error: UnauthorizedResponse,
}) {}

export const ApiAuthorizationLive = Layer.effect(
  ApiAuthorization,
  Effect.gen(function*() {
    const auth = yield* BetterAuth;
    return ApiAuthorization.of({
      bearer: Effect.fn(function*(httpEffect, {credential}) {
        const token = Redacted.value(credential);
        const identity = yield* Effect.promise(() =>
          auth.getSession(new Headers({authorization: `Bearer ${token}`})).catch(() => null));
        if (identity === null) {
          return yield* Effect.fail(errorResponse(
            'UNAUTHORIZED',
            'Missing, expired, or invalid bearer token',
          ));
        }
        return yield* Effect.provideService(
          httpEffect,
          CurrentIdentity,
          CurrentIdentity.of(identity),
        );
      }),
    });
  }),
);
