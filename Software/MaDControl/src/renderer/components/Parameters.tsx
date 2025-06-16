import React, { useEffect, useState } from 'react';
import { SampleData } from '@shared/SharedInterface';
import { Box, Typography, Grid, Paper } from '@mui/material';
import { styled } from '@mui/material/styles';

const Item = styled(Paper)(({ theme }) => ({
  backgroundColor: theme.palette.mode === 'dark' ? '#1A2027' : '#fff',
  ...theme.typography.body2,
  padding: theme.spacing(1),
  textAlign: 'center',
  color: theme.palette.text.secondary,
}));

function Parameters() {
  const [latestSample, setLatestSample] = useState<SampleData | null>(null);

  useEffect(() => {
    // Function to fetch the latest sample data
    const fetchLatestSample = async () => {
      try {
        const sample: SampleData | null =
          await window.electron.ipcRenderer.invoke('sample-data-latest');
        if (sample) {
          console.log("Latest Sample Data:", sample);
          setLatestSample(sample);
        }
      } catch (error) {
        console.error('Failed to fetch latest sample data:', error);
      }
    };

    // Call the function to fetch the latest sample data on page load
    fetchLatestSample();

    // Function to handle updated sample data
    const handleSampleDataUpdated = (newSample: SampleData) => {
      setLatestSample(newSample);
    };

    // Listen for sample-data-updated event
    const unsubscribe = window.electron.ipcRenderer.on(
      'sample-data-updated',
      handleSampleDataUpdated,
    );

    // Cleanup the event listener on component unmount
    return () => {
      unsubscribe();
    };
  }, []);

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
