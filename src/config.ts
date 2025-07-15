export enum Env {
    Dev = 'development',
    Prod = 'production',
    Test = 'test'
}

export interface Config {
    env: Env;
    port: number;
    shutdownTimeoutMs: number;
    maxReconnectAttempts: number;
    heartbeatInterval: number;
    connectionTimeout: number;
    logLevel: string;
}

export async function initConfig(): Promise<Config> {
    const env = (process.env.NODE_ENV as Env) || Env.Dev;
    const port = parseInt(process.env.PORT || '3001', 10);
    const shutdownTimeoutMs = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '30000', 10);
    const maxReconnectAttempts = parseInt(process.env.MAX_RECONNECT_ATTEMPTS || '5', 10);
    const heartbeatInterval = parseInt(process.env.HEARTBEAT_INTERVAL || '30000', 10);
    const connectionTimeout = parseInt(process.env.CONNECTION_TIMEOUT || '10000', 10);
    const logLevel = process.env.LOG_LEVEL || 'info';

    const config: Config = {
        env,
        port,
        shutdownTimeoutMs,
        maxReconnectAttempts,
        heartbeatInterval,
        connectionTimeout,
        logLevel
    };

    // Validate config
    if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port: ${port}`);
    }

    if (isNaN(shutdownTimeoutMs) || shutdownTimeoutMs < 0) {
        throw new Error(`Invalid shutdown timeout: ${shutdownTimeoutMs}`);
    }

    return config;
}