import React, { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Typography,
  Paper,
  Grid,
  CircularProgress,
  Alert,
  Card,
  CardContent,
  Link,
  Divider,
} from '@mui/material';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import GitHubIcon from '@mui/icons-material/GitHub';

function FirmwareUpdate(): React.ReactElement {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [firmwareVersion, setFirmwareVersion] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isResponding, setIsResponding] = useState(false);

  useEffect(() => {
    // Set up event listeners for firmware update progress and errors
    const progressListener = window.electron.ipcRenderer.on(
      'firmware-update-progress',
      (...args: unknown[]) => {
        const message = args[0] as string;
        setLogs((prevLogs) => [...prevLogs, message]);
        setStatus(`Updating: ${message}`);
      },
    );

    const errorListener = window.electron.ipcRenderer.on(
      'firmware-update-error',
      (...args: unknown[]) => {
        const message = args[0] as string;
        setLogs((prevLogs) => [...prevLogs, `ERROR: ${message}`]);
        setError(message);
      },
    );

    // Check device connection status
    const checkConnection = async () => {
      try {
        // Check if a serial port is connected
        const connected =
          await window.electron.ipcRenderer.invoke('device-connected');
        setIsConnected(connected);

        // Check if the device is responding to commands
        const responding =
          await window.electron.ipcRenderer.invoke('device-responding');
        setIsResponding(responding);

        if (responding) {
          // Get current firmware version
          const version = await window.electron.ipcRenderer.invoke(
            'get-firmware-version',
          );
          setFirmwareVersion(version || 'Unknown');
        }
      } catch (err) {
        console.error('Error checking connection:', err);
        setError('Failed to check device connection');
      }
    };

    const interval = setInterval(checkConnection, 2000);

    // Initial check
    checkConnection();

    // Clean up
    return () => {
      clearInterval(interval);
      progressListener();
      errorListener();
    };
  }, []);

  const getDeviceStatusText = () => {
    if (isResponding) {
      return 'Responding';
    }
    if (isConnected) {
      return 'Not Responding';
    }
    return 'Disconnected';
  };

  const getStatusColor = () => {
    if (isResponding) {
      return 'success';
    }
    if (isConnected) {
      return 'warning';
    }
    return 'error';
  };

  const handleFlashFirmware = async () => {
    try {
      setLoading(true);
      setStatus('Selecting firmware file...');
      setError('');
      setLogs([]); // Clear previous logs

      // Add initial log
      setLogs(['Opening file selector...']);

      // Call the flash-from-file handler
      const result =
        await window.electron.ipcRenderer.invoke('flash-from-file');

      if (result.success) {
        setStatus('Firmware updated successfully from file!');
      } else if (result.error === 'File selection was cancelled') {
        setStatus('File selection cancelled');
        setLogs((prevLogs) => [
          ...prevLogs,
          'File selection cancelled by user',
        ]);
      } else {
        setError(result.error || 'Unknown error occurred');
      }
    } catch (err) {
      console.error('Error updating firmware from file:', err);
      setError(
        'Failed to update firmware from file. See console for details.',
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" gutterBottom>
        Propeller 2 Firmware Update
      </Typography>

      <Grid container spacing={3}>
        <Grid item xs={12} md={6}>
          <Card variant="outlined" sx={{ mb: 2 }}>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Device Status
              </Typography>
              <Alert severity={getStatusColor()} sx={{ mb: 2 }}>
                <Typography>
                  Connection:{' '}
                  <strong>{isConnected ? 'Connected' : 'Disconnected'}</strong>
                </Typography>
                <Typography>
                  Device: <strong>{getDeviceStatusText()}</strong>
                </Typography>
                <Typography>
                  Current Firmware: <strong>{firmwareVersion}</strong>
                </Typography>
              </Alert>

              <Box sx={{ mb: 2 }}>
                <Link
                  href="https://github.com/RileyMcCarthy/MaD/releases?q=firmware&expanded=true"
                  target="_blank"
                  rel="noopener"
                  sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
                >
                  <GitHubIcon fontSize="small" />
                  Download Firmware from GitHub Releases
                </Link>
              </Box>

              <Divider sx={{ my: 2 }} />

              <Typography variant="h6" gutterBottom>
                Flash Firmware
              </Typography>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mb: 2 }}
              >
                Select a firmware file (.bin) from your computer to flash to the
                device. Download firmware files from the GitHub releases link
                above.
              </Typography>

              <Button
                variant="contained"
                color="primary"
                startIcon={<SystemUpdateAltIcon />}
                onClick={handleFlashFirmware}
                disabled={loading || !isConnected}
                size="large"
                fullWidth
              >
                {loading ? 'Flashing...' : 'Select & Flash Firmware File'}
              </Button>

              {!isConnected && (
                <Typography
                  variant="body2"
                  color="error"
                  sx={{ mt: 1, textAlign: 'center' }}
                >
                  Connect to a serial port before flashing firmware
                </Typography>
              )}
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={6}>
          <Paper
            elevation={1}
            sx={{
              p: 2,
              minHeight: '400px',
              maxHeight: '500px',
              backgroundColor: '#1e1e1e',
              overflow: 'auto',
            }}
          >
            <Typography
              variant="subtitle2"
              color="text.secondary"
              sx={{ mb: 1 }}
            >
              Update Log:
            </Typography>
            {loading && (
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                <CircularProgress size={20} sx={{ mr: 1 }} />
                <Typography variant="body2">{status}</Typography>
              </Box>
            )}
            {status && !loading && (
              <Typography variant="body2" color="text.secondary">
                {status}
              </Typography>
            )}
            {error && (
              <Typography variant="body2" color="error">
                Error: {error}
              </Typography>
            )}

            <Divider sx={{ my: 1, borderColor: 'rgba(255,255,255,0.1)' }} />

            {/* Log messages */}
            <Box sx={{ mt: 2, fontFamily: 'monospace', fontSize: '0.85rem' }}>
              {logs.map((log) => (
                <Typography
                  key={`${log}-${Math.random()}`}
                  variant="body2"
                  color={
                    log.startsWith('ERROR:') ? 'error' : 'text.secondary'
                  }
                  sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
                >
                  {log}
                </Typography>
              ))}
            </Box>
          </Paper>
        </Grid>
      </Grid>
    </Box>
  );
}

export default FirmwareUpdate;
