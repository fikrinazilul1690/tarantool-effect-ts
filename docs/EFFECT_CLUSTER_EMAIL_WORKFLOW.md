# Durable email with Effect Workflow and Cluster

This is a production-oriented implementation sketch for the version currently
installed by this repository: Effect `4.0.0-rc.112`. Workflow and Cluster are
unstable APIs, so pin their versions and compile this example again before each
Effect upgrade.

The example is an alternative to the current Tarantool `email_outbox` worker;
it is not enabled by the application today.

## What is durable

The authentication request submits `EmailDelivery.execute(payload, {
discard: true })`. It waits for Effect Cluster to persist the workflow message,
but it does not wait for SMTP. A runner can then execute or resume the workflow
after a process restart.

```text
Better Auth
    │ await durable submission
    ▼
Effect WorkflowEngine ── persisted mailbox/replies ── SQL
    │
    ▼
Effect Cluster runner
    │ bounded activity execution
    ▼
SMTP provider
```

The application may continue to store Better Auth records in Tarantool. In
`rc.112`, Effect's supplied Cluster persistence uses `SqlClient`; the
`tarantool-driver` client is not an Effect SQL implementation. Use PostgreSQL
or another supported Effect SQL backend for Cluster metadata, or implement and
maintain custom `MessageStorage` and `RunnerStorage` adapters.

Do not use `storage: "local"` or `WorkflowEngine.layerMemory` for production.
Those modes cannot resume work after process loss.

## 1. Workflow contract

The message ID is generated once by the caller and is the workflow idempotency
key. Repeating submission with the same ID addresses the same execution rather
than creating another logical email.

```ts
// email-workflow.ts
import {Schema} from 'effect';
import {Workflow} from 'effect/unstable/workflow';

export class EmailDeliveryError extends Schema.TaggedErrorClass<EmailDeliveryError>()(
  'EmailDeliveryError',
  {
    message: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

export const EmailPayload = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('verification'),
    messageId: Schema.String,
    to: Schema.String,
    name: Schema.String,
    verificationUrl: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('registration-attempt'),
    messageId: Schema.String,
    to: Schema.String,
    name: Schema.String,
    attemptedAt: Schema.String,
  }),
]);

export type EmailPayload = typeof EmailPayload.Type;

export const EmailDelivery = Workflow.make('EmailDelivery.v1', {
  payload: EmailPayload,
  success: Schema.Void,
  error: EmailDeliveryError,
  idempotencyKey: ({messageId}) => messageId,
});
```

Keep the workflow tag, payload schema, and activity names stable while old
executions exist. Introduce `EmailDelivery.v2` for an incompatible change.

## 2. SMTP service and workflow handler

SMTP is an external side effect, so the guarantee is at-least-once. The
activity result is durable, but a runner can crash after SMTP accepts a message
and before Cluster persists the successful result. Pass the activity
idempotency key to a provider that supports deduplication.

```ts
// email-workflow-live.ts
import {Context, Effect, Schedule, Schema} from 'effect';
import {Activity} from 'effect/unstable/workflow';
import {
  EmailDelivery,
  EmailDeliveryError,
  type EmailPayload,
} from './email-workflow';

interface SmtpSenderShape {
  readonly deliver: (
    payload: EmailPayload,
    idempotencyKey: string,
  ) => Effect.Effect<void, EmailDeliveryError>;
}

export class SmtpSender extends Context.Service<SmtpSender, SmtpSenderShape>()(
  'learn-tarantool/SmtpSender',
) {}

const retrySchedule = Schedule.exponential('1 second').pipe(
  Schedule.jittered,
  Schedule.upTo({times: 7, duration: '5 minutes'}),
);

export const EmailDeliveryLive = EmailDelivery.toLayer((payload) =>
  Effect.gen(function*() {
    const sender = yield* SmtpSender;
    const providerKey = yield* Activity.idempotencyKey('smtp-send');

    yield* Activity.make({
      name: 'smtp-send',
      success: Schema.Void,
      error: EmailDeliveryError,
      execute: sender.deliver(payload, providerKey).pipe(
        Effect.timeoutOrElse({
          duration: '15 seconds',
          orElse: () => Effect.fail(new EmailDeliveryError({
            message: 'SMTP deadline exceeded',
            retryable: true,
          })),
        }),
        Effect.retry({
          while: (error) => error.retryable,
          schedule: retrySchedule,
        }),
      ),
    });
  }),
);

```

The in-activity retry schedule is suitable for short SMTP retries. For delays
that must survive long outages without holding runner capacity, model each send
attempt as a separately named activity and wait between attempts with
`DurableClock`, or fail the workflow and redrive it through an operational
policy. Effect Workflow persists the terminal failure, but this example does
not automatically create a separate dead-letter queue; build redrive tooling
around failed execution IDs.

## 3. Durable cluster runtime

The concrete SQL driver layer is intentionally left as a declared dependency:
this repository does not currently install an Effect SQL driver. In production,
provide a highly available PostgreSQL `SqlClient` layer and run its Cluster
migrations before accepting traffic.

