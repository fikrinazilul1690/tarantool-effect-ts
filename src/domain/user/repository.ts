import { Context, Data, type Effect } from "effect";
import type { CursorPage, User } from "./model";

export class UserRepositoryError extends Data.TaggedError(
  "UserRepositoryError",
)<{
  readonly operation: "list";
  readonly cause: unknown;
}> { }

export interface UserRepositoryShape {
  readonly list: (
    filters: {
      readonly age?: number;
      readonly createdAt?: number;
    },
    cursor: string | null,
    limit: number,
  ) => Effect.Effect<CursorPage<User>, UserRepositoryError>;
}

export class UserRepository extends Context.Service<
  UserRepository,
  UserRepositoryShape
>()("learn-tarantool/domain/user/UserRepository") { }
