import React, { useState } from 'react';
import {
  Box,
  Typography,
  Button,
  CircularProgress,
  Grid,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Divider,
} from '@mui/material';
import {
  PlayArrow as PlayArrowIcon,
  Add as AddIcon,
} from '@mui/icons-material';
import { TestProfile } from '@shared/SharedInterface';
import GCodeGenerator from './GCodeGenerator';
import { CardPanel } from './StyledComponents';
import { componentLogger } from '../utils/logger';
import { useDevice, useProfiles } from '@renderer/hooks';

interface TestRunnerProps {
  onRunTest: (testName: string) => void;
}

export default function TestRunner({ onRunTest }: TestRunnerProps) {
  const [deviceState, actions] = useDevice();
  const {
    sampleProfiles,
    motionProfiles,
    refreshProfiles,
    importSampleProfileFromFile,
    importMotionProfileFromFile,
  } = useProfiles();

  const [selectedSampleProfileId, setSelectedSampleProfileId] =
    useState<string>('');
  const [selectedMotionProfileId, setSelectedMotionProfileId] =
    useState<string>('');

  const [isLoading, setIsLoading] = useState(false);
  const [openDialog, setOpenDialog] = useState(false);
  const [generatedGcode, setGeneratedGcode] = useState<string[]>([]);

  // Derive current profile name from selection
  const currentSampleProfileName =
    sampleProfiles.find((p) => p.id === selectedSampleProfileId)?.name ||
    'None';

  const selectedSampleProfile = sampleProfiles.find(
    (p) => p.id === selectedSampleProfileId,
  )?.profile;
  const selectedMotionProfile = motionProfiles.find(
    (p) => p.id === selectedMotionProfileId,
  )?.profile;

  const handleSampleProfileChange = async (profileId: string) => {
    setSelectedSampleProfileId(profileId);
    const entry = sampleProfiles.find((p) => p.id === profileId);
    if (!entry) return;

    // Save profile to firmware
    const success = await actions.saveSampleProfile(entry.profile);
    if (success) {
      componentLogger.info('Sample profile saved to firmware');
    } else {
      componentLogger.error('Failed to save sample profile to firmware');
    }
  };

  const handleImportSampleProfile = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const entry = await importSampleProfileFromFile(event);
    if (entry?.id) {
      handleSampleProfileChange(entry.id);
    }
  };

  const handleImportMotionProfile = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const entry = await importMotionProfileFromFile(event);
    if (entry?.id) {
      setSelectedMotionProfileId(entry.id);
    }
  };

  const handleOpenDialog = () => {
    setOpenDialog(true);
    refreshProfiles();
  };

  const handleCloseDialog = () => {
    setOpenDialog(false);
  };

  const handleRunTest = async () => {
    if (!selectedSampleProfile || !selectedMotionProfile) return;

    try {
      setIsLoading(true);

      // Run the test — firmware assigns the test name from SD card index
      const result = await window.electron.ipcRenderer.invoke('run-test', {
        gcode: generatedGcode,
      });

      if (!result.success || !result.testName) {
        throw new Error(result.error || 'Failed to start test');
      }

      const testName: string = result.testName;

      // Create test run entry in database with firmware-assigned name
      await window.electron.ipcRenderer.invoke('data-create-test-run', {
        testName,
        sampleProfileId: selectedSampleProfileId,
        motionProfileId: selectedMotionProfileId,
        sampleProfile: selectedSampleProfile,
        motionProfile: selectedMotionProfile,
        gcode: generatedGcode,
      });

      onRunTest(testName);
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
      <CardPanel sx={{ p: 2, height: '100%', display: 'flex', flexDirection: 'column' }}>
        <Typography variant="h6" gutterBottom>
          Test Runner
        </Typography>
        <Grid container spacing={2}>
          <Grid item xs={12}>
            <Typography variant="body2" color="textPrimary" sx={{ mb: 1 }}>
              Sample Profile:{' '}
              <strong>{currentSampleProfileName || 'None'}</strong>
            </Typography>
          </Grid>
          <Grid item xs={12}>
            <Button
              variant="contained"
              color="primary"
              onClick={handleOpenDialog}
              fullWidth
              disabled={
                isLoading ||
                Boolean(deviceState.machineState?.testRunning)
              }
              startIcon={
                isLoading || deviceState.machineState?.testRunning ? (
                  <CircularProgress size={20} color="inherit" />
                ) : (
                  <PlayArrowIcon />
                )
              }
            >
              {isLoading || deviceState.machineState?.testRunning
                ? 'Test Running...'
                : 'Run Test'}
            </Button>
          </Grid>
        </Grid>
      </CardPanel>

      <Dialog
        open={openDialog}
        onClose={handleCloseDialog}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>Run Test</DialogTitle>
        <DialogContent>
          {/* Sample Profile Selection */}
          <Box sx={{ mb: 3, mt: 1 }}>
            <Typography variant="h6" gutterBottom>
              Sample Profile
            </Typography>
            <FormControl fullWidth sx={{ mb: 1 }}>
              <InputLabel>Select Sample Profile</InputLabel>
              <Select
                value={selectedSampleProfileId}
                label="Select Sample Profile"
                onChange={(e) =>
                  handleSampleProfileChange(e.target.value as string)
                }
              >
                {sampleProfiles.map((sp) => (
                  <MenuItem key={sp.id} value={sp.id}>
                    {sp.name} — {sp.profile.maxForce}N,{' '}
                    {sp.profile.maxDisplacement}mm
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Button
              variant="outlined"
              component="label"
              startIcon={<AddIcon />}
              size="small"
            >
              Import from File
              <input
                type="file"
                hidden
                accept=".sp"
                onChange={handleImportSampleProfile}
              />
            </Button>
          </Box>

          <Divider sx={{ mb: 3 }} />

          {/* Motion Profile Selection */}
          <Box sx={{ mb: 3 }}>
            <Typography variant="h6" gutterBottom>
              Motion Profile
            </Typography>
            <FormControl fullWidth sx={{ mb: 1 }}>
              <InputLabel>Select Motion Profile</InputLabel>
              <Select
                value={selectedMotionProfileId}
                label="Select Motion Profile"
                onChange={(e) =>
                  setSelectedMotionProfileId(e.target.value as string)
                }
              >
                {motionProfiles.map((mp) => (
                  <MenuItem key={mp.id} value={mp.id}>
                    {mp.name}
                    {mp.description ? ` — ${mp.description}` : ''}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Button
              variant="outlined"
              component="label"
              startIcon={<AddIcon />}
              size="small"
            >
              Import from File
              <input
                type="file"
                hidden
                accept=".mp"
                onChange={handleImportMotionProfile}
              />
            </Button>
          </Box>

          {/* G-code Preview */}
          {selectedSampleProfile && selectedMotionProfile && (
            <>
              <Divider sx={{ mb: 3 }} />
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
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseDialog} color="primary">
            Cancel
          </Button>
          <Button
            onClick={handleRunTest}
            color="primary"
            variant="contained"
            disabled={
              isLoading ||
              !selectedSampleProfile ||
              !selectedMotionProfile ||
              Boolean(deviceState.machineState?.testRunning)
            }
            startIcon={
              isLoading || deviceState.machineState?.testRunning ? (
                <CircularProgress size={24} />
              ) : (
                <PlayArrowIcon />
              )
            }
          >
            {isLoading || deviceState.machineState?.testRunning
              ? 'Running...'
              : 'Run Test'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
