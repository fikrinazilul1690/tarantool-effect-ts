import {Context, Data, Effect, Layer, Schema} from 'effect';
import nodemailer, {type Transporter} from 'nodemailer';
import {AppConfig, type AppConfigShape} from '../config';
import {TarantoolDb, type TarantoolDbShape} from '../tarantool/client';

export class EmailError extends Data.TaggedError('EmailError')<{
  readonly operation: 'configure' | 'enqueue' | 'send' | 'worker';
  readonly cause: unknown;
}> {}

export interface VerificationEmail {
  readonly to: string;
  readonly name: string;
  readonly verificationUrl: string;
}

export interface RegistrationAttemptEmail {
  readonly to: string;
  readonly name: string;
  readonly attemptedAt: Date;
}

interface EmailShape {
  readonly sendVerification: (message: VerificationEmail) => Effect.Effect<void, EmailError>;
  readonly sendRegistrationAttempt: (
    message: RegistrationAttemptEmail,
  ) => Effect.Effect<void, EmailError>;
}

export class Email extends Context.Service<Email, EmailShape>()('learn-tarantool/Email') {}

const EmailPayloadSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('verification'),
    to: Schema.String,
    name: Schema.String,
    verificationUrl: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('registration-attempt'),
    to: Schema.String,
    name: Schema.String,
    attemptedAt: Schema.String,
  }),
]);

const EmailJobSchema = Schema.Struct({
  id: Schema.String,
  payload: EmailPayloadSchema,
  attempts: Schema.Number,
});

type EmailPayload = typeof EmailPayloadSchema.Type;
type EmailJob = typeof EmailJobSchema.Type;

const acquireTransport = (config: AppConfigShape['email']) => Effect.acquireRelease(
  Effect.try({
    try: (): Transporter | null => {
      if (!config.deliveryEnabled) return null;
      const transporter = nodemailer.createTransport({
        host: config.host!,
        port: config.port,
        secure: config.secure,
        auth: {user: config.user!, pass: config.password!},
        connectionTimeout: config.sendTimeoutMs,
        greetingTimeout: config.sendTimeoutMs,
        socketTimeout: config.sendTimeoutMs,
      });
      return transporter;
    },
    catch: (cause) => new EmailError({operation: 'configure', cause}),
  }),
  (transporter) => Effect.sync(() => transporter?.close()),
);

export const EmailLive = Layer.effect(
  Email,
  Effect.gen(function*() {
    const {email: config} = yield* AppConfig;
    const db = yield* TarantoolDb;
    const transporter = yield* acquireTransport(config);

    if (transporter !== null) {
      const owner = `${process.pid}-${crypto.randomUUID()}`;
      yield* Effect.forkScoped(runWorker(db, transporter, config, owner));
    }

    const enqueue = (payload: EmailPayload): Effect.Effect<void, EmailError> => {
      if (transporter === null) {
        if (payload.kind === 'verification') {
          return Effect.logWarning(
            `Email delivery disabled. Verification link for ${payload.to}: ${payload.verificationUrl}`,
          );
        }
        return Effect.logWarning(
          `Email delivery disabled. Registration attempt notification for ${payload.to} was not sent.`,
        );
      }
      return db.call(Schema.String, 'api.email_outbox_enqueue', {
        id: crypto.randomUUID(),
        payload,
        created_at: Date.now(),
      }).pipe(
        Effect.asVoid,
        Effect.mapError((cause) => new EmailError({operation: 'enqueue', cause})),
      );
    };

    return Email.of({
      sendVerification: (message) => enqueue({kind: 'verification', ...message}),
      sendRegistrationAttempt: (message) => enqueue({
        kind: 'registration-attempt',
        to: message.to,
        name: message.name,
        attemptedAt: message.attemptedAt.toISOString(),
      }),
    });
  }),
);

