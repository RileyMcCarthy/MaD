import React, { useEffect, useState } from 'react';
import { IconButton, Tooltip, Box, Grid, Paper } from '@mui/material';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import HomeIcon from '@mui/icons-material/Home';
import LockIcon from '@mui/icons-material/Lock';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import RestoreIcon from '@mui/icons-material/Restore';
import { styled } from '@mui/material/styles';
import { Typography } from '@mui/material';
import { FaultedReason, MachineState } from '@shared/SharedInterface';
import SpeedIcon from '@mui/icons-material/Speed';

const Item = styled(Paper)(({ theme }) => ({
  backgroundColor: theme.palette.mode === 'dark' ? '#1A2027' : '#fff',
  ...theme.typography.body2,
  padding: theme.spacing(1),
  textAlign: 'center',
  color: theme.palette.text.secondary,
}));

function Control() {
  const [isLocked, setIsLocked] = useState(true);

  useEffect(() => {
    // Function to fetch the initial machine state
    const fetchInitialMachineState = async () => {
      try {
        const status: MachineState | null = await window.electron.ipcRenderer.invoke('device-state');
        if (status) {
          console.log("checking control", status);
          setIsLocked(status.motionEnabled === 0);
        }
      } catch (error) {
        console.error('Failed to fetch initial machine state:', error);
      }
    };

    // Fetch the initial machine state on load
    fetchInitialMachineState();

    // Function to handle updated machine state
    const handleMachineStateUpdated = (status: MachineState) => {
      console.log('Machine state updated:', status, status.motionEnabled, status.motionEnabled === 0);
      setIsLocked(status.motionEnabled === 0);
    };

    // Listen for machine-state-updated event
    const unsubscribe = window.electron.ipcRenderer.on('machine-state-updated', handleMachineStateUpdated);

    // Cleanup the event listener on component unmount
    return () => {
      unsubscribe();
    };
  }, []);

  const handleUpClick = async () => {
    try {
      await window.electron.ipcRenderer.invoke('manual-move', 200, 100);
    } catch (error) {
      console.error('Failed to fetch initial machine state:', error);
    }
  };

  const handleHomeClick = async () => {
    // Handle home click
    try {
      await window.electron.ipcRenderer.invoke('home');
    } catch (error) {
      console.error('Failed to fetch initial machine state:', error);
    }
  };

  const handleZeroLength = async () => {
    // Handle zero length click
    try {
      await window.electron.ipcRenderer.invoke('set_length_zero');
    } catch (error) {
      console.error('Failed to fetch initial machine state:', error);
    }
  };

  const handleZeroForce = async () => {
    // Handle zero force click
    try {
      await window.electron.ipcRenderer.invoke('set_force_zero');
    } catch (error) {
      console.error('Failed to fetch initial machine state:', error);
    }
  };

  const handleDownClick = async () => {
    try {
      await window.electron.ipcRenderer.invoke('manual-move', -200, 100);
    } catch (error) {
      console.error('Failed to fetch initial machine state:', error);
    }
  };

  const handleLockToggleClick = async () => {
    try {
      const prevIsLocked = isLocked;
      const success: boolean = await window.electron.ipcRenderer.invoke('set-motion-enabled', isLocked);
      if (success) {
        //alert('Motion ' + (prevIsLocked ? 'enabled' : 'disabled') + ' successfully');
      } else {
        alert('Failed to ' + (prevIsLocked ? 'enable' : 'disable') + ' motion');
      }
    } catch (error) {
      console.error('Failed to fetch initial machine state:', error);
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
                    onClick={handleUpClick}
                    sx={{ padding: '16px', margin: '3px' }}
                  >
                    <ArrowUpwardIcon fontSize="large" />
                  </IconButton>
                </Tooltip>
              </Grid>
              <Grid item>
                <Tooltip title="Move Down">
                  <IconButton
                    onClick={handleDownClick}
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
                    onClick={handleHomeClick}
                    sx={{ padding: '16px', margin: '3px' }}
                  >
                    <HomeIcon fontSize="large" />
                  </IconButton>
                </Tooltip>
              </Grid>
              <Grid item>
                <Tooltip title={isLocked ? 'Enable Motion' : 'Disable Motion'}>
                  <IconButton
                    onClick={handleLockToggleClick}
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
                    onClick={handleZeroLength}
                    sx={{ padding: '16px', margin: '3px' }}
                  >
                    <RestoreIcon fontSize="large" />
                  </IconButton>
                </Tooltip>
              </Grid>
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
            </Grid>
          </Grid>
        </Grid>
      </Item>
    </Box>
  );
}

export default Control;
