import {expect, test} from 'bun:test';
import {ConfigProvider, Effect} from 'effect';
import {AppConfig, AppConfigLive, ConfigError} from '../src/infrastructure/config';

const loadConfig = (values: Record<string, string>) => Effect.runPromise(
  AppConfig.pipe(
    Effect.provide(AppConfigLive),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values))),
  ),
);

test('Effect Config and Schema transform environment values', async () => {
  const config = await loadConfig({
    TARANTOOL_ROUTERS: ' router-a:3301,router-b:3304 ',
    TARANTOOL_MAX_IN_FLIGHT: '512',
    AUTH_DEBUG: 'yes',
    BETTER_AUTH_URL: 'https://auth.example.com',
    APP_ORIGIN: 'https://app.example.com',
  });

  expect(config.tarantool.routers).toEqual([
    {host: 'router-a', port: 3301},
    {host: 'router-b', port: 3304},
  ]);
  expect(config.tarantool.maxInFlight).toBe(512);
  expect(config.auth.debug).toBe(true);
  expect(config.auth.baseUrl).toBe('https://auth.example.com/');
});

test('Schema rejects invalid cross-service deadlines', async () => {
  let failure: unknown;
  try {
    await loadConfig({
      TARANTOOL_OPERATION_TIMEOUT_MS: '5000',
      HTTP_REQUEST_TIMEOUT_MS: '5000',
    });
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(ConfigError);
});

test('Schema requires SMTP fields when delivery is enabled', async () => {
  let failure: unknown;
  try {
    await loadConfig({EMAIL_DELIVERY_ENABLED: 'true'});
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(ConfigError);
});

test('invalid router endpoints fail through the typed configuration channel', async () => {
  let failure: unknown;
  try {
    await loadConfig({TARANTOOL_ROUTERS: 'router-a:3301/path'});
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(ConfigError);
});
