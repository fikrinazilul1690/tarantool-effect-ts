import TarantoolConnection from "tarantool-driver";
import { Context, Data, Effect, Layer, Schema } from "effect";
import {AppConfig, defaultTarantoolClientConfig} from '../config';

export {parseRouters} from '../config';

export type TarantoolErrorKind =
  "configuration" | "unavailable" | "overloaded" | "transport" | "response";

export class TarantoolError extends Data.TaggedError("TarantoolError")<{
  readonly operation: string;
  readonly kind: TarantoolErrorKind;
  readonly cause: unknown;
}> { }

export interface TarantoolRouterStatus {
  readonly endpoint: string;
  readonly state: "closed" | "open" | "half-open";
  readonly inFlight: number;
  readonly consecutiveFailures: number;
  readonly retryAt: number | null;
  readonly requests: number;
  readonly failures: number;
  readonly rejections: number;
  readonly reconnects: number;
}

export interface TarantoolDbShape {
  readonly ping: Effect.Effect<void, TarantoolError>;
  readonly status: Effect.Effect<ReadonlyArray<TarantoolRouterStatus>>;
  readonly call: <A>(
    schema: Schema.ConstraintDecoder<A>,
    name: string,
    ...args: ReadonlyArray<unknown>
  ) => Effect.Effect<A, TarantoolError>;
  readonly callReadonly: <A>(
    schema: Schema.ConstraintDecoder<A>,
    name: string,
    ...args: ReadonlyArray<unknown>
  ) => Effect.Effect<A, TarantoolError>;
}

export class TarantoolDb extends Context.Service<
  TarantoolDb,
  TarantoolDbShape
>()("learn-tarantool/TarantoolDb") { }

export interface TarantoolClientConfig {
  readonly routers: ReadonlyArray<{
    readonly host: string;
    readonly port: number;
  }>;
  readonly username: string;
  readonly password: string;
  readonly connectTimeoutMs: number;
  readonly maxInFlight: number;
  readonly maxInFlightPerRouter: number;
  readonly circuitFailureThreshold: number;
  readonly circuitResetMs: number;
  readonly operationTimeoutMs: number;
  readonly shutdownDrainMs: number;
}

interface RouterSlot {
  readonly host: string;
  readonly port: number;
  connection: TarantoolConnection | null;
  connecting: Promise<TarantoolConnection> | null;
  inFlight: number;
  consecutiveFailures: number;
  openUntil: number;
  halfOpenInFlight: boolean;
  requests: number;
  failures: number;
  rejections: number;
  reconnects: number;
}

// @types/tarantool-driver@3.0.4 omits APIs present in tarantool-driver@3.1.0.
// Keep the compatibility bridge local instead of maintaining a global .d.ts.
interface RuntimeTarantoolCommands {
  ping(): Promise<unknown>;
}

type RuntimeTarantoolOptions = TarantoolConnection.TarantoolOptions & {
  readonly enableOfflineQueue: boolean;
};

class OperationTimeoutError extends Error {
  readonly code = "ETIMEDOUT";
}

class RouterPool {
  private readonly slots: Array<RouterSlot>;
  private globalInFlight = 0;
  private selectionCursor = 0;
  private closed = false;
  private readonly retiredConnections = new WeakSet<TarantoolConnection>();

  constructor(private readonly config: TarantoolClientConfig) {
    this.slots = config.routers.map(({ host, port }) => ({
      host,
      port,
      connection: null,
      connecting: null,
      inFlight: 0,
      consecutiveFailures: 0,
      openUntil: 0,
      halfOpenInFlight: false,
      requests: 0,
      failures: 0,
      rejections: 0,
      reconnects: 0,
    }));
  }

  async warm(): Promise<void> {
    const attempts = await Promise.allSettled(
      this.slots.map((slot) => this.connect(slot)),
    );
    if (!attempts.some(({ status }) => status === "fulfilled")) {
      throw new Error("No configured Tarantool router is reachable");
    }
  }

