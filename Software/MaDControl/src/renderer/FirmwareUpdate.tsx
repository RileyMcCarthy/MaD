import React, { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Typography,
  Paper,
  Grid,
  CircularProgress,
  Stepper,
  Step,
  StepLabel,
  Alert,
  Card,
  CardContent,
  Link,
  Divider,
} from '@mui/material';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import GitHubIcon from '@mui/icons-material/GitHub';
import CloudDownloadIcon from '@mui/icons-material/CloudDownload';

const FirmwareUpdate: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [activeStep, setActiveStep] = useState(0);
  const [firmwareVersion, setFirmwareVersion] = useState('');
  const [latestVersion, setLatestVersion] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isResponding, setIsResponding] = useState(false);
  const [needsUpdate, setNeedsUpdate] = useState(false);
  const [checkingVersion, setCheckingVersion] = useState(false);
  const [skipConnectionCheck, setSkipConnectionCheck] = useState(false);

  const steps = ['Connect Device', 'Check Version', 'Download & Flash'];

  // Function to compare version strings
  const compareVersions = (current: string, latest: string): boolean => {
    if (!current || !latest || current === 'Unknown' || latest === 'Unknown' || latest === 'No release found') {
      return false;
    }

    // Clean up version strings to handle formats like "v1.2.3" or "1.2.3"
    const currentParts = current.replace(/^v/, '').split('.').map(Number);
    const latestParts = latest.replace(/^v/, '').split('.').map(Number);

    // Compare each part of the version
    for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
      const currentPart = currentParts[i] || 0;
      const latestPart = latestParts[i] || 0;

      if (latestPart > currentPart) {
        return true; // Latest version is greater
      } else if (latestPart < currentPart) {
        return false; // Current version is greater (somehow)
      }
    }

    return false; // Versions are equal
  };

  useEffect(() => {
    // Set up event listeners for firmware update progress and errors
    const progressListener = window.electron.ipcRenderer.on(
      'firmware-update-progress',
      (...args: unknown[]) => {
        const message = args[0] as string;
        setLogs((prevLogs) => [...prevLogs, message]);
        setStatus(`Updating: ${message}`);
      }
    );

    const errorListener = window.electron.ipcRenderer.on(
      'firmware-update-error',
      (...args: unknown[]) => {
        const message = args[0] as string;
        setLogs((prevLogs) => [...prevLogs, `ERROR: ${message}`]);
        setError(message);
      }
    );

    // Check device connection status
    const checkConnection = async () => {
      try {
        // Check if a serial port is connected
        const connected = await window.electron.ipcRenderer.invoke('device-connected');
        setIsConnected(connected);

        // Check if the device is responding to commands
        const responding = await window.electron.ipcRenderer.invoke('device-responding');
        setIsResponding(responding);

        if (responding) {
          // Get current firmware version
          const version = await window.electron.ipcRenderer.invoke('get-firmware-version');
          setFirmwareVersion(version || 'Unknown');

          // If responding, move to step 1
          if (activeStep === 0) {
            setActiveStep(1);
          }
        } else if (connected && !responding && activeStep === 0) {
          // If connected but not responding, show the warning and allow proceeding
          setActiveStep(0);
        } else if (!skipConnectionCheck && !connected) {
          // Only reset to step 0 if we're not skipping the connection check
          // and no device is connected
          setActiveStep(0);
        }
      } catch (err) {
        console.error('Error checking connection:', err);
        setError('Failed to check device connection');
      }
    };

    const interval = setInterval(checkConnection, 2000);

    // Initial check
    checkConnection();

    // Check for latest firmware version
    const checkLatestVersion = async () => {
      try {
        setCheckingVersion(true);
        const latest = await window.electron.ipcRenderer.invoke('get-latest-firmware-version');
        setLatestVersion(latest || 'Unknown');

        // Determine if update is needed
        if (firmwareVersion && latest) {
          setNeedsUpdate(compareVersions(firmwareVersion, latest));
        }
        setCheckingVersion(false);
      } catch (err) {
        console.error('Error checking latest version:', err);
        setCheckingVersion(false);
      }
    };

    checkLatestVersion();

    // Clean up
    return () => {
      clearInterval(interval);
      progressListener();
      errorListener();
    };
  }, [activeStep, firmwareVersion, skipConnectionCheck]);

  const handleFlashFirmware = async () => {
    try {
      setLoading(true);
      setStatus('Initializing firmware update process...');
      setError('');
      setLogs([]); // Clear previous logs

      // Add initial log
      setLogs(['Starting firmware update...', 'Downloading firmware from GitHub...']);

      // Start the firmware update process
      const defaultRepoUrl = 'https://github.com/RileyMcCarthy/MaD-Firmware';
      const result = await window.electron.ipcRenderer.invoke('update-firmware', defaultRepoUrl);

      if (result.success) {
        setStatus('Firmware updated successfully!');
        // Move to step 3 (completed)
        setActiveStep(3);
      } else {
        setError(result.error || 'Unknown error occurred');
      }
    } catch (err) {
      console.error('Error updating firmware:', err);
      setError('Failed to update firmware. See console for details.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" gutterBottom>
        Propeller 2 Firmware Update
      </Typography>

      <Paper elevation={3} sx={{ p: 3, mb: 3 }}>
        <Stepper activeStep={activeStep} sx={{ mb: 4 }}>
          {steps.map((label) => (
            <Step key={label}>
              <StepLabel>{label}</StepLabel>
            </Step>
          ))}
        </Stepper>

        <Grid container spacing={3}>
          <Grid item xs={12} md={6}>
            <Card variant="outlined" sx={{ mb: 2 }}>
              <CardContent>
                <Typography variant="h6" gutterBottom>
                  Device Status
                </Typography>
                <Typography>
                  Connection: <strong>{isConnected ? 'Connected' : 'Disconnected'}</strong>
                </Typography>
                <Typography>
                  Device: <strong>{isResponding ? 'Responding' : (isConnected ? 'Not Responding' : 'Disconnected')}</strong>
                </Typography>
                <Typography>
                  Current Firmware: <strong>{firmwareVersion}</strong>
                </Typography>
                <Typography>
                  Latest Available: <strong>{checkingVersion ? 'Checking...' : latestVersion}</strong>
                </Typography>
                <Box sx={{ mt: 2 }}>
                  <Link
                    href="https://github.com/RileyMcCarthy/MaD-Firmware/releases"
                    target="_blank"
                    rel="noopener"
                    sx={{ display: 'flex', alignItems: 'center', gap: 1 }}
                  >
                    <GitHubIcon fontSize="small" />
                    View Releases on GitHub
                  </Link>
                </Box>
              </CardContent>
            </Card>

            <Card variant="outlined" sx={{ mb: 2 }}>
              <CardContent>
                <Typography variant="h6" gutterBottom>
                  Automatic Update
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  This tool will automatically download and flash the latest firmware from GitHub.
                  No local repository is required.
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                  <CloudDownloadIcon sx={{ mr: 1, color: 'primary.main' }} />
                  <Typography variant="body2">
                    Downloads firmware directly from GitHub
                  </Typography>
                </Box>
              </CardContent>
            </Card>

            {activeStep === 0 && (
              <>
                {!isConnected ? (
                  <Alert severity="error" sx={{ mb: 2 }}>
                    No serial port connected. Please connect to a port first.
                  </Alert>
                ) : !isResponding ? (
                  <Alert severity="warning" sx={{ mb: 2 }}>
                    Device is connected but not responding. This is normal for a new device that needs firmware.
                  </Alert>
                ) : (
                  <Alert severity="info" sx={{ mb: 2 }}>
                    Device is connected and responding. Checking firmware version...
                  </Alert>
                )}

                {isConnected && !isResponding && (
                  <>
                    <Button
                      variant="contained"
                      color="warning"
                      onClick={() => {
                        setSkipConnectionCheck(true);
                        setActiveStep(2);
                      }}
                      sx={{ mt: 2, mb: 1 }}
                    >
                      Skip Version Check & Flash Now
                    </Button>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      Use this to flash a brand new device that isn't responding yet.
                      Your serial port is connected but the device isn't responding.
                    </Typography>
                  </>
                )}

                {!isConnected && (
                  <Typography variant="body2" color="error" sx={{ mt: 2 }}>
                    You need to connect to a serial port before proceeding.
                  </Typography>
                )}
              </>
            )}

            {activeStep === 1 && (
              <>
                {needsUpdate ? (
                  <Alert severity="warning" sx={{ mb: 2 }}>
                    A newer firmware version is available ({latestVersion})
                  </Alert>
                ) : latestVersion === 'No release found' ? (
                  <Alert severity="info" sx={{ mb: 2 }}>
                    No release found on GitHub
                  </Alert>
                ) : (
                  <Alert severity="success" sx={{ mb: 2 }}>
                    Your firmware is up to date
                  </Alert>
                )}
                <Button
                  variant="contained"
                  color="primary"
                  startIcon={<SystemUpdateAltIcon />}
                  onClick={() => setActiveStep(2)}
                  sx={{ mt: 2 }}
                  disabled={!isConnected || checkingVersion}
                >
                  Proceed to Update
                </Button>
              </>
            )}

            {activeStep === 2 && (
              <>
                <Alert severity="warning" sx={{ mb: 2 }}>
                  Do not disconnect the device during firmware update!
                </Alert>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <Button
                    variant="contained"
                    color="primary"
                    startIcon={<CloudDownloadIcon />}
                    onClick={handleFlashFirmware}
                    disabled={loading || !isConnected}
                  >
                    Download & Flash Firmware
                  </Button>

                  <Button
                    variant="outlined"
                    color="primary"
                    startIcon={<SystemUpdateAltIcon />}
                    onClick={async () => {
                      try {
                        setLoading(true);
                        setStatus('Selecting firmware file...');
                        setError('');
                        setLogs([]); // Clear previous logs

                        // Add initial log
                        setLogs(['Opening file selector...']);

                        // Call the flash-from-file handler
                        const result = await window.electron.ipcRenderer.invoke('flash-from-file');

                        if (result.success) {
                          setStatus('Firmware updated successfully from file!');
                          // Move to step 3 (completed)
                          setActiveStep(3);
                        } else if (result.error === 'File selection was cancelled') {
                          setStatus('File selection cancelled');
                          setLogs((prevLogs) => [...prevLogs, 'File selection cancelled by user']);
                        } else {
                          setError(result.error || 'Unknown error occurred');
                        }
                      } catch (err) {
                        console.error('Error updating firmware from file:', err);
                        setError('Failed to update firmware from file. See console for details.');
                      } finally {
                        setLoading(false);
                      }
                    }}
                    disabled={loading || !isConnected}
                  >
                    Flash from Local File
                  </Button>
                </Box>
              </>
            )}

            {activeStep === 3 && (
              <Alert severity="success" sx={{ mb: 2 }}>
                Firmware update complete! Device is running version {latestVersion}.
              </Alert>
            )}
          </Grid>

          <Grid item xs={12} md={6}>
            <Paper
              elevation={1}
              sx={{
                p: 2,
                minHeight: '200px',
                maxHeight: '400px',
                backgroundColor: '#1e1e1e',
                overflow: 'auto'
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
                {logs.map((log, index) => (
                  <Typography
                    key={`log-${index}`}
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
      </Paper>
    </Box>
  );
};

export default FirmwareUpdate;
