import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  TextField,
  Button,
  MenuItem,
  Box,
  Grid,
  Typography,
  Autocomplete,
  IconButton,
  Tooltip,
  Alert,
  CircularProgress,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useDevice } from '@renderer/hooks';
import { componentLogger } from '../utils/logger';

const baudRates = [
  9600, 14400, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
];

// Common serial port paths for different platforms
const commonPorts = [
  '/dev/ttyUSB0',
  '/dev/ttyUSB1',
  '/dev/ttyACM0',
  '/dev/ttyACM1',
  '/dev/serial0',
  '/dev/ttyS0',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
];

function Connect() {
  const [, actions] = useDevice();
  const [ports, setPorts] = useState<string[]>([]);
  const [selectedPort, setSelectedPort] = useState<string>('/dev/serial0');
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<{
    status: 'idle' | 'connecting' | 'success' | 'error';
    message: string;
  }>({ status: 'idle', message: '' });
  const hasLoadedInitially = useRef(false);

  const loadPorts = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      componentLogger.info('Loading ports...');
      const newPorts = await actions.listPorts();
      componentLogger.info('Ports loaded:', newPorts);

      if (newPorts && newPorts.length > 0) {
        setPorts(newPorts);
        // Set the first port as default only on initial load (when selectedPort is the default value)
        setSelectedPort((current) => {
          if (!current || current === '/dev/serial0') {
            return newPorts[0];
          }
          return current;
        });
      } else {
        // If no ports found, show common ports as options
        setPorts(commonPorts);
        setErrorMessage('No serial ports detected. Showing common port names.');
      }
    } catch (err) {
      componentLogger.error('Failed to list ports:', err);
      setPorts(commonPorts);
      setErrorMessage('Failed to load ports. Showing common port names.');
    } finally {
      setLoading(false);
    }
  }, [actions]);

  useEffect(() => {
    if (!hasLoadedInitially.current) {
      hasLoadedInitially.current = true;
      // Inline the port loading logic to avoid dependency issues
      const initialLoadPorts = async () => {
        setLoading(true);
        setErrorMessage(null);
        try {
          componentLogger.info('Loading ports...');
          const newPorts = await actions.listPorts();
          componentLogger.info('Ports loaded:', newPorts);

          if (newPorts && newPorts.length > 0) {
            setPorts(newPorts);
            setSelectedPort(newPorts[0]);
          } else {
            // If no ports found, show common ports as options
            setPorts(commonPorts);
            setErrorMessage('No serial ports detected. Showing common port names.');
          }
        } catch (err) {
          componentLogger.error('Failed to list ports:', err);
          setPorts(commonPorts);
          setErrorMessage('Failed to load ports. Showing common port names.');
        } finally {
          setLoading(false);
        }
      };
      initialLoadPorts();
    }
  }, [actions]);

  const handleConnect = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    const portValue = formData.get('port') || selectedPort;
    const baudRateValue = formData.get('baudRate');

    if (!portValue || !baudRateValue) {
      componentLogger.error('Port and baud rate are required');
      setConnectionStatus({
        status: 'error',
        message: 'Port and baud rate are required'
      });
      return;
    }

    const baudRate = parseInt(baudRateValue.toString(), 10);

    if (Number.isNaN(baudRate)) {
      componentLogger.error('Invalid baud rate');
      setConnectionStatus({
        status: 'error',
        message: 'Invalid baud rate'
      });
      return;
    }

    setConnectionStatus({
      status: 'connecting',
      message: `Connecting to ${portValue} at ${baudRate} baud...`
    });

    try {
      const result = await actions.connect(portValue.toString(), baudRate);
      componentLogger.info('Connection result:', result);
      setConnectionStatus({
        status: 'success',
        message: result || `Successfully connected to ${portValue}`
      });
    } catch (connectError) {
      componentLogger.error('Failed to connect:', connectError);
      const errorMsg = connectError instanceof Error ? connectError.message : 'Unknown connection error';
      setConnectionStatus({
        status: 'error',
        message: `Failed to connect: ${errorMsg}`
      });
    }
  };

  const getHelperText = () => {
    if (errorMessage) return errorMessage;
    if (loading) return 'Loading ports...';
    return ''; // Remove the available ports text
  };

  return (
    <Grid
      container
      justifyContent="center"
      alignItems="center"
      minHeight="100vh"
    >
      <Grid item xs={6}>
        <Box
          display="flex"
          flexDirection="column"
          justifyContent="center"
          alignItems="center"
          height="100%"
          gap={2}
          component="form"
          onSubmit={handleConnect}
        >
          <Typography variant="h4" component="h1">
            Connect to Device
          </Typography>
          <Box width={1} display="flex" alignItems="flex-end" gap={1}>
            <Autocomplete
              freeSolo
              options={ports}
              value={selectedPort}
              inputValue={selectedPort}
              onInputChange={(event, newInputValue) => {
                setSelectedPort(newInputValue || '');
              }}
              onChange={(event, newValue) => {
                if (newValue) {
                  setSelectedPort(newValue);
                }
              }}
              renderInput={(params) => (
                <TextField
                  // eslint-disable-next-line react/jsx-props-no-spreading
                  {...params}
                  label="Port"
                  name="port"
                  fullWidth
                  size="small"
                  helperText={getHelperText()}
                  error={!!errorMessage}
                />
              )}
              loading={loading}
              loadingText="Loading ports..."
              noOptionsText="No ports available"
              sx={{ flexGrow: 1 }}
            />
            <Tooltip title="Refresh ports">
              <IconButton
                onClick={loadPorts}
                disabled={loading}
                size="small"
                sx={{ mb: errorMessage ? 3 : 0.5 }} // Adjust margin based on whether there's an error message
              >
                <RefreshIcon />
              </IconButton>
            </Tooltip>
          </Box>
          <TextField
            select
            label="Baud Rate"
            name="baudRate"
            defaultValue={230400} // Set default baud rate
            fullWidth
          >
            {baudRates.map((option) => (
              <MenuItem key={option} value={option}>
                {option}
              </MenuItem>
            ))}
          </TextField>

          <Button type="submit" variant="contained" color="primary" disabled={connectionStatus.status === 'connecting'}>
            {connectionStatus.status === 'connecting' ? (
              <>
                <CircularProgress size={20} sx={{ mr: 1 }} />
                Connecting...
              </>
            ) : (
              'Connect'
            )}
          </Button>

          {connectionStatus.status !== 'idle' && (
            <Alert
              severity={
                connectionStatus.status === 'success' ? 'success' :
                connectionStatus.status === 'error' ? 'error' : 'info'
              }
              sx={{ width: '100%', mt: 1 }}
            >
              {connectionStatus.message}
            </Alert>
          )}
        </Box>
      </Grid>
    </Grid>
  );
}

export default Connect;
