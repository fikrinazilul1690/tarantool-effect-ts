import {createAdapterFactory, type DBAdapterDebugLogOption} from 'better-auth/adapters';
import {Effect, Schema} from 'effect';
import type {TarantoolDbShape} from '../tarantool/client';

interface TarantoolAdapterOptions {
  debugLogs?: DBAdapterDebugLogOption;
}

const AuthRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const AuthRowsSchema = Schema.Array(AuthRecordSchema);
const OptionalAuthRecordSchema = Schema.NullOr(AuthRecordSchema);

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
        Effect.runPromise(db.call(AuthRecordSchema, `api.auth_create`, model, data)) as Promise<typeof data>,

      findOne: async <T>({model, where}: {model: string; where: any[]}) => {
        const rows = await Effect.runPromise(
          db.call(AuthRowsSchema, 'api.auth_find_many', model, where, 1, 0, null));
        return (rows[0] as T | undefined) ?? null;
      },

      findMany: async <T>({model, where, limit, offset, sortBy}: any) => {
        const rows = await Effect.runPromise(db.call(
          AuthRowsSchema,
          'api.auth_find_many', model, where ?? [], limit, offset ?? 0, sortBy ?? null));
        return rows as T[];
      },

      count: async ({model, where}: any) =>
        Effect.runPromise(db.call(Schema.Number, 'api.auth_count', model, where ?? [])),

      update: async <T>({model, where, update}: any) =>
        Effect.runPromise(db.call(OptionalAuthRecordSchema, 'api.auth_update', model, where, update)) as Promise<T | null>,

      updateMany: async ({model, where, update}: any) =>
        Effect.runPromise(db.call(Schema.Number, 'api.auth_update_many', model, where, update, false)),

      delete: async ({model, where}: any) => {
        await Effect.runPromise(db.call(Schema.Boolean, 'api.auth_delete', model, where));
      },

      deleteMany: async ({model, where}: any) =>
        Effect.runPromise(db.call(Schema.Number, 'api.auth_update_many', model, where, {}, true)),

      consumeOne: async <T>({model, where}: any) =>
        Effect.runPromise(db.call(OptionalAuthRecordSchema, 'api.auth_consume', model, where)) as Promise<T | null>,

      incrementOne: async <T>({model, where, increment, set}: any) =>
        Effect.runPromise(db.call(
          OptionalAuthRecordSchema,
          'api.auth_increment',
          model,
          where,
          increment,
          set ?? {},
        )) as Promise<T | null>,
    }),
  });
