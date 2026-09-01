import {betterAuth} from 'better-auth/minimal';
import {bearer} from 'better-auth/plugins/bearer';
import {Context, Effect, Layer} from 'effect';
import {TarantoolDb} from '../db';
import {tarantoolAdapter} from './tarantool-adapter';

export interface AuthSession {
  readonly user: {readonly id: string; readonly name: string; readonly email: string};
  readonly session: {readonly id: string; readonly token: string; readonly userId: string};
}

interface Auth {
  readonly handler: (request: Request) => Promise<Response>;
  readonly getSession: (headers: Headers) => Promise<AuthSession | null>;
}

export class BetterAuth extends Context.Service<BetterAuth, Auth>()(
  'learn-tarantool/BetterAuth',
) {}

export const BetterAuthLive = Layer.effect(
  BetterAuth,
  Effect.gen(function*() {
    const db = yield* TarantoolDb;
    const auth = betterAuth({
      appName: 'Learn Tarantool',
      baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
      basePath: '/api/auth',
      secret: process.env.BETTER_AUTH_SECRET ?? 'development-only-secret-change-me-123456789',
      trustedOrigins: [process.env.APP_ORIGIN ?? 'http://localhost:3000'],
      database: tarantoolAdapter(db, {debugLogs: process.env.AUTH_DEBUG === 'true'}),
      emailAndPassword: {enabled: true},
      plugins: [bearer()],
    });
    return BetterAuth.of({
      handler: auth.handler,
      getSession: (headers) => auth.api.getSession({headers}),
    });
  }),
);
