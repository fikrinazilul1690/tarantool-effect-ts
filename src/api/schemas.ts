import {Schema} from 'effect';
import {HttpApiSchema} from 'effect/unstable/httpapi';

export const UserSchema = Schema.Struct({
  id: Schema.Number,
  bucket_id: Schema.Number,
  email: Schema.String,
  name: Schema.String,
  age: Schema.Number,
  created_at: Schema.Number,
});

export const CursorPageSchema = Schema.Struct({
  items: Schema.Array(UserSchema),
  next_cursor: Schema.NullOr(Schema.String),
  has_more: Schema.Boolean,
});

export const SuccessResponse = <S extends Schema.Top>(data: S) => Schema.Struct({
  success: Schema.Literal(true),
  data,
});

const ErrorResponse = <C extends string>(code: C) => Schema.Struct({
  success: Schema.Literal(false),
  error: Schema.Struct({code: Schema.Literal(code), message: Schema.String}),
});

export const BadRequestResponse = ErrorResponse('INVALID_LIMIT').pipe(HttpApiSchema.status(400));
export const UnauthorizedResponse = ErrorResponse('UNAUTHORIZED').pipe(HttpApiSchema.status(401));
export const InternalErrorResponse = ErrorResponse('DATABASE_ERROR').pipe(HttpApiSchema.status(500));

export const errorResponse = <C extends string>(code: C, message: string) => ({
  success: false as const,
  error: {code, message},
});
