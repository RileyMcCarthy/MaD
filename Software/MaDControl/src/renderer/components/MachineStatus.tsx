import { FaultedReason, RestrictedReason } from '@shared/SharedInterface';
import { Typography, Box, Tooltip } from '@mui/material';
import Paper from '@mui/material/Paper';
import { styled } from '@mui/material/styles';
import Grid from '@mui/material/Grid';
import Skeleton from '@mui/material/Skeleton';
import { useDevice } from '@renderer/hooks';

const Item = styled(Paper)(({ theme }) => ({
  backgroundColor: theme.palette.mode === 'dark' ? '#1A2027' : '#fff',
  ...theme.typography.body2,
  padding: theme.spacing(1),
  textAlign: 'center',
  color: theme.palette.text.secondary,
}));

function getStyledFaultedReason(reason: FaultedReason) {
  const explanations = {
    [FaultedReason.NONE]: 'No faults detected.',
    [FaultedReason.COG]: 'Cogging detected in the machine.',
    [FaultedReason.WATCHDOG]: 'Watchdog timer triggered.',
    [FaultedReason.ESD_POWER]: 'ESD power fault detected.',
    [FaultedReason.ESD_SWITCH]: 'ESD switch fault detected.',
    [FaultedReason.ESD_UPPER]: 'Upper ESD fault detected.',
    [FaultedReason.ESD_LOWER]: 'Lower ESD fault detected.',
    [FaultedReason.SERVO_COMMUNICATION]: 'Servo communication fault detected.',
    [FaultedReason.FORCE_GAGUE_COMMUNICATION]: 'Force gauge communication fault detected.',
    [FaultedReason.USER_REQUEST]: 'User requested to disable the machine.',
  };

  const reasonText = FaultedReason[reason];
  const explanation = explanations[reason] || 'Unknown fault reason.';

  return (
    <Tooltip title={explanation}>
      <Typography
        style={{ color: reason === FaultedReason.NONE ? 'green' : 'red' }}
      >
        {reasonText}
      </Typography>
    </Tooltip>
  );
}

function getStyledRestrictedReason(reason: RestrictedReason) {
  const explanations = {
    [RestrictedReason.NONE]: 'No restrictions detected.',
    [RestrictedReason.SAMPLE_LENGTH]: 'Sample length restriction detected.',
    [RestrictedReason.SAMPLE_TENSION]: 'Sample tension restriction detected.',
    [RestrictedReason.MACHINE_TENSION]: 'Machine tension restriction detected.',
    [RestrictedReason.UPPER_ENDSTOP]: 'Upper endstop restriction detected.',
    [RestrictedReason.LOWER_ENDSTOP]: 'Lower endstop restriction detected.',
    [RestrictedReason.DOOR]: 'Door restriction detected.',
  };

  const reasonText = RestrictedReason[reason];
  const explanation = explanations[reason] || 'Unknown restriction reason.';

  return (
    <Tooltip title={explanation}>
      <Typography style={{ color: reason === RestrictedReason.NONE ? 'green' : 'yellow' }}>
        {reasonText}
      </Typography>
    </Tooltip>
  );
}

function getStyledMotionEnabled(motionEnabled: boolean) {
  const explanation = motionEnabled ? 'Motion is enabled.' : 'Motion is disabled.';

  return (
    <Tooltip title={explanation}>
      <Typography style={{ color: motionEnabled ? 'green' : 'red' }}>
        {motionEnabled ? 'Enabled' : 'Disabled'}
      </Typography>
    </Tooltip>
  );
}

function getStyledTestRunning(testRunning: boolean) {
  const explanation = testRunning ? 'The test is currently running.' : 'The test is currently idle.';

  return (
    <Tooltip title={explanation}>
      <Typography style={{ color: testRunning ? 'yellow' : 'grey' }}>
        {testRunning ? 'Running' : 'Idle'}
      </Typography>
    </Tooltip>
  );
}

function StatusComponent() {
  const [state] = useDevice();
  const machineState = state.machineState;
  const height = 200;

  function styledStateParameters() {
    if (machineState) {
      return (
        <Item>
          <Box>
            <Typography variant="h6" noWrap>
              Machine State
            </Typography>
            <Grid container direction="column">
              <Grid
                item
                container
                direction="row"
                justifyContent="space-between"
              >
                <Typography noWrap>Disabled Reason</Typography>
                <Typography noWrap>
                  {getStyledFaultedReason(machineState.faultedReason)}
                </Typography>
              </Grid>
              <Grid
                item
                container
                direction="row"
                justifyContent="space-between"
              >
                <Typography noWrap>Restricted Reason</Typography>
                <Typography noWrap>
                  {getStyledRestrictedReason(machineState.restrictedReason)}
                </Typography>
              </Grid>
              <Grid
                item
                container
                direction="row"
                justifyContent="space-between"
              >
                <Typography noWrap>Motion State</Typography>
                <Typography noWrap>
                  {getStyledMotionEnabled(machineState.motionEnabled)}
                </Typography>
              </Grid>
              <Grid
                item
                container
                direction="row"
                justifyContent="space-between"
              >
                <Typography noWrap>Test State</Typography>
                <Typography noWrap>
                  {getStyledTestRunning(machineState.testRunning)}
                </Typography>
              </Grid>
            </Grid>
          </Box>
        </Item>
      );
    }
    return <Skeleton animation="wave" variant="rounded" sx={{ height }} />;
  }

  return (
    <Box sx={{ flexGrow: 1, p: 2 }}>
      <Grid container spacing={2}>
        <Grid item xs={12}>
          {styledStateParameters()}
        </Grid>
      </Grid>
    </Box>
  );
}

export default StatusComponent;
