import {BunRuntime} from '@effect/platform-bun';
import {Layer} from 'effect';
import {BetterAuthLive} from './infrastructure/auth/better-auth';
import {EmailLive} from './infrastructure/email/smtp-email';
import {TarantoolDbLive} from './infrastructure/tarantool/client';
import {TarantoolUserRepositoryLive} from './infrastructure/tarantool/user-repository';
import {HttpServerLive} from './presentation/http/server';

const InfrastructureLive = Layer.mergeAll(
  BetterAuthLive,
  TarantoolUserRepositoryLive,
).pipe(
  Layer.provide(EmailLive),
  Layer.provideMerge(TarantoolDbLive),
);

const ApplicationLive = HttpServerLive.pipe(
  Layer.provide(InfrastructureLive),
);

Layer.launch(ApplicationLive).pipe(BunRuntime.runMain);
