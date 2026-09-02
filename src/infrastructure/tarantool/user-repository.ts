import {Effect, Layer} from 'effect';
import {UserCursorPageSchema} from '../../domain/user/model';
import {UserRepository, UserRepositoryError} from '../../domain/user/repository';
import {TarantoolDb} from './client';

export const TarantoolUserRepositoryLive = Layer.effect(
  UserRepository,
  Effect.gen(function*() {
    const db = yield* TarantoolDb;
    return UserRepository.of({
      // Cursor reads are idempotent, so this operation may use another router
      // after a classified transport failure. Mutations keep the no-replay API.
      list: (cursor, limit) => db.callReadonly(
        UserCursorPageSchema,
        'api.users_page',
        cursor,
        limit,
      ).pipe(
        Effect.mapError((cause) => new UserRepositoryError({operation: 'list', cause})),
      ),
    });
  }),
);
