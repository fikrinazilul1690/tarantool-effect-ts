import {Effect, Layer} from 'effect';
import {UserCursorPageSchema} from '../../domain/user/model';
import {UserRepository, UserRepositoryError} from '../../domain/user/repository';
import {TarantoolDb} from './client';

export const TarantoolUserRepositoryLive = Layer.effect(
  UserRepository,
  Effect.gen(function*() {
    const db = yield* TarantoolDb;
    return UserRepository.of({
      list: (cursor, limit) => db.call(
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