```ts
// email-cluster-live.ts
import {BunClusterHttp, BunCrypto} from '@effect/platform-bun';
import {Layer} from 'effect';
import {
  ClusterWorkflowEngine,
  SingleRunner,
} from 'effect/unstable/cluster';
import type {SqlClient} from 'effect/unstable/sql';
import {EmailDeliveryLive, SmtpSender} from './email-workflow-live';

declare const SqlClientLive: Layer.Layer<SqlClient.SqlClient>;
declare const SmtpSenderLive: Layer.Layer<SmtpSender>;

// Local development: one process, but mailbox and replies remain SQL-backed.
const LocalClusterLive = SingleRunner.layer({runnerStorage: 'sql'}).pipe(
  Layer.provide([SqlClientLive, BunCrypto.layer]),
);

export const LocalWorkflowEngineLive = ClusterWorkflowEngine.layer.pipe(
  Layer.provide(LocalClusterLive),
);

// Production: every application/worker instance is an Effect Cluster runner.
// Runner addresses, shard groups, and discovery settings must be supplied by
// the deployment environment and service discovery.
const ProductionClusterLive = BunClusterHttp.layer({
  transport: 'http',
  storage: 'sql',
  runnerHealth: 'ping',
}).pipe(
  Layer.provide(SqlClientLive),
);

export const ProductionWorkflowEngineLive = ClusterWorkflowEngine.layer.pipe(
  Layer.provide(ProductionClusterLive),
);

export const EmailWorkflowWorkerLive = EmailDeliveryLive.pipe(
  Layer.provide(SmtpSenderLive),
);
```

Run at least two runners in independent failure domains. They must share the
same SQL persistence and Cluster configuration. Do not start a second,
independent `SingleRunner` against the same production workload.

## 4. Email service used by Better Auth

`discard: true` means the caller receives an execution ID after durable
submission instead of waiting for workflow completion.

```ts
// workflow-email-service.ts
import {Context, Effect, Layer} from 'effect';
import {WorkflowEngine} from 'effect/unstable/workflow';
import {EmailDelivery, type EmailPayload} from './email-workflow';

interface EmailShape {
  readonly enqueue: (payload: EmailPayload) => Effect.Effect<string>;
}

export class Email extends Context.Service<Email, EmailShape>()(
  'learn-tarantool/WorkflowEmail',
) {}

export const WorkflowEmailLive = Layer.effect(
  Email,
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    return Email.of({
      enqueue: (payload) => EmailDelivery.execute(payload, {discard: true}).pipe(
        Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
      ),
    });
  }),
);
```

Better Auth is a Promise boundary, so this is one of the few appropriate
places to use `Effect.runPromise`:

```ts
emailVerification: {
  sendVerificationEmail: ({user, url}) => Effect.runPromise(email.enqueue({
    kind: 'verification',
    messageId: crypto.randomUUID(),
    to: user.email,
    name: user.name,
    verificationUrl: url,
  })),
}
```

Do not configure Better Auth's detached `backgroundTasks.handler` around this
submission. The HTTP request should wait for durable Cluster persistence, while
the workflow itself continues asynchronously.

## 5. Composition

The API needs the workflow engine to submit work, and runner processes need the
same engine plus the registered handler to execute it.

```ts
const EmailRuntimeLive = Layer.mergeAll(
  WorkflowEmailLive,
  EmailWorkflowWorkerLive,
).pipe(
  Layer.provide(ProductionWorkflowEngineLive),
);
```

For larger deployments, split these roles:

- API instances use a client-only `BunClusterHttp.layer` and expose
  `WorkflowEmailLive`.
- Worker instances use the server/runner layer and register
  `EmailDeliveryLive`.
- Both use the same SQL persistence and service discovery.

## Production checklist

- Pin Effect, platform, and SQL-driver versions; unstable APIs can change.
- Run and version Effect Cluster SQL migrations before rolling out workers.
- Use TLS and authentication for runner transport and SQL connections.
- Put runners in independent failure domains and test ownership transfer.
- Bound SMTP concurrency in addition to Cluster mailbox capacity.
- Export workflow submissions, queue age, activity attempts, failures,
  timeouts, completions, and dead-letter/redrive metrics.
- Never log verification URLs, SMTP credentials, or serialized workflow
  payloads containing tokens.
- Encrypt sensitive workflow payloads at rest or persist a short-lived opaque
  reference instead of the verification URL.
- Preserve the same `messageId` when an operation-aware caller retries durable
  submission.
- Test crashes before SMTP, during SMTP, and after provider acceptance but
  before activity acknowledgement.
- Drain HTTP submissions and Cluster runners during shutdown.

## Migration from the current Tarantool outbox

Do not let both systems claim the same email. Use a staged cutover:

1. Deploy the Effect Cluster persistence and runners without API submission.
2. Verify health, migrations, metrics, and a synthetic workflow.
3. Stop new Tarantool outbox enqueueing and switch Better Auth submission to
   `EmailDelivery.execute(..., {discard: true})`.
4. Keep the current Tarantool worker running until its pending and processing
   queues drain.
5. Stop the Tarantool worker, retain dead-letter records for reconciliation,
   and only then remove its schema in a later migration.
