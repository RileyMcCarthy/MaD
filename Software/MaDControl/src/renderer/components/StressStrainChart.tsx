import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { ScatterChart } from '@mui/x-charts/ScatterChart';
import { ChartsReferenceLine } from '@mui/x-charts/ChartsReferenceLine';
import { SampleData } from '@shared/SharedInterface';
import { Paper, Box, Typography, IconButton, Tooltip } from '@mui/material';
import { Clear as ClearIcon } from '@mui/icons-material';
import { axisClasses } from '@mui/x-charts/ChartsAxis';
import { useDevice } from '@renderer/hooks';
import { componentLogger } from '../utils/logger';

export default function StressStrainChart() {
  const [deviceState, actions] = useDevice();
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const [samples, setSamples] = useState<SampleData[]>([]);
  const [lastTestRunning, setLastTestRunning] = useState<boolean>(false);
  const [, setUpdateCounter] = useState<number>(0);

  useEffect(() => {
    // Function to initialize data on page load
    const initializeData = async () => {
      try {
        const data = await actionsRef.current.getCachedDeviceData(500);
        if (data && data.length > 0) {
          setSamples(data.slice(-500)); // Save up to 500 samples for better performance
        }
      } catch (error) {
        componentLogger.error('Failed to initialize data:', error);
      }
    };

    // Call the function to initialize data on page load
    initializeData();
  }, []);

  // Clear data when test state changes
  useEffect(() => {
    const currentTestRunning = deviceState.machineState?.testRunning || false;

    // If test just started, clear old data
    if (currentTestRunning && !lastTestRunning) {
      componentLogger.info('Test started - clearing stress-strain data');
      setSamples([]);
    }

    // If test just stopped, keep the data but mark the transition
    if (!currentTestRunning && lastTestRunning) {
      componentLogger.info('Test stopped - preserving stress-strain data');
    }

    setLastTestRunning(currentTestRunning);
  }, [deviceState.machineState?.testRunning, lastTestRunning]);

  // Update samples when new sample data comes from the hook
  useEffect(() => {
    if (deviceState.latestSampleData) {
      const currentTestRunning = deviceState.machineState?.testRunning || false;

      // Only accumulate data during active testing
      if (currentTestRunning) {
        // Throttle updates - only update every 3rd sample to improve performance
        setUpdateCounter(prev => {
          const newCounter = prev + 1;
          if (newCounter % 3 === 0) {
            componentLogger.debug(
              'New sample data received during test:',
              deviceState.latestSampleData,
            );
            setSamples((prevData) => {
              const updatedData = [...prevData, deviceState.latestSampleData!];
              // Limit to 500 points for better performance while still showing detail
              return updatedData.slice(-500);
            });
          }
          return newCounter;
        });
      }
    }
  }, [deviceState.latestSampleData, deviceState.machineState?.testRunning]);

  // Get sample profile from device state
  const sampleProfile = deviceState.sampleProfile;

  // Memoize the expensive stress-strain calculations
  const { stressStrainData, hasValidProfile } = useMemo(() => {
    // Don't show any data if we don't have samples
    if (samples.length === 0) {
      return { stressStrainData: [], hasValidProfile: false };
    }

    // Check if we have a valid sample profile loaded from firmware
    if (!sampleProfile || !sampleProfile.sampleWidth || !sampleProfile.sampleThickness || !deviceState.machineConfiguration) {
      return { stressStrainData: [], hasValidProfile: false };
    }

    // Use actual sample dimensions from firmware sample profile
    const sampleWidth = sampleProfile.sampleWidth; // mm
    const sampleThickness = sampleProfile.sampleThickness; // mm

    const crossSectionalArea = sampleWidth * sampleThickness; // mm²

    // Get jaw offset from machine configuration
    const jawOffset = deviceState.machineConfiguration['Jaw Offset (mm)']; // Default fallback

    const stressStrainData = samples.map((sample, pointIndex) => {
      const force = sample['Sample Force (N)'];
      const currentMachinePosition = sample['Machine Position (mm)'];

      // Stress = Force / Area (MPa = N/mm²)
      const stress = Math.abs(force) / crossSectionalArea;

      // Strain = ΔL / L₀ (dimensionless)
      // ΔL = change in jaw separation from initial position
      // L₀ = initial jaw separation (actual sample length)
      const deltaLength = Math.abs(currentMachinePosition - jawOffset);
      const strain = jawOffset > 0 ? deltaLength / jawOffset : 0;

      return {
        x: strain * 100, // Convert to percentage strain
        y: stress,
        id: pointIndex,
      };
    }).filter(point => point.x >= 0 && point.y >= 0 && isFinite(point.x) && isFinite(point.y));

    // Show up to 1000 points without data reduction
    const finalData = stressStrainData;

    return { stressStrainData: finalData, hasValidProfile: true };
  }, [samples, sampleProfile, deviceState.machineConfiguration]);

  const handleClearData = useCallback(() => {
    setSamples([]);
    componentLogger.info('Stress-strain data manually cleared');
  }, []);

  // Memoize axis limits calculation
  const { stressMin, stressMax, strainMin, strainMax, limitStress, limitStrain } = useMemo(() => {
    if (sampleProfile && hasValidProfile) {
      const sampleWidth = sampleProfile.sampleWidth; // mm
      const sampleThickness = sampleProfile.sampleThickness; // mm
      const crossSectionalArea = sampleWidth * sampleThickness; // mm²
      const maxStress = crossSectionalArea > 0 ? sampleProfile.maxForce / crossSectionalArea : 0; // MPa

      const jawOffset = deviceState.machineConfiguration?.['Jaw Offset (mm)'] || 50;
      const maxStrain = jawOffset > 0 ? (sampleProfile.maxDisplacement / jawOffset) * 100 : 0; // percentage

      if (maxStress > 0 && maxStrain > 0) {
        return {
          stressMin: 0,
          stressMax: maxStress * 1.1,
          strainMin: 0,
          strainMax: maxStrain * 1.1,
          limitStress: maxStress,
          limitStrain: maxStrain,
        };
      }
    }

    return {
      stressMin: 0,
      stressMax: 10,
      strainMin: 0,
      strainMax: 5,
      limitStress: undefined,
      limitStrain: undefined,
    };
  }, [sampleProfile, hasValidProfile, deviceState.machineConfiguration]);

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
        {/* Header with title and clear button */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
          <Typography variant="h6" component="h3">
            Stress-Strain Chart
          </Typography>
          {samples.length > 0 && (
            <Tooltip title="Clear chart data">
              <IconButton onClick={handleClearData} size="small">
                <ClearIcon />
              </IconButton>
            </Tooltip>
          )}
        </Box>

      {samples.length === 0 ? (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 400 }}>
          <Typography variant="body1" color="text.secondary">
            No sample data available
          </Typography>
        </Box>
      ) : !hasValidProfile ? (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 400 }}>
          <Typography variant="body1" color="text.secondary">
            {!sampleProfile ? 'Load a sample profile in Test Runner to view stress-strain data' : 'Invalid sample profile dimensions'}
          </Typography>
        </Box>
      ) : stressStrainData.length > 0 ? (
        <ScatterChart
          grid={{ horizontal: true, vertical: true }}
          xAxis={[
            {
              id: 'strain',
              scaleType: 'linear',
              label: 'Strain (%)',
              min: strainMin,
              max: strainMax,
            },
          ]}
          yAxis={[
            {
              id: 'stress',
              scaleType: 'linear',
              label: 'Stress (MPa)',
              min: stressMin,
              max: stressMax,
            },
          ]}
          series={[
            {
              data: stressStrainData,
              type: 'scatter',
              label: 'Stress-Strain',
              color: '#1976d2',
            },
          ]}
          slots={{
            referenceLine: ChartsReferenceLine,
          }}
          slotProps={{
            referenceLine: {
              labelStyle: { fontSize: 12 },
              lineStyle: { strokeWidth: 1.5 },
            },
          }}
          children={(
            <>
              {limitStrain !== undefined && (
                <ChartsReferenceLine
                  x={limitStrain}
                  label="Max Strain"
                  lineStyle={{ stroke: '#ef6c00' }}
                  labelAlign="start"
                />
              )}
              {limitStress !== undefined && (
                <ChartsReferenceLine
                  y={limitStress}
                  label="Max Stress"
                  lineStyle={{ stroke: '#c62828' }}
                  labelAlign="start"
                />
              )}
            </>
          )}
          height={400}
          margin={{ top: 50, right: 80, bottom: 80, left: 80 }}
          disableAxisListener
          skipAnimation
          sx={{
            [`.${axisClasses.left} .${axisClasses.label}`]: {
              transform: 'translate(-20px, 0)',
            },
            [`.${axisClasses.bottom} .${axisClasses.label}`]: {
              transform: 'translate(0, 20px)',
            },
          }}
        />
      ) : (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 400 }}>
          <Typography variant="body1" color="text.secondary">
            Waiting for valid stress-strain data...
          </Typography>
        </Box>
      )}
      </Paper>
    </Box>
  );
}
