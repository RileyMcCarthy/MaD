import * as React from 'react';
import { LineChart } from '@mui/x-charts/LineChart';
import { useEffect, useState } from 'react';
import { MachineConfiguration, SampleData } from '@shared/SharedInterface';
import { Typography, Box } from '@mui/material';
import Paper from '@mui/material/Paper';
import Grid from '@mui/material/Grid';
import Skeleton from '@mui/material/Skeleton';
import { axisClasses } from '@mui/x-charts/ChartsAxis';

export default function BasicLineChart() {
  const [samples, setSamples] = useState<SampleData[]>([]);
  const [config, setConfig] = useState<MachineConfiguration[]>([]);

  useEffect(() => {
    // Function to initialize data on page load
    const initializeData = async () => {
      try {
        const data: SampleData[] | null = await window.electron.ipcRenderer.invoke('device-data-all');
        const config = await window.electron.ipcRenderer.invoke('get-machine-configuration');
        if (config) {
          setConfig(config);
        }
        if (data && data.length > 0) {
          setSamples(data.slice(-100)); // Save up to 100 samples
        }
      } catch (error) {
        console.error('Failed to initialize data:', error);
      }
    };

    // Call the function to initialize data on page load
    initializeData();

    // Function to handle new sample data
    const handleSampleDataUpdated = (newSample: SampleData) => {
      setSamples((prevSamples) => {
        const updatedSamples = [...prevSamples, newSample];
        if (updatedSamples.length > 100) {
          updatedSamples.shift(); // Keep only the latest 100 samples
        }
        return updatedSamples;
      });
    };

    // Listen for sample-data-updated event
    const unsubscribe = window.electron.ipcRenderer.on('sample-data-updated', handleSampleDataUpdated);

    // Cleanup the event listener on component unmount
    return () => {
      unsubscribe();
    };
  }, []);

  const force = samples.map((sample) => sample['Sample Force (N)']);
  const position = samples.map((sample) => sample['Sample Position (mm)']);
  const gaugeLength = samples.map(
    (sample) =>
      sample['Machine Position (mm)'] - sample['Sample Position (mm)'],
  );
  const gaugeForce = samples.map(
    (sample) => sample['Machine Force (N)'] - sample['Sample Force (N)'],
  );
  return force.length && position.length ? (
    <LineChart
      grid={{ horizontal: true }}
      yAxis={[
        {
          id: 'force',
          scaleType: 'linear',
          label: 'Force (N)',
          min: -gaugeForce.pop() || 0,
          max: (config['Tensile Force Max (N)'] - gaugeForce.pop()) /1000 || 5,
        },
        {
          id: 'position',
          scaleType: 'linear',
          label: 'Position (mm)',
          min: -gaugeLength.pop() || 0,
          max: (config['Position Max (mm)'] - gaugeLength.pop()) || 1000,
        },
      ]}
      series={[
        {
          yAxisKey: 'force',
          data: force,
          type: 'line',
          showMark: false,
          label: 'Sample Force',
        },
        {
          yAxisKey: 'position',
          data: position,
          type: 'line',
          showMark: false,
          label: 'Sample Position',
        },
      ]}
      leftAxis="position"
      rightAxis="force"
      height={400}
      margin={{ top: 50, right: 80, bottom: 50, left: 80 }}
      sx={{
        [`.${axisClasses.left} .${axisClasses.label}`]: {
          transform: 'translate(-20px, 0)',
        },
        [`.${axisClasses.right} .${axisClasses.label}`]: {
          transform: 'translate(20px, 0)',
        },
      }}
    />
  ) : (
    <Skeleton variant="rounded" width="100%" height="400px" />
  );
}