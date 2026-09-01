import {Schema} from 'effect';

export class NewUser extends Schema.Class<NewUser>('learn-tarantool/domain/user/NewUser')({
  id: Schema.Number,
  email: Schema.String,
  name: Schema.String,
  age: Schema.Number,
  created_at: Schema.optional(Schema.Number),
}) {}
export const NewUserSchema = NewUser;

export class User extends Schema.Class<User>('learn-tarantool/domain/user/User')({
  id: Schema.Number,
  bucket_id: Schema.Number,
  email: Schema.String,
  name: Schema.String,
  age: Schema.Number,
  created_at: Schema.Number,
}) {}
export const UserSchema = User;

export class UserChanges extends Schema.Class<UserChanges>(
  'learn-tarantool/domain/user/UserChanges',
)({
  email: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  age: Schema.optional(Schema.Number),
}) {}
export const UserChangesSchema = UserChanges;

export interface CursorPage<T> {
  readonly items: ReadonlyArray<T>;
  readonly next_cursor: string | null;
  readonly has_more: boolean;
  readonly totalPage: number;
  readonly currentPage: number;
  readonly lastCursor: string | null;
}

export class UserCursorPage extends Schema.Class<UserCursorPage>(
  'learn-tarantool/domain/user/UserCursorPage',
)({
  items: Schema.Array(User),
  next_cursor: Schema.NullOr(Schema.String),
  has_more: Schema.Boolean,
  totalPage: Schema.Number,
  currentPage: Schema.Number,
  lastCursor: Schema.NullOr(Schema.String),
}) {}
export const UserCursorPageSchema = UserCursorPage;
