import { IconButton, Tooltip, Box, Grid, Paper } from '@mui/material';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import HomeIcon from '@mui/icons-material/Home';
import LockIcon from '@mui/icons-material/Lock';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import { styled } from '@mui/material/styles';
import SpeedIcon from '@mui/icons-material/Speed';
import { componentLogger } from '../utils/logger';
import { useDevice } from '@renderer/hooks';

const Item = styled(Paper)(({ theme }) => ({
  backgroundColor: theme.palette.mode === 'dark' ? '#1A2027' : '#fff',
  ...theme.typography.body2,
  padding: theme.spacing(1),
  textAlign: 'center',
  color: theme.palette.text.secondary,
}));

function Control() {
  const [state, actions] = useDevice();
  const isLocked = state.machineState?.motionEnabled === false;

  const handleEnableMotion = async () => {
    try {
      await actions.setMotionEnabled(true);
    } catch (error) {
      componentLogger.error('Failed to enable motion:', error);
    }
  };

  const handleDisableMotion = async () => {
    try {
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

  const handleMoveUp = async () => {
    try {
      await actions.manualMove(10, 100); // Move up 10mm at 100mm/min
    } catch (error) {
      componentLogger.error('Failed to move up:', error);
    }
  };

  const handleMoveDown = async () => {
    try {
      await actions.manualMove(-10, 100); // Move down 10mm at 100mm/min
    } catch (error) {
      componentLogger.error('Failed to move down:', error);
    }
  };

  return (
    <Box sx={{ p: 2 }}>
      <Item>
        <Grid container spacing={1}>
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
                <Tooltip title={isLocked ? 'Enable Motion' : 'Disable Motion'}>
                  <IconButton
                    onClick={isLocked ? handleEnableMotion : handleDisableMotion}
                    sx={{ padding: '16px', margin: '3px' }}
                  >
                    {isLocked ? (
                      <LockIcon fontSize="large" sx={{ color: 'red' }} />
                    ) : (
                      <LockOpenIcon fontSize="large" sx={{ color: 'green' }} />
                    )}
                  </IconButton>
                </Tooltip>
              </Grid>
            </Grid>
          </Grid>
          <Grid item xs={4}>
            <Grid container direction="column" alignItems="center" spacing={1}>
              <Grid item>
                <Tooltip title="Zero Length">
                  <IconButton
                    onClick={handleZeroForce}
                    sx={{ padding: '16px', margin: '3px' }}
                  >
                    <SpeedIcon fontSize="large" />
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
