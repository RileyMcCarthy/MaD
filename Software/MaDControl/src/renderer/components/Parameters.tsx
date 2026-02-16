import { Typography, Grid, Box, Tooltip } from '@mui/material';
import { useDevice } from '@renderer/hooks';
import { SampleData } from '@shared/SharedInterface';
import { CardPanel } from './StyledComponents';

// Descriptions for sample data fields to show in tooltips
const SampleDataDescriptions: Partial<Record<keyof SampleData, string>> = {
  'Machine Force (N)': 'Absolute force reading',
  'Machine Position (mm)': 'Position of upper jaw relative to lower jaw',
  'Sample Force (N)': 'Force applied to the sample',
  'Sample Position (mm)': 'Starting position of the motion profile',
};

function Parameters() {
  const [deviceState] = useDevice();
  const latestSample = deviceState.latestSampleData;

  return (
    <Box sx={{ flexGrow: 1 }}>
      <CardPanel>
        <Grid container direction="column">
          {latestSample ? (
            Object.entries(latestSample).map(([key, value]) => {
              const description =
                SampleDataDescriptions[key as keyof SampleData];
              const hasDescription = description !== undefined;
              return (
                <Grid
                  item
                  container
                  direction="row"
                  justifyContent="space-between"
                  key={key}
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
                        {key}:
                      </Typography>
                    </Tooltip>
                  ) : (
                    <Typography noWrap>{key}:</Typography>
                  )}
                  <Typography noWrap>{value}</Typography>
                </Grid>
              );
            })
          ) : (
            <Typography>Loading...</Typography>
          )}
        </Grid>
      </CardPanel>
    </Box>
  );
}

export default Parameters;
