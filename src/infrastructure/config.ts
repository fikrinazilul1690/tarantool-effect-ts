import {Config, Context, Data, Effect, Layer, Option, Schema} from 'effect';
import type {TarantoolClientConfig} from './tarantool/client';

export class ConfigError extends Data.TaggedError('ConfigError')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export interface AppConfigShape {
  readonly tarantool: TarantoolClientConfig;
  readonly http: {readonly port: number; readonly requestTimeoutMs: number; readonly gracefulShutdownMs: number};
  readonly auth: {readonly baseUrl: string; readonly secret: string; readonly appOrigin: string; readonly debug: boolean};
  readonly email: {
    readonly deliveryEnabled: boolean;
    readonly host: string | undefined;
    readonly port: number;
    readonly secure: boolean;
    readonly user: string | undefined;
    readonly password: string | undefined;
    readonly from: string | undefined;
  };
}

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()(
  'learn-tarantool/AppConfig',
) {}

const BoundedInteger = (minimum: number, maximum: number) => Schema.Int.check(
  Schema.isBetween({minimum, maximum}),
);
const NonEmptyTrimmedString = Schema.Trim.check(Schema.isMinLength(1));
const OptionalTrimmedString = Schema.UndefinedOr(NonEmptyTrimmedString);
const Port = BoundedInteger(1, 65_535);

const RouterSchema = Schema.Struct({host: NonEmptyTrimmedString, port: Port});
const TarantoolConfigSchema = Schema.Struct({
  routers: Schema.Array(RouterSchema).check(Schema.isMinLength(1)),
  username: NonEmptyTrimmedString,
  password: NonEmptyTrimmedString,
  connectTimeoutMs: BoundedInteger(100, 60_000),
  maxInFlight: BoundedInteger(1, 100_000),
  maxInFlightPerRouter: BoundedInteger(1, 100_000),
  circuitFailureThreshold: BoundedInteger(1, 100),
  circuitResetMs: BoundedInteger(100, 300_000),
  operationTimeoutMs: BoundedInteger(100, 300_000),
  shutdownDrainMs: BoundedInteger(100, 300_000),
});

const AppConfigSchema = Schema.Struct({
  tarantool: TarantoolConfigSchema,
  http: Schema.Struct({
    port: Port,
    requestTimeoutMs: BoundedInteger(100, 300_000),
    gracefulShutdownMs: BoundedInteger(100, 300_000),
  }),
  auth: Schema.Struct({
    baseUrl: NonEmptyTrimmedString,
    secret: NonEmptyTrimmedString,
    appOrigin: NonEmptyTrimmedString,
    debug: Schema.Boolean,
  }),
  email: Schema.Struct({
    deliveryEnabled: Schema.Boolean,
    host: OptionalTrimmedString,
    port: Port,
    secure: Schema.Boolean,
    user: OptionalTrimmedString,
    password: OptionalTrimmedString,
    from: OptionalTrimmedString,
  }),
}).check(Schema.makeFilter((config) => {
  const issues: Array<Schema.FilterIssue> = [];
  if (config.tarantool.operationTimeoutMs >= config.http.requestTimeoutMs) {
    issues.push({path: ['http', 'requestTimeoutMs'], issue: 'must be greater than tarantool.operationTimeoutMs'});
  }
  if (config.tarantool.shutdownDrainMs >= config.http.gracefulShutdownMs) {
    issues.push({path: ['http', 'gracefulShutdownMs'], issue: 'must be greater than tarantool.shutdownDrainMs'});
  }
  if (config.email.deliveryEnabled) {
    for (const field of ['host', 'user', 'password', 'from'] as const) {
      if (config.email[field] === undefined) {
        issues.push({path: ['email', field], issue: 'is required when email delivery is enabled'});
      }
    }
  }
  return issues;
}));

const withDefault = <A>(config: Config.Config<A>, fallback: A): Config.Config<A> =>
  config.pipe(Config.withDefault(fallback));
const integer = (name: string, fallback: number, minimum: number, maximum: number) =>
  withDefault(Config.schema(BoundedInteger(minimum, maximum), name), fallback);
const string = (name: string, fallback: string) =>
  withDefault(Config.schema(NonEmptyTrimmedString, name), fallback);
const boolean = (name: string, fallback: boolean) => withDefault(Config.boolean(name), fallback);
const optionalString = (name: string) => Config.option(
  Config.schema(NonEmptyTrimmedString, name),
).pipe(Config.map(Option.getOrUndefined));