  async drainAndClose(): Promise<void> {
    this.closed = true;
    const deadline = Date.now() + this.config.shutdownDrainMs;
    while (this.globalInFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (const slot of this.slots) this.invalidate(slot);
  }

  status(): ReadonlyArray<TarantoolRouterStatus> {
    const now = Date.now();
    return this.slots.map((slot) => ({
      endpoint: `${slot.host}:${slot.port}`,
      state:
        slot.openUntil > now
          ? "open"
          : slot.halfOpenInFlight ||
            slot.consecutiveFailures >= this.config.circuitFailureThreshold
            ? "half-open"
            : "closed",
      inFlight: slot.inFlight,
      consecutiveFailures: slot.consecutiveFailures,
      retryAt: slot.openUntil > now ? slot.openUntil : null,
      requests: slot.requests,
      failures: slot.failures,
      rejections: slot.rejections,
      reconnects: slot.reconnects,
    }));
  }

  async ping(): Promise<void> {
    await this.withRouter(
      "ping",
      (connection) => (connection as TarantoolConnection & RuntimeTarantoolCommands)
        .ping()
        .then(() => undefined),
      true,
    );
  }

  async call(name: string, args: ReadonlyArray<unknown>): Promise<unknown> {
    return this.withRouter(`call ${name}`, (connection) =>
      connection.call(name, ...args),
    );
  }

  async callReadonly(
    name: string,
    args: ReadonlyArray<unknown>,
  ): Promise<unknown> {
    return this.withRouter(
      `call ${name}`,
      (connection) => connection.call(name, ...args),
      true,
    );
  }

  private async withRouter<A>(
    operation: string,
    execute: (connection: TarantoolConnection) => Promise<A>,
    retryTransportFailure = false,
  ): Promise<A> {
    if (this.closed)
      throw this.error(operation, "unavailable", "Router pool is draining");
    if (this.globalInFlight >= this.config.maxInFlight) {
      for (const slot of this.slots) slot.rejections += 1;
      throw this.error(
        operation,
        "overloaded",
        "Global Tarantool bulkhead is full",
      );
    }

    this.globalInFlight += 1;
    const attempted = new Set<RouterSlot>();
    try {
      while (attempted.size < this.slots.length) {
        const slot = this.select(operation, attempted);
        attempted.add(slot);
        slot.inFlight += 1;
        slot.requests += 1;
        const isHalfOpen =
          slot.consecutiveFailures >= this.config.circuitFailureThreshold;
        if (isHalfOpen) slot.halfOpenInFlight = true;

        let connection: TarantoolConnection;
        try {
          connection = await this.connect(slot);
        } catch (cause) {
          this.recordFailure(slot);
          slot.inFlight -= 1;
          slot.halfOpenInFlight = false;
          if (attempted.size < this.slots.length) continue;
          throw this.error(operation, "unavailable", cause);
        }

        try {
          const result = await withTimeout(
            execute(connection),
            this.config.operationTimeoutMs,
            `${operation} exceeded ${this.config.operationTimeoutMs}ms`,
          );
          this.recordSuccess(slot);
          return result;
        } catch (cause) {
          if (isTransportFailure(cause)) {
            this.invalidate(slot);
            this.recordFailure(slot);
            if (retryTransportFailure && attempted.size < this.slots.length)
              continue;
            throw this.error(operation, "transport", cause);
          }
          throw cause;
        } finally {
          slot.inFlight -= 1;
          slot.halfOpenInFlight = false;
        }
      }
      throw this.error(
        operation,
        "unavailable",
        "No Tarantool router is available",
      );
    } finally {
      this.globalInFlight -= 1;
    }
  }

  private select(
    operation: string,
    attempted: ReadonlySet<RouterSlot>,
  ): RouterSlot {
    const now = Date.now();
    const available = this.slots.filter(
      (slot) =>
        !attempted.has(slot) &&
        slot.openUntil <= now &&
        !slot.halfOpenInFlight &&
        slot.inFlight < this.config.maxInFlightPerRouter,
    );

    if (available.length === 0) {
      const hasCapacity = this.slots.some(
        (slot) =>
          !attempted.has(slot) &&
          slot.inFlight < this.config.maxInFlightPerRouter,
      );
      for (const slot of this.slots) {
        if (!attempted.has(slot)) slot.rejections += 1;
      }
      throw this.error(
        operation,
        hasCapacity ? "unavailable" : "overloaded",
        hasCapacity
          ? "Every Tarantool router circuit is open"
          : "All router bulkheads are full",
      );
    }

    const minimum = Math.min(...available.map(({ inFlight }) => inFlight));
    const leastLoaded = available.filter(
      ({ inFlight }) => inFlight === minimum,
    );
    const selected = leastLoaded[this.selectionCursor % leastLoaded.length]!;
    this.selectionCursor = (this.selectionCursor + 1) % Number.MAX_SAFE_INTEGER;
    return selected;
  }

  private connect(slot: RouterSlot): Promise<TarantoolConnection> {
    if (slot.connection !== null) return Promise.resolve(slot.connection);
    if (slot.connecting !== null) return slot.connecting;

    const options: RuntimeTarantoolOptions = {
      host: slot.host,
      port: slot.port,
      username: this.config.username,
      password: this.config.password,
      lazyConnect: true,
      timeout: this.config.connectTimeoutMs,
      enableOfflineQueue: false,
    };
    const connection = new TarantoolConnection(options);
    connection.on("error", () => undefined);
    connection.on("close", () => {
      if (slot.connection === connection) slot.connection = null;
      // The driver schedules its own reconnect after emitting close. Cancel it:
      // endpoint selection, cooldown, and reconnects belong to this pool.
      this.retire(connection);
    });

    slot.connecting = connection
      .connect()
      .then(() => {
        if (this.closed) {
          this.retire(connection);
          throw new Error("Router pool closed while connecting");
        }
        slot.connection = connection;
        slot.reconnects += 1;
        return connection;
      })
      .catch((cause) => {
        this.retire(connection);
        throw cause;
      })
      .finally(() => {
        slot.connecting = null;
      });
    return slot.connecting;
  }

  private invalidate(slot: RouterSlot): void {
    const connection = slot.connection;
    slot.connection = null;
    if (connection !== null) this.retire(connection);
  }

  private retire(connection: TarantoolConnection): void {
    if (this.retiredConnections.has(connection)) return;
    this.retiredConnections.add(connection);
    connection.disconnect();
  }

  private recordSuccess(slot: RouterSlot): void {
    slot.consecutiveFailures = 0;
    slot.openUntil = 0;
  }

  private recordFailure(slot: RouterSlot): void {
    slot.consecutiveFailures += 1;
    slot.failures += 1;
    if (slot.consecutiveFailures >= this.config.circuitFailureThreshold) {
      slot.openUntil = Date.now() + this.config.circuitResetMs;
    }
  }

  private error(
    operation: string,
    kind: TarantoolErrorKind,
    cause: unknown,
  ): TarantoolError {
    return new TarantoolError({ operation, kind, cause });
  }
}

export const makeTarantoolDbLayer = (
  overrides: Partial<TarantoolClientConfig> = {},
) =>
  Layer.effect(
    TarantoolDb,
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          let config: TarantoolClientConfig;
          try {
            config = validateConfig({ ...defaultTarantoolClientConfig, ...overrides });
          } catch (cause) {
            throw new TarantoolError({
              operation: "configure",
              kind: "configuration",
              cause,
            });
          }
          const pool = new RouterPool(config);
          try {
            await pool.warm();
          } catch (cause) {
            await pool.drainAndClose();
            throw new TarantoolError({
              operation: "connect",
              kind: "unavailable",
              cause,
            });
          }
          return pool;
        },
        catch: (cause) =>
          cause instanceof TarantoolError
            ? cause
            : new TarantoolError({operation: "connect", kind: "unavailable", cause}),
      }),
      (pool) => Effect.promise(() => pool.drainAndClose()),
    ).pipe(
      Effect.map((pool): TarantoolDbShape =>
        TarantoolDb.of({
          ping: Effect.tryPromise({
            try: () => pool.ping(),
            catch: (cause) => asTarantoolError("ping", cause),
          }),
          status: Effect.sync(() => pool.status()),
          call: <A>(
            schema: Schema.ConstraintDecoder<A>,
            name: string,
            ...args: ReadonlyArray<unknown>
          ) =>
            Effect.tryPromise({
              try: () => pool.call(name, args),
              catch: (cause) => asTarantoolError(`call ${name}`, cause),
            }).pipe(
              Effect.flatMap((response) => decodeEnvelope(schema, response)),
              Effect.mapError((cause) =>
                cause instanceof TarantoolError
                  ? cause
                  : new TarantoolError({
                    operation: `decode ${name}`,
                    kind: "response",
                    cause,
                  }),
              ),
            ),
          callReadonly: <A>(
            schema: Schema.ConstraintDecoder<A>,
            name: string,
            ...args: ReadonlyArray<unknown>
          ) =>
            Effect.tryPromise({
              try: () => pool.callReadonly(name, args),
              catch: (cause) => asTarantoolError(`call ${name}`, cause),
            }).pipe(
              Effect.flatMap((response) => decodeEnvelope(schema, response)),
              Effect.mapError((cause) =>
                cause instanceof TarantoolError
                  ? cause
                  : new TarantoolError({
                    operation: `decode ${name}`,
                    kind: "response",
                    cause,
                  }),
              ),
            ),
        }),
      ),
    ),
  );

