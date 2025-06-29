import { useEffect, useState } from 'react';
import { LineChart } from '@mui/x-charts/LineChart';
import { SampleData } from '@shared/SharedInterface';
import Skeleton from '@mui/material/Skeleton';
import { axisClasses } from '@mui/x-charts/ChartsAxis';
import { useDevice } from '@renderer/hooks';
import { componentLogger } from '../utils/logger';

export default function BasicLineChart() {
  const [deviceState, actions] = useDevice();
  const [samples, setSamples] = useState<SampleData[]>([]);

  useEffect(() => {
    // Function to initialize data on page load
    const initializeData = async () => {
      try {
        const data = await actions.getAllDeviceData();
        if (data && data.length > 0) {
          setSamples(data.slice(-100)); // Save up to 100 samples
        }
      } catch (error) {
        componentLogger.error('Failed to initialize data:', error);
      }
    };

    // Call the function to initialize data on page load
    initializeData();
  }, [actions]);

  // Update samples when new sample data comes from the hook
  useEffect(() => {
    if (deviceState.latestSampleData) {
      componentLogger.debug('New sample data received:', deviceState.latestSampleData);
      setSamples((prevData) => {
        const updatedData = [...prevData, deviceState.latestSampleData!];
        return updatedData.slice(-100); // Keep only the last 100 samples
      });
    }
  }, [deviceState.latestSampleData]);

  const force = samples.map((sample) => sample['Sample Force (N)']);
  const position = samples.map((sample) => sample['Sample Position (mm)']);
  const gaugeLength = samples.map(
    (sample) =>
      sample['Machine Position (mm)'] - sample['Sample Position (mm)'],
  );
  const gaugeForce = samples.map(
    (sample) => sample['Machine Force (N)'] - sample['Sample Force (N)'],
  );

  const getAxisLimits = () => {
    const config = deviceState.machineConfiguration;
    if (!config || gaugeForce.length === 0 || gaugeLength.length === 0) {
      return {
        forceMin: 0,
        forceMax: 5,
        lengthMin: 0,
        lengthMax: 1000,
      };
    }

    const forceMin = Math.min(...gaugeForce);
    const forceMax = Math.max(...gaugeForce);
    const lengthMin = Math.min(...gaugeLength);
    const lengthMax = Math.max(...gaugeLength);

    const tensileForceMax = config['Tensile Force Max (N)'] as number;
    const positionMax = config['Position Max (mm)'] as number;

    return {
      forceMin: -forceMin || 0,
      forceMax: (tensileForceMax - forceMax) / 1000 || 5,
      lengthMin: -lengthMin || 0,
      lengthMax: (positionMax - lengthMax) || 1000,
    };
  };

  const { forceMin, forceMax, lengthMin, lengthMax } = getAxisLimits();

  return force.length && position.length ? (
    <LineChart
      grid={{ horizontal: true }}
      yAxis={[
        {
          id: 'force',
          scaleType: 'linear',
          label: 'Force (N)',
          min: forceMin,
          max: forceMax,
        },
        {
          id: 'position',
          scaleType: 'linear',
          label: 'Position (mm)',
          min: lengthMin,
          max: lengthMax,
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
