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
import CancelIcon from '@mui/icons-material/Cancel';
import GitHubIcon from '@mui/icons-material/GitHub';
import { componentLogger } from '@renderer/utils/logger';
import { useDevice } from '@renderer/hooks';

function FirmwareUpdate(): React.ReactElement {
  const [deviceState, actions] = useDevice();
  const [firmwareVersion, setFirmwareVersion] = useState('Unknown');
  const [loading, setLoading] = useState(false);
  const [isFlashing, setIsFlashing] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    // Set up event listeners for firmware update progress
    const progressListener = window.electron.ipcRenderer.on(
      'firmware-update-progress',
      (...args: unknown[]) => {
        const message = args[0] as string;
        setLogs((prevLogs) => [...prevLogs, message]);
        setStatus(`Updating: ${message}`);
      },
    );

    // Add dedicated status listener for proper state management
    const statusListener = window.electron.ipcRenderer.on(
      'firmware-flash-status',
      (...args: unknown[]) => {
        const statusData = args[0] as { status: string; message: string };

        switch (statusData.status) {
          case 'preparing':
            setIsFlashing(false);
            setStatus('Preparing firmware flash...');
            break;
          case 'flashing':
            setIsFlashing(true);
            setStatus('Flashing firmware...');
            break;
          case 'success':
            setIsFlashing(false);
            setStatus('Firmware flashed successfully!');
            setError('');
            break;
          case 'error':
            setIsFlashing(false);
            setError(statusData.message);
            break;
          case 'canceled':
            setIsFlashing(false);
            setStatus('Firmware flashing canceled');
            setError('');
            break;
          default:
            componentLogger.warn(
              'Unknown firmware flash status:',
              statusData.status,
            );
        }
      },
    );

    const checkFirmwareVersion = async () => {
      if (deviceState.isResponding) {
        try {
          const versionData = await actions.getFirmwareVersion();
          // Extract version string from FirmwareVersion object
          if (
            versionData &&
            typeof versionData === 'object' &&
            'version' in versionData
          ) {
            setFirmwareVersion(
              (versionData as { version: string }).version || 'Unknown',
            );
          } else if (typeof versionData === 'string') {
            // Handle case where it might still be a string
            setFirmwareVersion(versionData);
          } else {
            setFirmwareVersion('Unknown');
          }
        } catch (err) {
          componentLogger.error('Error getting firmware version:', err);
          setFirmwareVersion('Unknown');
        }
      }
    };

    // Check firmware version when device becomes responsive
    checkFirmwareVersion();

    // Set up interval to check firmware version periodically
    const interval = setInterval(checkFirmwareVersion, 5000);

    // Cleanup function to cancel flashing when component unmounts
    const cleanup = async () => {
      if (isFlashing) {
        try {
          await actions.cancelFirmwareFlash();
          componentLogger.info(
            'Canceled firmware flashing due to page navigation',
          );
        } catch (err) {
          componentLogger.error(
            'Error canceling firmware flash on cleanup:',
            err,
          );
        }
      }
    };

    // Clean up
    return () => {
      clearInterval(interval);
      progressListener();
      statusListener();
      cleanup(); // Cancel any ongoing flashing when leaving the page
    };
  }, [deviceState.isResponding, actions]);

  const getDeviceStatusText = () => {
    if (deviceState.isResponding) {
      return 'Responding';
    }
    if (deviceState.isConnected) {
      return 'Not Responding';
    }
    return 'Disconnected';
  };

  const getStatusColor = () => {
    if (deviceState.isResponding) {
      return 'success';
    }
    if (deviceState.isConnected) {
      return 'warning';
    }
    return 'error';
  };

  const handleFlashFirmware = async () => {
    try {
      setLoading(true);
      setIsFlashing(false);
      setStatus('Selecting firmware file...');
      setError('');
      setLogs([]); // Clear previous logs

      // Add initial log
      setLogs(['Opening file selector...']);

      // Call the flash-from-file handler using the hook
      const result = await actions.flashFirmwareFromFile();

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
      componentLogger.error('Error updating firmware from file:', err);
      setError('Failed to update firmware from file. See console for details.');
    } finally {
      setLoading(false);
      setIsFlashing(false);
    }
  };

  const handleCancelFlash = async () => {
    try {
      const result = await actions.cancelFirmwareFlash();
      if (result.success) {
        setStatus('Firmware flashing canceled');
        setLogs((prevLogs) => [
          ...prevLogs,
          'Firmware flashing canceled by user',
        ]);
      } else {
        setError(result.error || 'Failed to cancel firmware flashing');
      }
    } catch (err) {
      componentLogger.error('Error canceling firmware flash:', err);
      setError('Failed to cancel firmware flashing');
    } finally {
      setIsFlashing(false);
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
                  <strong>{deviceState.isConnected ? 'Connected' : 'Disconnected'}</strong>
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
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Select a firmware file (.bin) from your computer to flash to the
                device. Download firmware files from the GitHub releases link
                above.
              </Typography>

              <Button
                variant="contained"
                color="primary"
                startIcon={<SystemUpdateAltIcon />}
                onClick={handleFlashFirmware}
                disabled={loading || !deviceState.isConnected}
                size="large"
                fullWidth
                sx={{ mb: 1 }}
              >
                {loading ? 'Flashing...' : 'Select & Flash Firmware File'}
              </Button>

              {isFlashing && (
                <Button
                  variant="outlined"
                  color="error"
                  startIcon={<CancelIcon />}
                  onClick={handleCancelFlash}
                  size="large"
                  fullWidth
                >
                  Cancel Firmware Flash
                </Button>
              )}

              {!deviceState.isConnected && (
                <Typography
                  variant="body2"
                  color="error"
                  sx={{ mt: 1, textAlign: 'center' }}
                >
                  Connect to a serial port before flashing firmware
                </Typography>
              )}

              {isFlashing && (
                <Alert severity="warning" sx={{ mt: 2 }}>
                  <Typography variant="body2">
                    <strong>Firmware flashing in progress!</strong>
                    <br />
                    Do not disconnect the device or close the application.
                    <br />
                    This process may take several minutes.
                  </Typography>
                </Alert>
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
                  color={log.startsWith('ERROR:') ? 'error' : 'text.secondary'}
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
