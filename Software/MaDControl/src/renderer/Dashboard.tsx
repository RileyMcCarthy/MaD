import MachineStatus from './components/MachineStatus';
import './App.css';
import 'react-toastify/dist/ReactToastify.css';
import { Grid, Box } from '@mui/material';
import Control from './components/Control';
import Parameters from './components/Parameters';
import BasicLineChart from './components/Graph';
import TestRunner from './components/TestRunner';

export default function Dashboard() {
  const handleRunTest = (testName: string) => {
    console.log(`Running test: ${testName}`);
    // Implementation needed: Handle test execution
  };

  return (
    <Box sx={{
      height: 'calc(100vh - 64px)', // Subtract header height
      overflow: 'auto',
    }}>
      <Grid container spacing={0.5}>
        <Grid item xs={12} md={4}>
          <Grid container spacing={0.5}>
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
          <BasicLineChart />
        </Grid>
      </Grid>
    </Box>
  );
}
