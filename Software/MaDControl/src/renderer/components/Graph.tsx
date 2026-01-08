import { useEffect, useMemo, useState } from 'react';
import { LineChart } from '@mui/x-charts/LineChart';
import { ChartsReferenceLine } from '@mui/x-charts/ChartsReferenceLine';
import { axisClasses } from '@mui/x-charts/ChartsAxis';
import Skeleton from '@mui/material/Skeleton';
import { Box, Paper } from '@mui/material';
import { SampleData } from '@shared/SharedInterface';
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
      componentLogger.debug(
        'New sample data received:',
        deviceState.latestSampleData,
      );
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

  const {
    forceMin,
    forceMax,
    lengthMin,
    lengthMax,
    limitForce,
    limitPosition,
    debug,
  } = useMemo(() => {
    const config = deviceState.machineConfiguration;
    const sampleProfile = deviceState.sampleProfile;

    const asPositive = (val: unknown) => {
      const n = Number(val);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };

    const minPositive = (values: Array<unknown>) => {
      const filtered = values.map(asPositive).filter((v): v is number => v !== undefined);
      return filtered.length ? Math.min(...filtered) : undefined;
    };

    const limitForceVal = minPositive([
      sampleProfile?.maxForce,
      (config?.['Tensile Force Max (N)'] as number | undefined),
    ]);

    const limitPosVal = minPositive([
      sampleProfile?.maxDisplacement,
      (config?.['Position Max (mm)'] as number | undefined),
    ]);

    const dataForceMax = gaugeForce.length ? Math.max(...gaugeForce.map((v) => Math.abs(v))) : 0;
    const dataPosMax = gaugeLength.length ? Math.max(...gaugeLength.map((v) => Math.abs(v))) : 0;

    const forceBase = limitForceVal ?? (dataForceMax > 0 ? dataForceMax : 5);
    const posBase = limitPosVal ?? (dataPosMax > 0 ? dataPosMax : 1000);

    const margin = 1.1;

    return {
      forceMin: 0,
      forceMax: forceBase * margin,
      lengthMin: 0,
      lengthMax: posBase * margin,
      limitForce: limitForceVal,
      limitPosition: limitPosVal,
      debug: {
        sampleMaxForce: sampleProfile?.maxForce,
        machineMaxForce: config?.['Tensile Force Max (N)'],
        sampleMaxDisplacement: sampleProfile?.maxDisplacement,
        machineMaxPosition: config?.['Position Max (mm)'],
        dataForceMax,
        dataPosMax,
        forceBase,
        posBase,
      },
    };
  }, [deviceState.machineConfiguration, deviceState.sampleProfile, gaugeForce, gaugeLength]);

  useEffect(() => {
    componentLogger.info('Graph bounds debug', debug);
  }, [debug]);

  // Wait for machine profile before rendering bounds
  const hasMachineConfig = Boolean(deviceState.machineConfiguration);

  return (
    <Box sx={{ flexGrow: 1 }}>
      <Paper
        elevation={1}
        sx={{
          padding: (theme) => theme.spacing(1),
          backgroundColor: (theme) => theme.palette.mode === 'dark' ? '#1A2027' : '#fff',
          color: (theme) => theme.palette.text.secondary,
        }}
      >
        {hasMachineConfig && force.length && position.length ? (
          <LineChart
            grid={{ horizontal: true, vertical: true }}
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
                color: '#1976d2',
              },
              {
                yAxisKey: 'position',
                data: position,
                type: 'line',
                showMark: false,
                label: 'Sample Position',
                color: '#388e3c',
              },
            ]}
            leftAxis="position"
            rightAxis="force"
            slots={{ referenceLine: ChartsReferenceLine }}
            slotProps={{
              referenceLine: {
                labelStyle: { fontSize: 12 },
                lineStyle: { strokeWidth: 1.5 },
              },
            }}
            children={(
              <>
                {limitPosition !== undefined && (
                  <ChartsReferenceLine
                    y={limitPosition}
                    yAxisKey="position"
                    label="Max Position"
                    lineStyle={{ stroke: '#ef6c00' }}
                    labelAlign="start"
                  />
                )}
                {limitForce !== undefined && (
                  <ChartsReferenceLine
                    y={limitForce}
                    yAxisKey="force"
                    label="Max Force"
                    lineStyle={{ stroke: '#c62828' }}
                    labelAlign="start"
                  />
                )}
              </>
            )}
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
        )}
      </Paper>
    </Box>
  );
}