export const TarantoolDbLive = Layer.unwrap(
  Effect.map(AppConfig, ({tarantool}) => makeTarantoolDbLayer(tarantool)),
);

function validateConfig(config: TarantoolClientConfig): TarantoolClientConfig {
  const checks: ReadonlyArray<[number, string, number, number]> = [
    [config.connectTimeoutMs, "TARANTOOL_CONNECT_TIMEOUT_MS", 100, 60_000],
    [config.maxInFlight, "TARANTOOL_MAX_IN_FLIGHT", 1, 100_000],
    [
      config.maxInFlightPerRouter,
      "TARANTOOL_MAX_IN_FLIGHT_PER_ROUTER",
      1,
      100_000,
    ],
    [
      config.circuitFailureThreshold,
      "TARANTOOL_CIRCUIT_FAILURE_THRESHOLD",
      1,
      100,
    ],
    [config.circuitResetMs, "TARANTOOL_CIRCUIT_RESET_MS", 100, 300_000],
    [config.operationTimeoutMs, "TARANTOOL_OPERATION_TIMEOUT_MS", 100, 300_000],
    [config.shutdownDrainMs, "TARANTOOL_SHUTDOWN_DRAIN_MS", 100, 300_000],
  ];
  if (config.routers.length === 0)
    throw new Error("At least one Tarantool router is required");
  for (const [value, name, minimum, maximum] of checks) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(
        `${name} must be an integer between ${minimum} and ${maximum}`,
      );
    }
  }
  return config;
}

