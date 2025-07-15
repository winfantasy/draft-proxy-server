import { otlpShutdown } from "./telemetry";
import { createServer } from "node:http";
import gracefulShutdown from "http-graceful-shutdown";
import { initApp } from "./app";
import { Env, initConfig } from "./config";
import { initLogging } from "./logging";

const main = async () => {
    const config = await initConfig();
    const logger = await initLogging(config);
    const app = await initApp(config, logger);
    
    // Create HTTP server
    const server = createServer(app.requestListener);
    
    // Setup WebSocket server after HTTP server is created
    app.setupWebSocketServer(server);
    
    // Start listening
    server.listen(config.port, () => {
        logger.info(`🚀 Yahoo WebSocket Proxy Server listening on port ${config.port}`);
        logger.info(`📡 WebSocket endpoint: ws://localhost:${config.port}/yahoo/websocket/proxy`);
        logger.info(`🩺 Health check: http://localhost:${config.port}/health`);
    });

    gracefulShutdown(server, {
        timeout: config.shutdownTimeoutMs,
        development: config.env !== Env.Prod,
        preShutdown: async (signal) => {
            logger.info({ signal }, "Shutdown signal received");
        },
        onShutdown: async () => {
            await app.shutdown();
            await otlpShutdown();
        },
        finally: () => {
            logger.info("Shutdown complete");
        },
    });
}

main().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
});