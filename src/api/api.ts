import {Schema} from 'effect';
import {HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi} from 'effect/unstable/httpapi';
import {ApiAuthorization} from './auth-middleware';
import {
  BadRequestResponse,
  CursorPageSchema,
  InternalErrorResponse,
  SuccessResponse,
} from './schemas';

const HealthData = Schema.Struct({
  status: Schema.Literal('ok'),
  runtime: Schema.String,
});

export class SystemApi extends HttpApiGroup.make('system', {topLevel: true}).add(
  HttpApiEndpoint.get('health', '/health', {
    success: SuccessResponse(HealthData),
  }),
) {}

export class UsersApi extends HttpApiGroup.make('users').add(
  HttpApiEndpoint.get('listUsers', '/api/users', {
    query: {
      limit: Schema.optional(Schema.NumberFromString),
      cursor: Schema.optional(Schema.String),
    },
    success: SuccessResponse(CursorPageSchema),
    error: [BadRequestResponse, InternalErrorResponse],
  }),
).middleware(ApiAuthorization) {}

export class Api extends HttpApi.make('learn-tarantool-api')
  .add(SystemApi)
  .add(UsersApi)
  .annotateMerge(OpenApi.annotations({
    title: 'Learn Tarantool API',
    version: '1.0.0',
    description: 'Effect v4 HttpApi backed by Tarantool vshard and Better Auth bearer authentication.',
  })) {}
