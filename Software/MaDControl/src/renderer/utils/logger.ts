// Renderer-side logging utility
// Uses console methods but in a structured way that can be easily replaced

interface Logger {
  info: (message: string, ...args: any[]) => void;
  warn: (message: string, ...args: any[]) => void;
  error: (message: string, ...args: any[]) => void;
  debug: (message: string, ...args: any[]) => void;
}

function createRendererLogger(context: string): Logger {
  const prefix = `[${context}]`;

  return {
    info: (message: string, ...args: any[]) => {
      console.info(prefix, message, ...args);
    },
    warn: (message: string, ...args: any[]) => {
      console.warn(prefix, message, ...args);
    },
    error: (message: string, ...args: any[]) => {
      console.error(prefix, message, ...args);
    },
    debug: (message: string, ...args: any[]) => {
      console.debug(prefix, message, ...args);
    },
  };
}

// Pre-configured loggers for different renderer contexts
export const uiLogger = createRendererLogger('UI');
export const deviceLogger = createRendererLogger('Device');
export const dataLogger = createRendererLogger('Data');
export const hookLogger = createRendererLogger('Hook');
export const componentLogger = createRendererLogger('Component');

export default createRendererLogger;
