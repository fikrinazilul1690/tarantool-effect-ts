declare module 'tarantool-driver' {
  interface ConnectionOptions {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    lazyConnect?: boolean;
    timeout?: number;
  }

  class TarantoolConnection {
    constructor(options?: ConnectionOptions);
    connect(): Promise<unknown>;
    call(functionName: string, ...args: unknown[]): Promise<unknown>;
    ping(): Promise<unknown>;
    disconnect(): void;
  }

  export = TarantoolConnection;
}
