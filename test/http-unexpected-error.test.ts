import {expect, test} from 'bun:test';
import {Effect} from 'effect';
import {HttpServerResponse} from 'effect/unstable/http';
import {withUnexpectedErrorResponse} from '../src/presentation/http/middleware';

test('unexpected HTTP defects return a structured 500 response', async () => {
  const response = await Effect.runPromise(
    withUnexpectedErrorResponse(Effect.die(new Error('missing request service'))),
  );
  const webResponse = HttpServerResponse.toWeb(response);

  expect(webResponse.status).toBe(500);
  expect(await webResponse.json()).toEqual({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    },
  });
});