function runWorker(
  db: TarantoolDbShape,
  transporter: Transporter,
  config: AppConfigShape['email'],
  owner: string,
): Effect.Effect<never> {
  const poll = Effect.suspend(() => db.call(
    Schema.Array(EmailJobSchema),
    'api.email_outbox_claim',
    owner,
    Date.now(),
    config.leaseMs,
    config.workerBatchSize,
  )).pipe(
    Effect.flatMap((jobs) => jobs.length === 0
      ? Effect.sleep(config.workerPollMs)
      : Effect.all(jobs.map((job) => processJob(db, transporter, config, owner, job)), {
        concurrency: config.workerConcurrency,
        discard: true,
      })),
    Effect.catch((cause) => Effect.logError('Email outbox poll failed', cause).pipe(
      Effect.andThen(Effect.sleep(config.workerPollMs)),
    )),
  );
  return Effect.forever(poll);
}

function processJob(
  db: TarantoolDbShape,
  transporter: Transporter,
  config: AppConfigShape['email'],
  owner: string,
  job: EmailJob,
): Effect.Effect<void> {
  return deliver(transporter, config, job.payload).pipe(
    Effect.andThen(db.call(Schema.Boolean, 'api.email_outbox_ack', job.id, owner)),
    Effect.tap((acknowledged) => acknowledged
      ? Effect.void
      : Effect.logWarning('Email was sent after its outbox lease ownership changed', {
        jobId: job.id,
      })),
    Effect.asVoid,
    Effect.catch((cause) => {
      const exponential = Math.min(
        config.retryMaxMs,
        config.retryBaseMs * (2 ** Math.max(0, job.attempts - 1)),
      );
      const delay = Math.floor(exponential / 2 + Math.random() * exponential / 2);
      return db.call(
        Schema.Boolean,
        'api.email_outbox_fail',
        job.id,
        owner,
        Date.now() + delay,
        config.maxAttempts,
        safeError(cause),
        Date.now(),
      ).pipe(
        Effect.tap(() => Effect.logWarning('Email delivery failed; outbox state updated', {
          jobId: job.id,
          attempt: job.attempts,
        })),
        Effect.catch((updateCause) => Effect.logError('Email outbox failure update failed', updateCause)),
        Effect.asVoid,
      );
    }),
  );
}

function deliver(
  transporter: Transporter,
  config: AppConfigShape['email'],
  payload: EmailPayload,
): Effect.Effect<void, EmailError> {
  const message = payload.kind === 'verification'
    ? {
      from: config.from!,
      to: payload.to,
      subject: 'Verify your Learn Tarantool email address',
      text: `Hello ${payload.name},\n\nVerify your email address:\n${payload.verificationUrl}\n\nThis link expires in one hour.`,
      html: `<p>Hello ${escapeHtml(payload.name)},</p><p>Please verify your email address:</p><p><a href="${escapeHtml(payload.verificationUrl)}">Verify email</a></p><p>This link expires in one hour.</p>`,
    }
    : {
      from: config.from!,
      to: payload.to,
      subject: 'A registration attempt used your email address',
      text: `Hello ${payload.name},\n\nSomeone attempted to register a Learn Tarantool account using your email address at ${payload.attemptedAt}.\n\nYour account was not changed. If this was not you, no action is required.`,
      html: `<p>Hello ${escapeHtml(payload.name)},</p><p>Someone attempted to register a Learn Tarantool account using your email address at <strong>${escapeHtml(payload.attemptedAt)}</strong>.</p><p>Your account was not changed. If this was not you, no action is required.</p>`,
    };
  return Effect.tryPromise({
    try: () => transporter.sendMail(message).then(() => undefined),
    catch: (cause) => new EmailError({operation: 'send', cause}),
  }).pipe(
    Effect.timeoutOrElse({
      duration: config.sendTimeoutMs,
      orElse: () => Effect.fail(new EmailError({
        operation: 'send',
        cause: `SMTP send exceeded ${config.sendTimeoutMs}ms`,
      })),
    }),
  );
}

function safeError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.slice(0, 1_000);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  })[character]!);
}
