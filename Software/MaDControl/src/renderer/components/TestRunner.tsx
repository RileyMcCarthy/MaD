import React, { useEffect, useRef, useState } from 'react';
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
import { useDevice, useProfiles } from '@renderer/hooks';
import GCodeGenerator from './GCodeGenerator';
import { CardPanel } from './StyledComponents';
import { componentLogger } from '../utils/logger';

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
  const activeEntryId = useRef<string | null>(null);

  // Reset isLoading when firmware confirms testRunning then completes
  const prevTestRunning = useRef(false);
  useEffect(() => {
    const running = Boolean(deviceState.machineState?.testRunning);
    if (prevTestRunning.current && !running) {
      // Test just finished — mark as completed in the database
      setIsLoading(false);
      if (activeEntryId.current) {
        window.electron.ipcRenderer
          .invoke('data-update-test-run', activeEntryId.current, {
            status: 'completed',
            completedAt: new Date().toISOString(),
          })
          .catch((err: unknown) =>
            componentLogger.error('Failed to update test run status:', err),
          );
        activeEntryId.current = null;
      }
    }
    prevTestRunning.current = running;
  }, [deviceState.machineState?.testRunning]);

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

      // Step 1: Reserve the test name and create the DB entry before touching firmware.
      // This way the name is known up front and the record exists even if the run fails.
      const snap = deviceState.latestSampleData;
      let gaugeLengthMm: number | undefined;
      let initialMachinePositionMm: number | undefined;
      if (snap) {
        const machineMm = snap['Machine Position (mm)'];
        const sampleMm = snap['Sample Position (mm)'];
        if (Number.isFinite(machineMm)) {
          initialMachinePositionMm = machineMm;
        }
        if (Number.isFinite(machineMm) && Number.isFinite(sampleMm)) {
          const g = machineMm - sampleMm;
          if (Number.isFinite(g)) gaugeLengthMm = g;
        }
      }

      const entry = await window.electron.ipcRenderer.invoke(
        'data-create-test-run',
        {
          sampleProfileId: selectedSampleProfileId,
          motionProfileId: selectedMotionProfileId,
          sampleProfile: selectedSampleProfile,
          motionProfile: selectedMotionProfile,
          gcode: generatedGcode,
          ...(gaugeLengthMm !== undefined ? { gaugeLengthMm } : {}),
          ...(initialMachinePositionMm !== undefined
            ? { initialMachinePositionMm }
            : {}),
        },
      );
      /* `testName` is a new reserved id every run (see dataManager `reserveTestName`).
       * Protocol only carries six ASCII chars per field; main truncates if longer.
       * We send the same token as gcodeId and testDataId so the uploaded motion file
       * and the logged sample stream share one SD basename per run. */
      const { testName: firmwareRunId } = entry;

      const result = await window.electron.ipcRenderer.invoke('run-test', {
        gcode: generatedGcode,
        gcodeId: firmwareRunId,
        testDataId: firmwareRunId,
        ...(gaugeLengthMm !== undefined ? { gaugeLengthMm } : {}),
      });

      if (!result.success) {
        // Mark the pre-created entry as errored so it's visible in TestRuns
        await window.electron.ipcRenderer.invoke(
          'data-update-test-run',
          entry.id,
          {
            status: 'error',
          },
        );
        throw new Error(result.error || 'Failed to start test');
      }

      activeEntryId.current = entry.id;
      onRunTest(firmwareRunId);
      handleCloseDialog();
      // Keep isLoading=true until firmware reports testRunning=true via state poll.
      // This avoids a brief gap where neither flag is set and the button flickers to "Run Test".
    } catch (error) {
      componentLogger.error('Failed to run test:', error);
      alert('Failed to run test');
      setIsLoading(false);
    }
  };

  return (
    <Box sx={{ flexGrow: 1 }}>
      <CardPanel
        sx={{ p: 2, height: '100%', display: 'flex', flexDirection: 'column' }}
      >
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
                isLoading || Boolean(deviceState.machineState?.testRunning)
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
