import { useEffect, useMemo, useRef, useState } from 'react';
import { LineChart } from '@mui/x-charts/LineChart';
import { ChartsReferenceLine } from '@mui/x-charts/ChartsReferenceLine';
import { axisClasses } from '@mui/x-charts/ChartsAxis';
import Skeleton from '@mui/material/Skeleton';
import {
  Box,
  Paper,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { SampleData } from '@shared/SharedInterface';
import { useDevice } from '@renderer/hooks';
import { componentLogger } from '../utils/logger';

type CoordinateSystem = 'sample' | 'machine';

export default function BasicLineChart() {
  const [deviceState, actions] = useDevice();
  const [coordinateSystem, setCoordinateSystem] =
    useState<CoordinateSystem>('machine');
  const [renderTick, setRenderTick] = useState(0);
  const liveSampleLimit = deviceState.liveSampleBufferSize;
  const liveSamplePeriodMs = deviceState.liveSamplePeriodMs;
  const SWEEP_DURATION_S = 60;
  const sampleForceBufferRef = useRef<Array<number | null>>([]);
  const samplePositionBufferRef = useRef<Array<number | null>>([]);
  const machineForceBufferRef = useRef<Array<number | null>>([]);
  const machinePositionBufferRef = useRef<Array<number | null>>([]);
  const timeAxisRef = useRef<number[]>([]);
  const writeIndexRef = useRef(0);
  const filledCountRef = useRef(0);
  const sweepStartTimeMsRef = useRef<number | null>(null);

  // Store actions in a ref to avoid re-running the effect when actions reference changes
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  const resetSweepBuffers = () => {
    sampleForceBufferRef.current = new Array<number | null>(liveSampleLimit).fill(
      null,
    );
    samplePositionBufferRef.current = new Array<number | null>(
      liveSampleLimit,
    ).fill(null);
    machineForceBufferRef.current = new Array<number | null>(
      liveSampleLimit,
    ).fill(null);
    machinePositionBufferRef.current = new Array<number | null>(
      liveSampleLimit,
    ).fill(null);
    timeAxisRef.current = new Array<number>(liveSampleLimit).fill(0);
    writeIndexRef.current = 0;
    filledCountRef.current = 0;
    sweepStartTimeMsRef.current = null;
  };

  const writeSampleToBuffers = (sample: SampleData, elapsedSec: number) => {
    const idx = writeIndexRef.current;
    const sampleForce = Number(sample['Sample Force (N)']);
    const samplePosition = Number(sample['Sample Position (mm)']);
    const machineForce = Number(sample['Machine Force (N)']);
    const machinePosition = Number(sample['Machine Position (mm)']);

    sampleForceBufferRef.current[idx] = Number.isFinite(sampleForce)
      ? sampleForce
      : null;
    samplePositionBufferRef.current[idx] = Number.isFinite(samplePosition)
      ? Number(samplePosition.toFixed(3))
      : null;
    machineForceBufferRef.current[idx] = Number.isFinite(machineForce)
      ? machineForce
      : null;
    machinePositionBufferRef.current[idx] = Number.isFinite(machinePosition)
      ? Number(machinePosition.toFixed(3))
      : null;
    timeAxisRef.current[idx] = elapsedSec;

    writeIndexRef.current = (idx + 1) % liveSampleLimit;
    filledCountRef.current = Math.min(filledCountRef.current + 1, liveSampleLimit);
  };

  const pushSampleToBuffers = (sample: SampleData) => {
    if (sampleForceBufferRef.current.length !== liveSampleLimit) {
      resetSweepBuffers();
    }

    const nowMs = Date.now();
    if (sweepStartTimeMsRef.current === null) {
      sweepStartTimeMsRef.current = nowMs;
    }

    let elapsedSec = (nowMs - sweepStartTimeMsRef.current) / 1000;
    if (elapsedSec >= SWEEP_DURATION_S) {
      resetSweepBuffers();
      sweepStartTimeMsRef.current = nowMs;
      elapsedSec = 0;
    }

    if (filledCountRef.current >= liveSampleLimit) {
      resetSweepBuffers();
      sweepStartTimeMsRef.current = nowMs;
      elapsedSec = 0;
    }
    writeSampleToBuffers(sample, elapsedSec);
  };

  useEffect(() => {
    resetSweepBuffers();

    // Function to initialize data on page load
    const initializeData = async () => {
      try {
        const data = await actionsRef.current.getCachedDeviceData(liveSampleLimit);
        if (data && data.length > 0) {
          // Seed with cached data so chart is immediately populated.
          const seeded = data.slice(-liveSampleLimit);
          sweepStartTimeMsRef.current = Date.now();

          seeded.forEach((sample, i) => {
            const elapsedSec = Math.min(
              (i * liveSamplePeriodMs) / 1000,
              SWEEP_DURATION_S,
            );
            writeSampleToBuffers(sample, elapsedSec);
          });
          setRenderTick((prev) => prev + 1);
        }
      } catch (error) {
        componentLogger.error('Failed to initialize data:', error);
      }
    };

    // Call the function to initialize data on page load
    initializeData();
  }, [liveSampleLimit, liveSamplePeriodMs]);

  // Update samples when new sample data comes from the hook
  useEffect(() => {
    if (deviceState.latestSampleData) {
      componentLogger.debug(
        'New sample data received:',
        deviceState.latestSampleData,
      );
      pushSampleToBuffers(deviceState.latestSampleData);
      setRenderTick((prev) => prev + 1);
    }
  }, [deviceState.latestSampleData, liveSampleLimit, liveSamplePeriodMs]);

  const force =
    coordinateSystem === 'machine'
      ? machineForceBufferRef.current
      : sampleForceBufferRef.current;
  const position =
    coordinateSystem === 'machine'
      ? machinePositionBufferRef.current
      : samplePositionBufferRef.current;
  const hasSweepData = filledCountRef.current > 0;

  const {
    forceMin,
    forceMax,
    lengthMin,
    lengthMax,
    limitForce,
    limitPosition,
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

    const limitForceVal =
      coordinateSystem === 'machine'
        ? asPositive(config?.['Tensile Force Max (N)'] as number | undefined)
        : minPositive([
            sampleProfile?.maxForce,
            (config?.['Tensile Force Max (N)'] as number | undefined),
          ]);

    const limitPosVal =
      coordinateSystem === 'machine'
        ? asPositive(config?.['Position Max (mm)'] as number | undefined)
        : minPositive([
            sampleProfile?.maxDisplacement,
            (config?.['Position Max (mm)'] as number | undefined),
          ]);

    const absMax = (values: Array<number | null>) =>
      values.reduce<number>((max, value) => {
        if (value === null || !Number.isFinite(value)) return max;
        return Math.max(max, Math.abs(value));
      }, 0);

    const dataForceMax = absMax(force);
    const dataPosMax = absMax(position);

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
    };
  }, [
    deviceState.machineConfiguration,
    deviceState.sampleProfile,
    renderTick,
    coordinateSystem,
  ]);

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
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            mb: 1,
          }}
        >
          <Typography variant="subtitle2">
            Coordinate System: {coordinateSystem === 'machine' ? 'Machine' : 'Sample'}
          </Typography>
          <ToggleButtonGroup
            size="small"
            value={coordinateSystem}
            exclusive
            onChange={(_event, value: CoordinateSystem | null) => {
              if (value) setCoordinateSystem(value);
            }}
          >
            <ToggleButton value="sample">Sample</ToggleButton>
            <ToggleButton value="machine">Machine</ToggleButton>
          </ToggleButtonGroup>
        </Box>
        {hasMachineConfig && hasSweepData ? (
          <LineChart
            grid={{ horizontal: true, vertical: false }}
            xAxis={[
              {
                id: 'time',
                data: timeAxisRef.current,
                label: 'Time (s)',
                min: 0,
                max: SWEEP_DURATION_S,
                tickNumber: 7,
                valueFormatter: (value: number) => `${value.toFixed(0)}s`,
              },
            ]}
            yAxis={[
              {
                id: 'force',
                scaleType: 'linear',
                label:
                  coordinateSystem === 'machine'
                    ? 'Machine Force (N)'
                    : 'Sample Force (N)',
                min: forceMin,
                max: forceMax,
              },
              {
                id: 'position',
                scaleType: 'linear',
                label:
                  coordinateSystem === 'machine'
                    ? 'Machine Position (mm)'
                    : 'Sample Position (mm)',
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
                label:
                  coordinateSystem === 'machine'
                    ? 'Machine Force'
                    : 'Sample Force',
                color: '#1976d2',
              },
              {
                yAxisKey: 'position',
                data: position,
                type: 'line',
                showMark: false,
                label:
                  coordinateSystem === 'machine'
                    ? 'Machine Position'
                    : 'Sample Position',
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
