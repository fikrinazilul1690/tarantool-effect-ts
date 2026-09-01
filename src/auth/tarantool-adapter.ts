import {createAdapterFactory, type DBAdapterDebugLogOption} from 'better-auth/adapters';
import {Effect} from 'effect';
import type {TarantoolDbShape} from '../db';

interface TarantoolAdapterOptions {
  debugLogs?: DBAdapterDebugLogOption;
}

function asRows<T>(value: T[] | T | null): T[] {
  if (value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Better Auth adapter backed by generic records distributed through vshard. */
export const tarantoolAdapter = (db: TarantoolDbShape, options: TarantoolAdapterOptions = {}) =>
  createAdapterFactory({
    config: {
      adapterId: 'tarantool-vshard',
      adapterName: 'Tarantool vshard',
      debugLogs: options.debugLogs ?? false,
      supportsNumericIds: false,
      supportsUUIDs: false,
      supportsJSON: true,
      supportsDates: false,
      supportsBooleans: true,
      supportsArrays: true,
      transaction: false,
    },
    adapter: () => ({
      create: async ({model, data}) =>
        Effect.runPromise(db.call(`api.auth_create`, model, data)),

      findOne: async <T>({model, where}: {model: string; where: any[]}) => {
        const result = await Effect.runPromise(
          db.call<T[] | T | null>('api.auth_find_many', model, where, 1, 0, null));
        const rows = asRows(result);
        return rows[0] ?? null;
      },

      findMany: async <T>({model, where, limit, offset, sortBy}: any) => {
        const result = await Effect.runPromise(db.call<T[] | T | null>(
          'api.auth_find_many', model, where ?? [], limit, offset ?? 0, sortBy ?? null));
        return asRows(result);
      },

      count: async ({model, where}: any) =>
        Effect.runPromise(db.call<number>('api.auth_count', model, where ?? [])),

      update: async <T>({model, where, update}: any) =>
        Effect.runPromise(db.call<T | null>('api.auth_update', model, where, update)),

      updateMany: async ({model, where, update}: any) =>
        Effect.runPromise(db.call<number>('api.auth_update_many', model, where, update, false)),

      delete: async ({model, where}: any) => {
        await Effect.runPromise(db.call('api.auth_delete', model, where));
      },

      deleteMany: async ({model, where}: any) =>
        Effect.runPromise(db.call<number>('api.auth_update_many', model, where, {}, true)),

      consumeOne: async <T>({model, where}: any) =>
        Effect.runPromise(db.call<T | null>('api.auth_consume', model, where)),

      incrementOne: async <T>({model, where, increment, set}: any) =>
        Effect.runPromise(db.call<T | null>('api.auth_increment', model, where, increment, set ?? {})),
    }),
  });
