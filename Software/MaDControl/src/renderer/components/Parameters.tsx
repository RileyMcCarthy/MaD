import { Typography, Grid } from '@mui/material';
import { Box, Paper } from '@mui/material';
import { styled } from '@mui/material/styles';
import { useDevice } from '@renderer/hooks';

const Item = styled(Paper)(({ theme }) => ({
  backgroundColor: theme.palette.mode === 'dark' ? '#1A2027' : '#fff',
  ...theme.typography.body2,
  padding: theme.spacing(1),
  textAlign: 'center',
  color: theme.palette.text.secondary,
}));

function Parameters() {
  const [deviceState] = useDevice();
  const latestSample = deviceState.latestSampleData;

  return (
    <Box sx={{ px: 2 }}>
      <Item>
        <Grid container direction="column">
          {latestSample ? (
            Object.entries(latestSample).map(([key, value]) => (
              <Grid
                item
                container
                direction="row"
                justifyContent="space-between"
                key={key}
              >
                <Typography noWrap>{key}:</Typography>
                <Typography noWrap>{value}</Typography>
              </Grid>
            ))
          ) : (
            <Typography>Loading...</Typography>
          )}
        </Grid>
      </Item>
    </Box>
  );
}

export default Parameters;
