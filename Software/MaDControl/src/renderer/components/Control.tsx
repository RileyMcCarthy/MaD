import { IconButton, Tooltip, Box, Grid, Paper, TextField } from '@mui/material';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import HomeIcon from '@mui/icons-material/Home';
import LockIcon from '@mui/icons-material/Lock';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import { styled } from '@mui/material/styles';
import SpeedIcon from '@mui/icons-material/Speed';
import StraightenIcon from '@mui/icons-material/Straighten';
import { useDevice } from '@renderer/hooks';
import { componentLogger } from '../utils/logger';
import { useState } from 'react';

const Item = styled(Paper)(({ theme }) => ({
  backgroundColor: theme.palette.mode === 'dark' ? '#1A2027' : '#fff',
  ...theme.typography.body2,
  padding: theme.spacing(1),
  textAlign: 'center',
  color: theme.palette.text.secondary,
}));

function Control() {
  const [state, actions] = useDevice();
  const [moveDistance, setMoveDistance] = useState(10); // mm
  const [moveSpeed, setMoveSpeed] = useState(100); // mm/s
  const isMotionEnabled = Boolean(state.machineState?.motionEnabled);

  // Debug logging
  console.log('Control component render:', {
    motionEnabled: state.machineState?.motionEnabled,
    isMotionEnabled,
    machineState: state.machineState
  });

  const handleEnableMotion = async () => {
    try {
      console.log('handleEnableMotion called - setting motion to TRUE');
      await actions.setMotionEnabled(true);
    } catch (error) {
      componentLogger.error('Failed to enable motion:', error);
    }
  };

  const handleDisableMotion = async () => {
    try {
      console.log('handleDisableMotion called - setting motion to FALSE');
      await actions.setMotionEnabled(false);
    } catch (error) {
      componentLogger.error('Failed to disable motion:', error);
    }
  };

  const handleHomeAxis = async () => {
    try {
      await actions.homeAxis();
    } catch (error) {
      componentLogger.error('Failed to home axis:', error);
    }
  };

  const handleZeroForce = async () => {
    try {
      await actions.zeroForce();
    } catch (error) {
      componentLogger.error('Failed to zero force:', error);
    }
  };

  const handleZeroLength = async () => {
    try {
      await actions.zeroLength();
    } catch (error) {
      componentLogger.error('Failed to zero length:', error);
    }
  };

  const handleMoveUp = async () => {
    try {
      await actions.manualMove(moveDistance, moveSpeed);
    } catch (error) {
      componentLogger.error('Failed to move up:', error);
    }
  };

  const handleMoveDown = async () => {
    try {
      await actions.manualMove(-moveDistance, moveSpeed);
    } catch (error) {
      componentLogger.error('Failed to move down:', error);
    }
  };

  return (
    <Box sx={{ flexGrow: 1 }}>
      <Item>
        <Grid container spacing={1}>
          <Grid item xs={12}>
            <Grid container spacing={1}>
              <Grid item xs={6}>
                <TextField
                  fullWidth
                  label="Move Distance (mm)"
                  type="number"
                  size="small"
                  value={moveDistance}
                  onChange={(e) => setMoveDistance(Number(e.target.value) || 0)}
                  inputProps={{ min: 0, step: 1 }}
                />
              </Grid>
              <Grid item xs={6}>
                <TextField
                  fullWidth
                  label="Move Speed (mm/s)"
                  type="number"
                  size="small"
                  value={moveSpeed}
                  onChange={(e) => setMoveSpeed(Number(e.target.value) || 0)}
                  inputProps={{ min: 0, step: 10 }}
                />
              </Grid>
            </Grid>
          </Grid>
          <Grid item xs={4}>
            <Grid container direction="column" alignItems="center" spacing={1}>
              <Grid item>
                <Tooltip title="Move Up">
                  <IconButton
                    onClick={handleMoveUp}
                    sx={{ padding: '16px', margin: '3px' }}
                  >
                    <ArrowUpwardIcon fontSize="large" />
                  </IconButton>
                </Tooltip>
              </Grid>
              <Grid item>
                <Tooltip title="Move Down">
                  <IconButton
                    onClick={handleMoveDown}
                    sx={{ padding: '16px', margin: '3px' }}
                  >
                    <ArrowDownwardIcon fontSize="large" />
                  </IconButton>
                </Tooltip>
              </Grid>
            </Grid>
          </Grid>
          <Grid item xs={4}>
            <Grid container direction="column" alignItems="center" spacing={1}>
              <Grid item>
                <Tooltip title="Home">
                  <IconButton
                    onClick={handleHomeAxis}
                    sx={{ padding: '16px', margin: '3px' }}
                  >
                    <HomeIcon fontSize="large" />
                  </IconButton>
                </Tooltip>
              </Grid>
              <Grid item>
                <Tooltip title={isMotionEnabled ? 'Disable Motion' : 'Enable Motion'}>
                  <IconButton
                    onClick={() => {
                      console.log('Button clicked! isMotionEnabled:', isMotionEnabled);
                      if (isMotionEnabled) {
                        handleDisableMotion();
                      } else {
                        handleEnableMotion();
                      }
                    }}
                    sx={{ padding: '16px', margin: '3px' }}
                  >
                    {isMotionEnabled ? (
                      <LockOpenIcon fontSize="large" sx={{ color: 'green' }} />
                    ) : (
                      <LockIcon fontSize="large" sx={{ color: 'red' }} />
                    )}
                  </IconButton>
                </Tooltip>
              </Grid>
            </Grid>
          </Grid>
          <Grid item xs={4}>
            <Grid container direction="column" alignItems="center" spacing={1}>
              <Grid item>
                <Tooltip title="Zero Force">
                  <IconButton
                    onClick={handleZeroForce}
                    sx={{ padding: '16px', margin: '3px' }}
                  >
                    <SpeedIcon fontSize="large" />
                  </IconButton>
                </Tooltip>
              </Grid>
              <Grid item>
                <Tooltip title="Zero Length">
                  <IconButton
                    onClick={handleZeroLength}
                    sx={{ padding: '16px', margin: '3px' }}
                  >
                    <StraightenIcon fontSize="large" />
                  </IconButton>
                </Tooltip>
              </Grid>
            </Grid>
          </Grid>
        </Grid>
      </Item>
    </Box>
  );
}

export default Control;
