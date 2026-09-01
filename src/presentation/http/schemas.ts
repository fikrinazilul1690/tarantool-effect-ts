import {Effect, Schema} from 'effect';
import {HttpApiSchema} from 'effect/unstable/httpapi';
import {UserCursorPageSchema, UserSchema} from '../../domain/user/model';

export {UserSchema};
export const CursorPageSchema = UserCursorPageSchema;

export const SuccessResponse = <S extends Schema.Top>(data: S) => Schema.Struct({
  success: Schema.Literal(true).pipe(
    Schema.optionalKey,
    Schema.withConstructorDefault(Effect.succeed(true as const)),
  ),
  data,
});

export const HealthSuccess = SuccessResponse(Schema.Struct({
  status: Schema.Literal('ok'),
  runtime: Schema.String,
}));

export const ListUsersSuccess = SuccessResponse(CursorPageSchema);

const ErrorResponse = <C extends string>(code: C) => Schema.Struct({
  success: Schema.Literal(false),
  error: Schema.Struct({code: Schema.Literal(code), message: Schema.String}),
});

export const ValidationErrorResponse = Schema.Struct({
  success: Schema.Literal(false),
  error: Schema.Struct({
    code: Schema.Literal('VALIDATION_ERROR'),
    message: Schema.String,
    fields: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  }),
}).pipe(HttpApiSchema.status(400));
export const UnauthorizedResponse = ErrorResponse('UNAUTHORIZED').pipe(HttpApiSchema.status(401));
export const InternalErrorResponse = ErrorResponse('DATABASE_ERROR').pipe(HttpApiSchema.status(500));

export const errorResponse = <C extends string>(code: C, message: string) => ({
  success: false as const,
  error: {code, message},
});

export const validationErrorResponse = (
  message: string,
  fields: Record<string, ReadonlyArray<string>>,
) => ({
  success: false as const,
  error: {code: 'VALIDATION_ERROR' as const, message, fields},
});
