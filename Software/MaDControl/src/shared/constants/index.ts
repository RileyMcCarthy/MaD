// Application constants
export const APP_NAME = 'MaD Control';
export const APP_VERSION = '1.0.0';

// Device constants
export const DEFAULT_BAUD_RATE = 115200;
export const CONNECTION_TIMEOUT = 5000;
export const SAMPLE_BUFFER_SIZE = 100;

// UI constants
export const THEME_MODES = {
  LIGHT: 'light',
  DARK: 'dark',
} as const;

// File extensions
export const FIRMWARE_EXTENSIONS = ['.bin'];
export const GCODE_EXTENSIONS = ['.gcode', '.nc', '.cnc'];

// Error messages
export const ERROR_MESSAGES = {
  CONNECTION_FAILED: 'Failed to connect to device',
  PORT_NOT_FOUND: 'Serial port not found',
  INVALID_FILE_TYPE: 'Invalid file type selected',
  OPERATION_TIMEOUT: 'Operation timed out',
  DEVICE_NOT_RESPONDING: 'Device is not responding',
} as const;
