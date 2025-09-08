import { useEffect } from 'react';
import MachineStatus from '../components/MachineStatus';
import '../App.css';
import 'react-toastify/dist/ReactToastify.css';
import { Grid, Box } from '@mui/material';
import Control from '../components/Control';
import Parameters from '../components/Parameters';
import BasicLineChart from '../components/Graph';
import StressStrainChart from '../components/StressStrainChart';
import TestRunner from '../components/TestRunner';
import { componentLogger } from '../utils/logger';
import { useDevice } from '../hooks/useDevice';

export default function Dashboard() {
  const [deviceState, actions] = useDevice();

  // Load configurations when dashboard mounts or when device connects
  useEffect(() => {
    const loadConfigurations = async () => {
      if (deviceState.isConnected && deviceState.isResponding) {
        try {
          // Load machine configuration if not present
          if (!deviceState.machineConfiguration) {
            await actions.getMachineConfiguration();
            componentLogger.info('Machine configuration loaded on dashboard mount');
          }

          // Load sample profile
          await actions.getSampleProfile();
          componentLogger.info('Sample profile loaded on dashboard mount');
        } catch (error) {
          componentLogger.warn('Failed to load configurations:', error);
        }
      }
    };

    loadConfigurations();
  }, [deviceState.isConnected, deviceState.isResponding, deviceState.machineConfiguration]);

  const handleRunTest = (testName: string) => {
    componentLogger.info(`Running test: ${testName}`);
    // Implementation needed: Handle test execution
  };

  return (
    <Box
      sx={{
        height: 'calc(100vh - 64px)', // Subtract header height
        overflow: 'auto',
        p: 2, // Add padding around all edges
        pb: 4, // Extra bottom padding for proper scrolling
      }}
    >
      <Grid container spacing={2}>
        <Grid item xs={12} md={4}>
          <Grid container spacing={2}>
            <Grid item xs={12}>
              <MachineStatus />
            </Grid>
            <Grid item xs={12}>
              <Parameters />
            </Grid>
            <Grid item xs={12}>
              <Control />
            </Grid>
            <Grid item xs={12}>
              <TestRunner onRunTest={handleRunTest} />
            </Grid>
          </Grid>
        </Grid>
        <Grid item xs={12} md={8}>
          <Grid container spacing={2} direction="column">
            <Grid item>
              <BasicLineChart />
            </Grid>
            <Grid item>
              <StressStrainChart />
            </Grid>
          </Grid>
        </Grid>
      </Grid>
    </Box>
  );
}
