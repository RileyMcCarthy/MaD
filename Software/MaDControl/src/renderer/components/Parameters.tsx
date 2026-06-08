import { Typography, Grid, Box, Tooltip, Divider } from '@mui/material';
import { useDevice } from '@renderer/hooks';
import { SampleData } from '@shared/SharedInterface';
import { CardPanel } from './StyledComponents';

// Descriptions for sample data fields to show in tooltips
const SampleDataDescriptions: Partial<Record<keyof SampleData, string>> = {
  'Machine Force (N)': 'Absolute force reading',
  'Machine Position (mm)':
    'Jaw separation from encoder feedback (same basis as sample position + gauge length)',
  'Sample Force (N)': 'Force applied to the sample',
  'Sample Position (mm)':
    'Extension from gauge-zero: machine position minus length at “zero length”',
};

function formatSampleValue(key: string, value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return String(value);
  }

  if (key.includes('(N)') || key.includes('(mm)')) {
    const rounded = Number(value.toFixed(3));
    return rounded.toFixed(3);
  }

  return String(value);
}

function Parameters() {
  const [deviceState] = useDevice();
  const latestSample = deviceState.latestSampleData;

  const renderRow = (
    key: keyof SampleData,
    label: string,
    value: unknown,
  ) => {
    const description = SampleDataDescriptions[key as keyof SampleData];
    const hasDescription = description !== undefined;
    return (
      <Grid
        item
        container
        direction="row"
        justifyContent="space-between"
        key={String(key)}
      >
        {hasDescription ? (
          <Tooltip title={description} arrow placement="left">
            <Typography
              noWrap
              sx={{
                cursor: 'help',
                textDecoration: 'underline',
                textDecorationStyle: 'dotted',
                '&:hover': {
                  textDecoration: 'underline',
                  textDecorationStyle: 'solid',
                },
              }}
            >
              {label}:
            </Typography>
          </Tooltip>
        ) : (
          <Typography noWrap>{label}:</Typography>
        )}
        <Typography noWrap>{formatSampleValue(String(key), value)}</Typography>
      </Grid>
    );
  };

  return (
    <Box sx={{ flexGrow: 1 }}>
      <CardPanel>
        <Grid container direction="column" spacing={1}>
          {latestSample ? (
            <>
              <Grid item>
                <Typography variant="subtitle2" sx={{ textAlign: 'left' }}>
                  Machine
                </Typography>
              </Grid>
              <Grid item container direction="column">
                {renderRow(
                  'Machine Force (N)',
                  'Machine Force (N)',
                  latestSample['Machine Force (N)'],
                )}
                {renderRow(
                  'Machine Position (mm)',
                  'Machine Position (mm)',
                  latestSample['Machine Position (mm)'],
                )}
                {renderRow(
                  'Machine Setpoint (mm)',
                  'Machine Setpoint (mm)',
                  latestSample['Machine Setpoint (mm)'],
                )}
              </Grid>

              <Grid item>
                <Divider />
              </Grid>

              <Grid item>
                <Typography variant="subtitle2" sx={{ textAlign: 'left' }}>
                  Sample
                </Typography>
              </Grid>
              <Grid item container direction="column">
                {renderRow(
                  'Sample Force (N)',
                  'Sample Force (N)',
                  latestSample['Sample Force (N)'],
                )}
                {renderRow(
                  'Sample Position (mm)',
                  'Sample Position (mm)',
                  latestSample['Sample Position (mm)'],
                )}
              </Grid>
            </>
          ) : (
            <Typography>Loading...</Typography>
          )}
        </Grid>
      </CardPanel>
    </Box>
  );
}

export default Parameters;
