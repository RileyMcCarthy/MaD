import React, { useState, useEffect } from 'react';
import {
  Box,
  Paper,
  Typography,
  Button,
  CircularProgress,
  Grid,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material';
import {
  PlayArrow as PlayArrowIcon,
  FolderOpen as FolderOpenIcon,
} from '@mui/icons-material';
import { styled } from '@mui/material/styles';
import {
  TestProfile,
  SampleProfile,
  MotionProfile,
} from '@shared/SharedInterface';
import GCodeGenerator from './GCodeGenerator';
import { componentLogger } from '../utils/logger';
import { useDevice } from '@renderer/hooks';

const Item = styled(Paper)(({ theme }) => ({
  backgroundColor: theme.palette.mode === 'dark' ? '#1A2027' : '#fff',
  ...theme.typography.body2,
  padding: theme.spacing(2),
  color: theme.palette.text.secondary,
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
}));

interface TestRunnerProps {
  onRunTest: (testName: string) => void;
}

export default function TestRunner({ onRunTest }: TestRunnerProps) {
  const [deviceState, actions] = useDevice();
  const [selectedSampleProfile, setSelectedSampleProfile] =
    useState<SampleProfile | null>(null);
  const [selectedMotionProfile, setSelectedMotionProfile] =
    useState<MotionProfile | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [runIndex, setRunIndex] = useState<number | null>(null);
  const [openDialog, setOpenDialog] = useState(false);
  const [generatedGcode, setGeneratedGcode] = useState<string[]>([]);
  const [currentSampleProfileName, setCurrentSampleProfileName] = useState<string>('None');

    // Update current profile name when device state changes
  useEffect(() => {
    if (deviceState.sampleProfile && deviceState.sampleProfile.serial) {
      setCurrentSampleProfileName(deviceState.sampleProfile.serial);
    } else {
      setCurrentSampleProfileName('None');
    }
  }, [deviceState.sampleProfile]);

  const handleSampleProfileSelect = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (file) {
      try {
        const reader = new FileReader();
                reader.onload = async (e) => {
          const content = e.target?.result as string;
          const fileProfile = JSON.parse(content);

          // Convert file format to SampleProfile format for firmware
          const profile: SampleProfile = {
            maxForce: fileProfile.maxForce,
            maxVelocity: fileProfile.maxVelocity,
            maxDisplacement: fileProfile.maxDisplacement,
            sampleWidth: fileProfile.sampleWidth,
            sampleThickness: fileProfile.sampleThickness,
            serial: typeof fileProfile.serial === 'string' ? fileProfile.serial : fileProfile.serial.toString(),
          };

                              // Save profile to firmware
          const success = await actions.saveSampleProfile(profile);
          if (success) {
            componentLogger.info('Sample profile saved to firmware successfully');
            setSelectedSampleProfile(profile);

            // Get the run index for this sample
            const newRunIndex = await window.electron.ipcRenderer.invoke(
              'sample-profile-run',
              profile.serial,
            );
            setRunIndex(newRunIndex);
            // Format the test name with zero-padded numbers
            const paddedSerialNumber = profile.serial.padStart(4, '0');
            const paddedRunIndex = newRunIndex.toString().padStart(3, '0');
            const testName = `${paddedSerialNumber}-${paddedRunIndex}`;
            onRunTest(testName);
          } else {
            componentLogger.error('Failed to save sample profile to firmware');
          }
        };
        reader.readAsText(file);
      } catch (error) {
        componentLogger.error('Error reading sample profile:', error);
      }
    }
  };

  const handleMotionProfileSelect = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (file) {
      try {
        const reader = new FileReader();
        reader.onload = (e) => {
          const content = e.target?.result as string;
          const profile = JSON.parse(content) as MotionProfile;
          setSelectedMotionProfile(profile);
        };
        reader.readAsText(file);
      } catch (error) {
        componentLogger.error('Error reading motion profile:', error);
      }
    }
  };

  const handleOpenDialog = () => {
    setOpenDialog(true);
  };

  const handleCloseDialog = () => {
    setOpenDialog(false);
  };

  const handleRunTest = async () => {
    if (!selectedSampleProfile || !selectedMotionProfile || runIndex === null)
      return;

    try {
      setIsLoading(true);

      // Format the test name with zero-padded numbers
      const paddedSerialNumber = selectedSampleProfile.serial.padStart(4, '0');
      const paddedRunIndex = runIndex.toString().padStart(3, '0');
      const testName = `${paddedSerialNumber}-${paddedRunIndex}`;

      // Run the test with the formatted name and generated gcode
      await window.electron.ipcRenderer.invoke('run-test', {
        sampleProfile: selectedSampleProfile,
        gcode: generatedGcode,
        testName,
      });
      handleCloseDialog();
    } catch (error) {
      componentLogger.error('Failed to run test:', error);
      alert('Failed to run test');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Box sx={{ flexGrow: 1 }}>
      <Item>
        <Typography variant="h6" gutterBottom>
          Test Runner
        </Typography>
        <Grid container spacing={2}>
          <Grid item xs={12}>
            {currentSampleProfileName ? (
              <Box>
                <Typography variant="body2" color="textPrimary" sx={{ mb: 1 }}>
                  Sample Profile: <strong>{currentSampleProfileName}</strong>
                </Typography>
                <Button
                  variant="outlined"
                  component="label"
                  startIcon={<FolderOpenIcon />}
                  fullWidth
                  size="small"
                >
                  Change Sample Profile
                  <input
                    type="file"
                    hidden
                    accept=".sp"
                    onChange={handleSampleProfileSelect}
                  />
                </Button>
              </Box>
            ) : (
              <Button
                variant="contained"
                component="label"
                startIcon={<FolderOpenIcon />}
                fullWidth
              >
                Load Sample Profile
                <input
                  type="file"
                  hidden
                  accept=".sp"
                  onChange={handleSampleProfileSelect}
                />
              </Button>
            )}
          </Grid>
          <Grid item xs={12}>
            <Button
              variant="contained"
              color="primary"
              onClick={handleOpenDialog}
              fullWidth
              disabled={!currentSampleProfileName || isLoading || Boolean(deviceState.machineState?.testRunning)}
              startIcon={isLoading || deviceState.machineState?.testRunning ? <CircularProgress size={20} color="inherit" /> : <PlayArrowIcon />}
            >
              {isLoading || deviceState.machineState?.testRunning ? 'Test Running...' : 'Run Test'}
            </Button>
          </Grid>
        </Grid>
      </Item>

      <Dialog
        open={openDialog}
        onClose={handleCloseDialog}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>Run Test - Select Motion Profile</DialogTitle>
        <DialogContent>
          <Box sx={{ mb: 3 }}>
            <Typography variant="h6" gutterBottom>
              Motion Profile
            </Typography>
            <Button
              variant="contained"
              component="label"
              startIcon={<FolderOpenIcon />}
              fullWidth
              sx={{ mb: 2 }}
            >
              Select Motion Profile
              <input
                type="file"
                hidden
                accept=".mp"
                onChange={handleMotionProfileSelect}
              />
            </Button>
            {selectedMotionProfile && (
              <Typography variant="body2" color="primary" sx={{ mb: 2 }}>
                Selected: <strong>{selectedMotionProfile.name}</strong>
              </Typography>
            )}
          </Box>

          {selectedSampleProfile && selectedMotionProfile && (
            <Box>
              <Typography variant="h6" gutterBottom>
                G-code Preview
              </Typography>
              <GCodeGenerator
                profile={
                  {
                    ...selectedMotionProfile,
                    sampleProfile: selectedSampleProfile,
                  } as unknown as TestProfile
                }
                onGcodeGenerated={setGeneratedGcode}
              />
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseDialog} color="primary">
            Close
          </Button>
          <Button
            onClick={handleRunTest}
            color="primary"
            variant="contained"
            disabled={isLoading || !selectedMotionProfile || Boolean(deviceState.machineState?.testRunning)}
            startIcon={
              isLoading || deviceState.machineState?.testRunning ? <CircularProgress size={24} /> : <PlayArrowIcon />
            }
          >
            {isLoading || deviceState.machineState?.testRunning ? 'Running...' : 'Run Test'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
