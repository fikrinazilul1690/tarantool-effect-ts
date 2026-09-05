import {afterAll, beforeAll, expect, test} from 'bun:test';

const port = 3199;
let server: Bun.Subprocess | undefined;

beforeAll(async () => {
  server = Bun.spawn(['bun', 'run', 'src/main.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HTTP_RATE_LIMIT_PER_WINDOW: '2',
      HTTP_RATE_LIMIT_WINDOW_MS: '300000',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      // Better Auth is mounted as a raw handler and is not part of the
      // schema-first global HttpApi limiter; use it only as a readiness probe.
      await fetch(`http://127.0.0.1:${port}/api/auth/does-not-exist`);
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error('HTTP API did not start within 15 seconds');
}, 20_000);

afterAll(() => server?.kill());

test('global API token bucket rejects requests after capacity is exhausted', async () => {
  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/users`);
  const first = await fetch(`http://127.0.0.1:${port}/health`);
  const second = await fetch(`http://127.0.0.1:${port}/health`);

  expect(unauthorized.status).toBe(401);
  expect((await unauthorized.json()) as unknown).toEqual({
    success: false,
    error: {
      code: 'UNAUTHORIZED',
      message: 'Missing, expired, or invalid bearer token',
    },
  });
  expect(first.status).toBe(200);
  expect(second.status).toBe(429);
  expect((await second.json()) as unknown).toEqual({
    success: false,
    error: {code: 'RATE_LIMITED', message: 'Too many requests'},
  });
});
