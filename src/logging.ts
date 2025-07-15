import { Config, Env } from './config';

export interface Logger {
    info: (message: any, ...args: any[]) => void;
    error: (message: any, ...args: any[]) => void;
    warn: (message: any, ...args: any[]) => void;
    debug: (message: any, ...args: any[]) => void;
}

class SimpleLogger implements Logger {
    private logLevel: string;
    private isDevelopment: boolean;

    constructor(logLevel: string, isDevelopment: boolean) {
        this.logLevel = logLevel;
        this.isDevelopment = isDevelopment;
    }

    private shouldLog(level: string): boolean {
        const levels = ['error', 'warn', 'info', 'debug'];
        const currentLevelIndex = levels.indexOf(this.logLevel);
        const messageLevelIndex = levels.indexOf(level);
        return messageLevelIndex <= currentLevelIndex;
    }

    private formatMessage(level: string, message: any, ...args: any[]): string {
        const timestamp = new Date().toISOString();
        const levelStr = level.toUpperCase().padEnd(5);
        
        let formattedMessage = typeof message === 'string' ? message : JSON.stringify(message);
        
        if (args.length > 0) {
            const argsStr = args.map(arg => 
                typeof arg === 'string' ? arg : JSON.stringify(arg)
            ).join(' ');
            formattedMessage += ' ' + argsStr;
        }

        if (this.isDevelopment) {
            // Colorful output for development
            const colors = {
                error: '\x1b[31m', // Red
                warn: '\x1b[33m',  // Yellow
                info: '\x1b[36m',  // Cyan
                debug: '\x1b[90m'  // Gray
            };
            const reset = '\x1b[0m';
            const color = colors[level as keyof typeof colors] || '';
            
            return `${color}[${timestamp}] ${levelStr}${reset} ${formattedMessage}`;
        } else {
            // Structured JSON output for production
            return JSON.stringify({
                timestamp,
                level: level.toUpperCase(),
                message: formattedMessage
            });
        }
    }

    info(message: any, ...args: any[]): void {
        if (this.shouldLog('info')) {
            console.log(this.formatMessage('info', message, ...args));
        }
    }

    error(message: any, ...args: any[]): void {
        if (this.shouldLog('error')) {
            console.error(this.formatMessage('error', message, ...args));
        }
    }

    warn(message: any, ...args: any[]): void {
        if (this.shouldLog('warn')) {
            console.warn(this.formatMessage('warn', message, ...args));
        }
    }

    debug(message: any, ...args: any[]): void {
        if (this.shouldLog('debug')) {
            console.log(this.formatMessage('debug', message, ...args));
        }
    }
}

export async function initLogging(config: Config): Promise<Logger> {
    const isDevelopment = config.env === Env.Dev;
    return new SimpleLogger(config.logLevel, isDevelopment);
}