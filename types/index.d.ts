// Type declarations for modules without official types

declare module 'http-graceful-shutdown' {
    import { Server } from 'http';
    
    interface GracefulShutdownOptions {
        timeout?: number;
        development?: boolean;
        preShutdown?: (signal: string) => Promise<void> | void;
        onShutdown?: () => Promise<void> | void;
        finally?: () => void;
    }
    
    function gracefulShutdown(server: Server, options?: GracefulShutdownOptions): void;
    
    export = gracefulShutdown;
}