function asTarantoolError(operation: string, cause: unknown): TarantoolError {
  return cause instanceof TarantoolError
    ? cause
    : new TarantoolError({
      operation,
      kind: isTransportFailure(cause) ? "transport" : "unavailable",
      cause,
    });
}

function isTransportFailure(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const code = "code" in cause ? String(cause.code) : "";
  return /ECONN|EPIPE|ETIMEDOUT|ENOTFOUND|socket|connection is closed/i.test(
    `${code} ${cause.message}`,
  );
}

function withTimeout<A>(
  promise: Promise<A>,
  timeoutMs: number,
  message: string,
): Promise<A> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new OperationTimeoutError(message)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

function decodeEnvelope<A>(
  schema: Schema.ConstraintDecoder<A>,
  response: unknown,
) {
  const candidates: Array<unknown> = [response];
  let value = response;
  while (Array.isArray(value) && value.length === 1) {
    value = value[0];
    candidates.push(value);
  }

  const decode = Schema.decodeUnknownEffect(schema);
  const attempt = (index: number): Effect.Effect<A, unknown> =>
    decode(candidates[index]).pipe(
      Effect.catch((error) =>
        index + 1 < candidates.length ? attempt(index + 1) : Effect.fail(error),
      ),
    );
  return attempt(0);
}