const EnvironmentConfig = Config.all({
  routers: Config.option(Config.schema(Config.Array(NonEmptyTrimmedString), 'TARANTOOL_ROUTERS')),
  fallbackHost: string('TARANTOOL_HOST', '127.0.0.1'),
  fallbackPort: withDefault(Config.port('TARANTOOL_PORT'), 3301),
  username: string('TARANTOOL_USER', 'app'),
  password: string('TARANTOOL_PASSWORD', 'app-secret'),
  connectTimeoutMs: integer('TARANTOOL_CONNECT_TIMEOUT_MS', 5_000, 100, 60_000),
  maxInFlight: integer('TARANTOOL_MAX_IN_FLIGHT', 256, 1, 100_000),
  maxInFlightPerRouter: integer('TARANTOOL_MAX_IN_FLIGHT_PER_ROUTER', 128, 1, 100_000),
  circuitFailureThreshold: integer('TARANTOOL_CIRCUIT_FAILURE_THRESHOLD', 3, 1, 100),
  circuitResetMs: integer('TARANTOOL_CIRCUIT_RESET_MS', 5_000, 100, 300_000),
  operationTimeoutMs: integer('TARANTOOL_OPERATION_TIMEOUT_MS', 4_000, 100, 300_000),
  shutdownDrainMs: integer('TARANTOOL_SHUTDOWN_DRAIN_MS', 10_000, 100, 300_000),
  httpPort: withDefault(Config.port('PORT'), 3000),
  httpRequestTimeoutMs: integer('HTTP_REQUEST_TIMEOUT_MS', 5_000, 100, 300_000),
  httpGracefulShutdownMs: integer('HTTP_GRACEFUL_SHUTDOWN_MS', 15_000, 100, 300_000),
  authBaseUrl: withDefault(Config.url('BETTER_AUTH_URL'), new URL('http://localhost:3000')),
  authSecret: string('BETTER_AUTH_SECRET', 'development-only-secret-change-me-123456789'),
  appOrigin: withDefault(Config.url('APP_ORIGIN'), new URL('http://localhost:3000')),
  authDebug: boolean('AUTH_DEBUG', false),
  emailDeliveryEnabled: boolean('EMAIL_DELIVERY_ENABLED', false),
  smtpHost: optionalString('SMTP_HOST'),
  smtpPort: withDefault(Config.port('SMTP_PORT'), 587),
  smtpSecure: boolean('SMTP_SECURE', false),
  smtpUser: optionalString('SMTP_USER'),
  smtpPassword: optionalString('SMTP_PASSWORD'),
  emailFrom: optionalString('EMAIL_FROM'),
});

export const AppConfigLive = Layer.effect(
  AppConfig,
  Effect.gen(function*() {
    const raw = yield* EnvironmentConfig;
    const routerValues = Option.getOrElse(raw.routers, () => [`${raw.fallbackHost}:${raw.fallbackPort}`]);
    const routers = yield* Effect.try({
      try: () => routerValues.map(parseRouter),
      catch: (cause) => cause,
    });
    return yield* Schema.decodeUnknownEffect(AppConfigSchema)({
      tarantool: {
        routers,
        username: raw.username,
        password: raw.password,
        connectTimeoutMs: raw.connectTimeoutMs,
        maxInFlight: raw.maxInFlight,
        maxInFlightPerRouter: raw.maxInFlightPerRouter,
        circuitFailureThreshold: raw.circuitFailureThreshold,
        circuitResetMs: raw.circuitResetMs,
        operationTimeoutMs: raw.operationTimeoutMs,
        shutdownDrainMs: raw.shutdownDrainMs,
      },
      http: {
        port: raw.httpPort,
        requestTimeoutMs: raw.httpRequestTimeoutMs,
        gracefulShutdownMs: raw.httpGracefulShutdownMs,
      },
      auth: {
        baseUrl: raw.authBaseUrl.href,
        secret: raw.authSecret,
        appOrigin: raw.appOrigin.href,
        debug: raw.authDebug,
      },
      email: {
        deliveryEnabled: raw.emailDeliveryEnabled,
        host: raw.smtpHost,
        port: raw.smtpPort,
        secure: raw.smtpSecure,
        user: raw.smtpUser,
        password: raw.smtpPassword,
        from: raw.emailFrom,
      },
    });
  }).pipe(Effect.mapError((cause) => new ConfigError({
    message: 'Invalid application configuration',
    cause,
  }))),
);

export const defaultTarantoolClientConfig: TarantoolClientConfig = {
  routers: [{host: '127.0.0.1', port: 3301}],
  username: 'app',
  password: 'app-secret',
  connectTimeoutMs: 5_000,
  maxInFlight: 256,
  maxInFlightPerRouter: 128,
  circuitFailureThreshold: 3,
  circuitResetMs: 5_000,
  operationTimeoutMs: 4_000,
  shutdownDrainMs: 10_000,
};

export function parseRouters(value: string): ReadonlyArray<{readonly host: string; readonly port: number}> {
  return value.split(',').map((endpoint) => parseRouter(endpoint.trim()));
}

function parseRouter(endpoint: string): {readonly host: string; readonly port: number} {
  let url: URL;
  try {
    url = new URL(`tcp://${endpoint}`);
  } catch (cause) {
    throw new ConfigError({message: `Invalid Tarantool router endpoint: ${endpoint}`, cause});
  }
  if (url.username || url.password || (url.pathname !== '' && url.pathname !== '/')) {
    throw new ConfigError({message: `Invalid Tarantool router endpoint: ${endpoint}`, cause: endpoint});
  }
  const port = url.port === '' ? 3301 : Schema.decodeUnknownSync(Port)(Number(url.port));
  return {host: url.hostname, port};
}
