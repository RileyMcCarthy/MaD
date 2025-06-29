import log from 'electron-log';

// Configure electron-log
log.transports.file.level = 'info';
log.transports.console.level = 'debug';

export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug',
}

export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  private formatMessage(message: string): string {
    return `[${this.context}] ${message}`;
  }

  error(message: string, ...args: any[]): void {
    log.error(this.formatMessage(message), ...args);
  }

  warn(message: string, ...args: any[]): void {
    log.warn(this.formatMessage(message), ...args);
  }

  info(message: string, ...args: any[]): void {
    log.info(this.formatMessage(message), ...args);
  }

  debug(message: string, ...args: any[]): void {
    log.debug(this.formatMessage(message), ...args);
  }
}

// Create logger instances for different modules
export const createLogger = (context: string): Logger => new Logger(context);

// Pre-configured loggers for common modules
export const deviceLogger = createLogger('DeviceInterface');
export const serialLogger = createLogger('SerialPort');
export const dataLogger = createLogger('DataProcessor');
export const uiLogger = createLogger('UI');
