import React, { useState } from 'react';
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
  const [selectedSampleProfile, setSelectedSampleProfile] = useState<SampleProfile | null>(null);
  const [selectedMotionProfile, setSelectedMotionProfile] = useState<MotionProfile | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [runIndex, setRunIndex] = useState<number | null>(null);
  const [openDialog, setOpenDialog] = useState(false);
  const [generatedGcode, setGeneratedGcode] = useState<string[]>([]);

  const handleSampleProfileSelect = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (file) {
      try {
        const reader = new FileReader();
        reader.onload = async (e) => {
          const content = e.target?.result as string;
          const profile = JSON.parse(content) as SampleProfile;
          setSelectedSampleProfile(profile);

          // Get the run index for this sample
          const newRunIndex = await window.electron.ipcRenderer.invoke(
            'sample-profile-run',
            profile.serialNumber,
          );
          setRunIndex(newRunIndex);
          // Format the test name with zero-padded numbers
          const paddedSerialNumber = profile.serialNumber
            .toString()
            .padStart(4, '0');
          const paddedRunIndex = newRunIndex.toString().padStart(3, '0');
          const testName = `${paddedSerialNumber}-${paddedRunIndex}`;
          onRunTest(testName);
        };
        reader.readAsText(file);
      } catch (error) {
        console.error('Error reading sample profile:', error);
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
        console.error('Error reading motion profile:', error);
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
    if (!selectedSampleProfile || !selectedMotionProfile || runIndex === null) return;

    try {
      setIsLoading(true);

      // Format the test name with zero-padded numbers
      const paddedSerialNumber = selectedSampleProfile.serialNumber
        .toString()
        .padStart(4, '0');
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
      console.error('Failed to run test:', error);
      alert('Failed to run test');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Box sx={{ p: 2 }}>
      <Item>
        <Typography variant="h6" gutterBottom>
          Test Runner
        </Typography>
        <Grid container spacing={2}>
          <Grid item xs={12}>
            <Button
              variant="contained"
              component="label"
              startIcon={<FolderOpenIcon />}
              fullWidth
            >
              Select Sample Profile
              <input
                type="file"
                hidden
                accept=".sp"
                onChange={handleSampleProfileSelect}
              />
            </Button>
            {selectedSampleProfile && (
              <Typography variant="body2" sx={{ mt: 1 }}>
                Selected: {selectedSampleProfile.serialNumber}
              </Typography>
            )}
          </Grid>
          <Grid item xs={12}>
            <Button
              variant="contained"
              component="label"
              startIcon={<FolderOpenIcon />}
              fullWidth
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
              <Typography variant="body2" sx={{ mt: 1 }}>
                Selected: {selectedMotionProfile.name}
              </Typography>
            )}
          </Grid>
          <Grid item xs={12}>
            <Button
              variant="contained"
              color="primary"
              onClick={handleOpenDialog}
              fullWidth
              disabled={!selectedSampleProfile || !selectedMotionProfile}
              startIcon={<PlayArrowIcon />}
            >
              Run Test
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
        <DialogTitle>Generated G-code and Graph</DialogTitle>
        <DialogContent>
          {selectedSampleProfile && selectedMotionProfile && (
            <GCodeGenerator
              profile={{
                ...selectedMotionProfile,
                sampleProfile: selectedSampleProfile,
              } as unknown as TestProfile}
              onGcodeGenerated={setGeneratedGcode}
            />
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
            disabled={isLoading}
            startIcon={isLoading ? <CircularProgress size={24} /> : <PlayArrowIcon />}
          >
            {isLoading ? 'Running...' : 'Run Test'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
