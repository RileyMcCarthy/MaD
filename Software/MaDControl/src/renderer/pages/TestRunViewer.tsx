import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box,
  Typography,
  Paper,
  Grid,
  Button,
  Chip,
  CircularProgress,
  Table,
  TableBody,
  TableCell,
  TableRow,
} from '@mui/material';
import { ArrowBack as ArrowBackIcon } from '@mui/icons-material';
import { LineChart } from '@mui/x-charts/LineChart';
import { ScatterChart } from '@mui/x-charts/ScatterChart';
import { ChartsReferenceLine } from '@mui/x-charts/ChartsReferenceLine';
import { axisClasses } from '@mui/x-charts/ChartsAxis';
import { TestRunEntry } from '@shared/SharedInterface';
import { componentLogger } from '../utils/logger';

interface CsvRow {
  time_us: number;
  index: number;
  force_mN: number;
  position_um: number;
  setpoint_um: number;
}

function parseCsv(csvContent: string): CsvRow[] {
  const lines = csvContent.trim().split('\n');
  if (lines.length < 2) return [];

  return lines.slice(1).reduce<CsvRow[]>((rows, line) => {
    const parts = line.split(',');
    if (parts.length >= 5) {
      rows.push({
        time_us: parseFloat(parts[0]),
        index: parseInt(parts[1], 10),
        force_mN: parseFloat(parts[2]),
        position_um: parseFloat(parts[3]),
        setpoint_um: parseFloat(parts[4]),
      });
    }
    return rows;
  }, []);
}

/**
 * Generate expected position/time data from a motion profile's G-code.
 * This replicates the GCodeGenerator logic to create the expected motion curve.
 */
function generateExpectedMotion(gcode: string[]): {
  time: number[];
  position: number[];
} {
  const timePoints: number[] = [0];
  const positionPoints: number[] = [0];
  let currentTime = 0;
  let currentPosition = 0;
  let currentMode: 'absolute' | 'relative' = 'absolute';

  gcode.forEach((rawLine) => {
    const line = rawLine.trim();
    if (line === '' || line.startsWith(';')) return;

    if (line === 'G90') {
      currentMode = 'absolute';
      return;
    }
    if (line === 'G91') {
      currentMode = 'relative';
      return;
    }

    // G1 X<pos> F<vel>
    const g1Match = line.match(/^G[01]\s+X([\d.e+-]+)\s+F([\d.e+-]+)/i);
    if (g1Match) {
      const x = parseFloat(g1Match[1]);
      const f = parseFloat(g1Match[2]);
      const startPos = currentPosition;
      const startTime = currentTime;

      if (currentMode === 'absolute') {
        currentPosition = x;
      } else {
        currentPosition += x;
      }

      const dist = Math.abs(currentPosition - startPos);
      currentTime += f > 0 ? dist / f : 0;

      positionPoints.push(startPos);
      timePoints.push(startTime);
      positionPoints.push(currentPosition);
      timePoints.push(currentTime);
      return;
    }

    // G4 P<ms>
    const g4Match = line.match(/^G4\s+P([\d.e+-]+)/i);
    if (g4Match) {
      const dwellMs = parseFloat(g4Match[1]);
      const startTime = currentTime;
      currentTime += dwellMs / 1000;

      positionPoints.push(currentPosition);
      timePoints.push(startTime);
      positionPoints.push(currentPosition);
      timePoints.push(currentTime);
    }
  });

  return { time: timePoints, position: positionPoints };
}

