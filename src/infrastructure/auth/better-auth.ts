import {betterAuth} from 'better-auth/minimal';
import {bearer} from 'better-auth/plugins/bearer';
import {Context, Effect, Layer} from 'effect';
import {AppConfig} from '../config';
import {Email} from '../email/smtp-email';
import {TarantoolDb} from '../tarantool/client';
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
    const email = yield* Email;
    const {auth: config} = yield* AppConfig;
    const auth = betterAuth({
      appName: 'Learn Tarantool',
      baseURL: config.baseUrl,
      basePath: '/api/auth',
      secret: config.secret,
      trustedOrigins: [config.appOrigin],
      database: tarantoolAdapter(db, {debugLogs: config.debug}),
      emailAndPassword: {
        enabled: true,
        requireEmailVerification: true,
      },
      emailVerification: {
        sendOnSignUp: true,
        sendOnSignIn: true,
        autoSignInAfterVerification: true,
        expiresIn: 60 * 60,
        sendVerificationEmail: ({user, url}) => Effect.runPromise(email.sendVerification({
          to: user.email,
          name: user.name,
          verificationUrl: url,
        })),
      },
      plugins: [bearer()],
    });
    return BetterAuth.of({
      handler: (request) => structuredAuthResponse(auth.handler, request),
      getSession: (headers) => auth.api.getSession({headers}),
    });
  }),
);

async function structuredAuthResponse(
  handler: (request: Request) => Promise<Response>,
  request: Request,
): Promise<Response> {
  const response = await handler(request);
  const contentType = response.headers.get('content-type') ?? '';

  // Redirects (including verify-email callbacks), empty responses, and
  // non-JSON payloads must retain Better Auth's native protocol semantics.
  if (!contentType.includes('application/json') || response.status === 204) return response;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return response;
  }

  const payload = response.ok
    ? {success: true as const, data: body}
    : {success: false as const, error: authError(body, response)};
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json');

  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function authError(body: unknown, response: Response): {code: string; message: string} {
  if (typeof body === 'object' && body !== null) {
    const value = body as Record<string, unknown>;
    return {
      code: typeof value.code === 'string' ? value.code : 'AUTH_ERROR',
      message: typeof value.message === 'string' ? value.message : response.statusText,
    };
  }
  return {code: 'AUTH_ERROR', message: response.statusText || 'Authentication request failed'};
}