export default function TestRunViewer() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [run, setRun] = useState<TestRunEntry | null>(null);
  const [csvRows, setCsvRows] = useState<CsvRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTestRun = async (testRunId: string) => {
    try {
      setLoading(true);
      setError(null);

      const testRun: TestRunEntry = await window.electron.ipcRenderer.invoke(
        'data-get-test-run',
        testRunId,
      );
      if (!testRun) {
        setError('Test run not found');
        return;
      }
      setRun(testRun);

      // Load CSV data
      if (testRun.dataFilePath) {
        const result = await window.electron.ipcRenderer.invoke(
          'data-read-test-csv',
          testRunId,
        );
        if (result.success && result.data) {
          const rows = parseCsv(result.data);
          setCsvRows(rows);
        } else {
          setError(result.error || 'Failed to load CSV data');
        }
      }
    } catch (err) {
      componentLogger.error('Failed to load test run:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!id) return;
    loadTestRun(id);
  }, [id]);

  // Convert raw data to chart-friendly units
  const chartData = useMemo(() => {
    if (csvRows.length === 0) return null;

    const time = csvRows.map((r) => r.time_us / 1_000_000); // seconds
    const force = csvRows.map((r) => r.force_mN / 1000); // N
    const position = csvRows.map((r) => r.position_um / 1000); // mm
    const setpoint = csvRows.map((r) => r.setpoint_um / 1000); // mm

    return { time, force, position, setpoint };
  }, [csvRows]);

  // Expected motion from G-code
  const expectedMotion = useMemo(() => {
    if (!run?.gcode || run.gcode.length === 0) return null;
    return generateExpectedMotion(run.gcode);
  }, [run?.gcode]);

  // Stress-strain data
  const stressStrainData = useMemo(() => {
    if (!chartData || !run?.sampleProfile) return null;

    const sp = run.sampleProfile;
    const area = sp.sampleWidth * sp.sampleThickness; // mm²
    if (area <= 0) return null;

    // We use the first position as gauge length reference
    const initialPosition = chartData.position[0] || 0;

    const data = chartData.time
      .map((_, i) => {
        const forceN = chartData.force[i];
        const pos = chartData.position[i];
        const stress = Math.abs(forceN) / area; // MPa
        const deltaL = Math.abs(pos - initialPosition);
        const gaugeLength = initialPosition > 0 ? initialPosition : 1;
        const strain = (deltaL / gaugeLength) * 100; // %

        return { x: strain, y: stress, id: i };
      })
      .filter(
        (p) =>
          Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0,
      );

    return data;
  }, [chartData, run?.sampleProfile]);

  // Sample profile restriction limits for stress-strain
  const stressStrainLimits = useMemo(() => {
    if (!run?.sampleProfile) {
      return { maxStress: undefined, maxStrain: undefined };
    }
    const sp = run.sampleProfile;
    const area = sp.sampleWidth * sp.sampleThickness;
    if (area <= 0) return { maxStress: undefined, maxStrain: undefined };

    const maxStress = sp.maxForce / area; // MPa
    const initialPosition = chartData?.position?.[0] || 1;
    const maxStrain = (sp.maxDisplacement / initialPosition) * 100; // %

    return { maxStress, maxStrain };
  }, [run?.sampleProfile, chartData]);

  if (loading) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: 'calc(100vh - 64px)',
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (error || !run) {
    return (
      <Box sx={{ p: 3 }}>
        <Button startIcon={<ArrowBackIcon />} onClick={() => navigate('/view')}>
          Back to Test Runs
        </Button>
        <Paper sx={{ p: 4, mt: 2, textAlign: 'center' }}>
          <Typography variant="h6" color="error">
            {error || 'Test run not found'}
          </Typography>
        </Paper>
      </Box>
    );
  }

  const sp = run.sampleProfile;
  const mp = run.motionProfile;

  return (
    <Box
      sx={{
        p: 3,
        height: 'calc(100vh - 64px)',
        overflow: 'auto',
        pb: 6,
      }}
    >
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          mb: 3,
          gap: 2,
        }}
      >
        <Button
          startIcon={<ArrowBackIcon />}
          onClick={() => navigate('/view')}
          variant="outlined"
        >
          Back
        </Button>
        <Typography variant="h4" sx={{ flexGrow: 1 }}>
          {run.testName}
        </Typography>
        <Chip
          label={run.status}
          color={run.status === 'downloaded' ? 'success' : 'default'}
        />
      </Box>

      {/* Info Cards */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        {/* Sample Profile Info */}
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6" gutterBottom>
              Sample Profile
            </Typography>
            {sp ? (
              <Table size="small">
                <TableBody>
                  <TableRow>
                    <TableCell>Sample Name</TableCell>
                    <TableCell>{run.sampleProfileId}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Max Force</TableCell>
                    <TableCell>{sp.maxForce} N</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Max Velocity</TableCell>
                    <TableCell>{sp.maxVelocity} mm/s</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Max Displacement</TableCell>
                    <TableCell>{sp.maxDisplacement} mm</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Width × Thickness</TableCell>
                    <TableCell>
                      {sp.sampleWidth} × {sp.sampleThickness} mm
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            ) : (
              <Typography color="text.secondary">Not available</Typography>
            )}
          </Paper>
        </Grid>

        {/* Motion Profile Info */}
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6" gutterBottom>
              Motion Profile
            </Typography>
            {mp ? (
              <Table size="small">
                <TableBody>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>{mp.name}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Description</TableCell>
                    <TableCell>{mp.description || '—'}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Sets</TableCell>
                    <TableCell>{mp.sets.length}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Started</TableCell>
                    <TableCell>
                      {new Date(run.startedAt).toLocaleString()}
                    </TableCell>
                  </TableRow>
                  {run.completedAt && (
                    <TableRow>
                      <TableCell>Completed</TableCell>
                      <TableCell>
                        {new Date(run.completedAt).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  )}
                  <TableRow>
                    <TableCell>Data Points</TableCell>
                    <TableCell>{csvRows.length}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            ) : (
              <Typography color="text.secondary">Not available</Typography>
            )}
          </Paper>
        </Grid>
      </Grid>

      {/* Charts */}
      {chartData ? (
        <Grid container spacing={2}>
          {/* Force vs Time */}
          <Grid item xs={12}>
            <Paper sx={{ p: 2 }}>
              <Typography variant="h6" gutterBottom>
                Force vs Time
              </Typography>
              <LineChart
                xAxis={[{ data: chartData.time, label: 'Time (s)' }]}
                yAxis={[
                  {
                    id: 'force',
                    label: 'Force (N)',
                  },
                ]}
                series={[
                  {
                    yAxisKey: 'force',
                    data: chartData.force,
                    label: 'Force',
                    showMark: false,
                    curve: 'linear',
                  },
                ]}
                height={350}
                margin={{ top: 40, right: 40, bottom: 50, left: 60 }}
                sx={{
                  [`.${axisClasses.left} .${axisClasses.label}`]: {
                    transform: 'translate(-10px, 0)',
                  },
                }}
              >
                {/* Max force restriction line */}
                {sp && (
                  <ChartsReferenceLine
                    y={sp.maxForce}
                    label="Max Force"
                    lineStyle={{ stroke: '#c62828', strokeDasharray: '6 4' }}
                    labelAlign="end"
                  />
                )}
              </LineChart>
            </Paper>
          </Grid>

          {/* Position vs Time — actual vs expected */}
          <Grid item xs={12}>
            <Paper sx={{ p: 2 }}>
              <Typography variant="h6" gutterBottom>
                Position vs Time (Actual vs Expected)
              </Typography>
              <LineChart
                xAxis={[
                  {
                    id: 'time',
                    data: chartData.time,
                    label: 'Time (s)',
                  },
                ]}
                yAxis={[
                  {
                    id: 'position',
                    label: 'Position (mm)',
                  },
                ]}
                series={[
                  {
                    yAxisKey: 'position',
                    data: chartData.position,
                    label: 'Actual Position',
                    showMark: false,
                    curve: 'linear',
                    color: '#1976d2',
                  },
                  {
                    yAxisKey: 'position',
                    data: chartData.setpoint,
                    label: 'Setpoint',
                    showMark: false,
                    curve: 'linear',
                    color: '#4caf50',
                  },
                ]}
                height={350}
                margin={{ top: 40, right: 40, bottom: 50, left: 60 }}
                sx={{
                  [`.${axisClasses.left} .${axisClasses.label}`]: {
                    transform: 'translate(-10px, 0)',
                  },
                }}
              >
                {/* Max displacement restriction line */}
                {sp && (
                  <ChartsReferenceLine
                    y={sp.maxDisplacement}
                    label="Max Displacement"
                    lineStyle={{ stroke: '#ef6c00', strokeDasharray: '6 4' }}
                    labelAlign="end"
                  />
                )}
              </LineChart>
            </Paper>
          </Grid>

          {/* Expected Motion Profile overlay */}
          {expectedMotion && expectedMotion.time.length > 1 && (
            <Grid item xs={12}>
              <Paper sx={{ p: 2 }}>
                <Typography variant="h6" gutterBottom>
                  Expected Motion Profile
                </Typography>
                <LineChart
                  xAxis={[
                    {
                      data: expectedMotion.time,
                      label: 'Time (s)',
                    },
                  ]}
                  yAxis={[
                    {
                      id: 'position',
                      label: 'Expected Position (mm)',
                    },
                  ]}
                  series={[
                    {
                      yAxisKey: 'position',
                      data: expectedMotion.position,
                      label: 'Expected',
                      showMark: false,
                      curve: 'linear',
                      color: '#ff9800',
                    },
                  ]}
                  height={300}
                  margin={{ top: 40, right: 40, bottom: 50, left: 60 }}
                  sx={{
                    [`.${axisClasses.left} .${axisClasses.label}`]: {
                      transform: 'translate(-10px, 0)',
                    },
                  }}
                />
              </Paper>
            </Grid>
          )}

          {/* Stress-Strain Chart */}
          <Grid item xs={12}>
            <Paper sx={{ p: 2 }}>
              <Typography variant="h6" gutterBottom>
                Stress-Strain
              </Typography>
              {stressStrainData && stressStrainData.length > 0 ? (
                <ScatterChart
                  grid={{ horizontal: true, vertical: true }}
                  xAxis={[
                    {
                      id: 'strain',
                      label: 'Strain (%)',
                      min: 0,
                      ...(stressStrainLimits.maxStrain != null && {
                        max: stressStrainLimits.maxStrain * 1.1,
                      }),
                    },
                  ]}
                  yAxis={[
                    {
                      id: 'stress',
                      label: 'Stress (MPa)',
                      min: 0,
                      ...(stressStrainLimits.maxStress != null && {
                        max: stressStrainLimits.maxStress * 1.1,
                      }),
                    },
                  ]}
                  series={[
                    {
                      data: stressStrainData,
                      label: 'Stress-Strain',
                      color: '#1976d2',
                    },
                  ]}
                  height={400}
                  margin={{ top: 40, right: 80, bottom: 80, left: 80 }}
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
                >
                  {stressStrainLimits.maxStrain !== undefined && (
                    <ChartsReferenceLine
                      x={stressStrainLimits.maxStrain}
                      label="Max Strain"
                      lineStyle={{
                        stroke: '#ef6c00',
                        strokeDasharray: '6 4',
                      }}
                      labelAlign="start"
                    />
                  )}
                  {stressStrainLimits.maxStress !== undefined && (
                    <ChartsReferenceLine
                      y={stressStrainLimits.maxStress}
                      label="Max Stress"
                      lineStyle={{
                        stroke: '#c62828',
                        strokeDasharray: '6 4',
                      }}
                      labelAlign="start"
                    />
                  )}
                </ScatterChart>
              ) : (
                <Box
                  sx={{
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    height: 300,
                  }}
                >
                  <Typography color="text.secondary">
                    {!sp
                      ? 'No sample profile data available for stress-strain calculation'
                      : 'No valid stress-strain data'}
                  </Typography>
                </Box>
              )}
            </Paper>
          </Grid>
        </Grid>
      ) : (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="h6" color="text.secondary">
            No test data available
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Download the data from the device first.
          </Typography>
        </Paper>
      )}
    </Box>
  );
}
