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
  Tooltip,
  IconButton,
} from '@mui/material';
import {
  ArrowBack as ArrowBackIcon,
  HelpOutline as HelpOutlineIcon,
} from '@mui/icons-material';
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
    if (parts.length >= 4) {
      const hasIndexColumn = parts.length >= 5;
      rows.push({
        time_us: parseFloat(parts[0]),
        index: hasIndexColumn ? parseInt(parts[1], 10) : rows.length,
        force_mN: parseFloat(hasIndexColumn ? parts[2] : parts[1]),
        position_um: parseFloat(hasIndexColumn ? parts[3] : parts[2]),
        setpoint_um: parseFloat(hasIndexColumn ? parts[4] : parts[3]),
      });
    }
    return rows;
  }, []);
}

/**
 * Generate expected position/time data from a motion profile's G-code.
 * This replicates the GCodeGenerator logic to create the expected motion curve.
 */
function generateExpectedMotion(
  gcode: string[],
  initialPositionMm: number,
): {
  time: number[];
  position: number[];
} {
  const timePoints: number[] = [0];
  const positionPoints: number[] = [initialPositionMm];
  let currentTime = 0;
  let currentPosition = initialPositionMm;
  let currentMode: 'absolute' | 'relative' = 'absolute';

  gcode.forEach((rawLine) => {
    const line = rawLine.trim();
    if (line === '' || line.startsWith(';')) return;

    const tokens = line.split(/\s+/);
    let g: number | null = null;
    let x: number | null = null;
    let f: number | null = null;
    let p: number | null = null;

    tokens.forEach((token) => {
      if (!token) return;
      const code = token[0].toUpperCase();
      const value = parseFloat(token.slice(1));
      if (Number.isNaN(value)) return;

      switch (code) {
        case 'G':
          g = Math.round(value);
          break;
        case 'X':
          x = value;
          break;
        case 'F':
          f = value;
          break;
        case 'P':
          p = value;
          break;
        default:
          break;
      }
    });

    if (g === 90) {
      currentMode = 'absolute';
      return;
    }

    if (g === 91) {
      currentMode = 'relative';
      return;
    }

    if ((g === 0 || g === 1) && x !== null) {
      const startPos = currentPosition;
      const startTime = currentTime;

      if (currentMode === 'absolute') {
        currentPosition = x;
      } else {
        currentPosition += x;
      }

      const dist = Math.abs(currentPosition - startPos);
      const feed = f ?? 0;
      currentTime += feed > 0 ? dist / feed : 0;

      positionPoints.push(startPos);
      timePoints.push(startTime);
      positionPoints.push(currentPosition);
      timePoints.push(currentTime);
      return;
    }

    if (g === 4 && p !== null) {
      const dwellMs = p;
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

  // Logged CSV is firmware sample frame (µm → mm here).
  const chartData = useMemo(() => {
    if (csvRows.length === 0) return null;

    const time = csvRows.map((r) => r.time_us / 1_000_000); // seconds
    const force = csvRows.map((r) => r.force_mN / 1000); // N
    const samplePositionMm = csvRows.map((r) => r.position_um / 1000);
    const sampleSetpointMm = csvRows.map((r) => r.setpoint_um / 1000);

    return { time, force, samplePositionMm, sampleSetpointMm };
  }, [csvRows]);

  /** Position chart in sample coordinates (same frame as logged CSV setpoint/position). */
  const positionChart = useMemo(() => {
    if (!chartData) return null;
    return {
      frame: 'sample' as const,
      actual: chartData.samplePositionMm,
      setpoint: chartData.sampleSetpointMm,
      yAxisLabel: 'Sample extension (mm)',
    };
  }, [chartData]);

  // Expected motion from G-code in sample coordinates.
  const expectedPositionData = useMemo(() => {
    if (!run?.gcode || run.gcode.length === 0 || !chartData || !positionChart)
      return null;
    // Anchor expected trace to the run's observed sample-frame baseline so
    // relative G-code starts from the same coordinate as logged data.
    const initialSampleMm =
      chartData.samplePositionMm[0] ?? chartData.sampleSetpointMm[0] ?? 0;
    const expected = generateExpectedMotion(run.gcode, initialSampleMm);
    const { time: expTime, position: expPos } = expected;
    if (expTime.length < 2) return null;

    const lastIdx = expTime.length - 1;
    const [firstTime] = expTime;
    const [firstPos] = expPos;
    const lastTime = expTime[lastIdx];
    const lastPos = expPos[lastIdx];

    // O(n + m) interpolation (sample times + expected segments) to keep large
    // test-run pages responsive.
    const out: number[] = [];
    let seg = 0;
    chartData.time.forEach((t) => {
      if (t <= firstTime) {
        out.push(firstPos);
        return;
      }
      if (t >= lastTime) {
        out.push(lastPos);
        return;
      }

      while (seg < lastIdx - 1 && t > expTime[seg + 1]) {
        seg += 1;
      }
      const t0 = expTime[seg];
      const t1 = expTime[seg + 1];
      const p0 = expPos[seg];
      const p1 = expPos[seg + 1];
      const frac = (t - t0) / (t1 - t0 || 1);
      out.push(p0 + frac * (p1 - p0));
    });
    return out;
  }, [run?.gcode, chartData, positionChart]);

  // Expose baseline for E2E assertions without parsing chart SVG output.
  const expectedBaselineForTests = useMemo(() => {
    const initialSampleMm =
      chartData?.samplePositionMm?.[0] ?? chartData?.sampleSetpointMm?.[0] ?? 0;
    let expectedStartMm: number | null = null;
    if (run?.gcode?.length && chartData) {
      const raw = generateExpectedMotion(run.gcode, initialSampleMm);
      expectedStartMm = raw.position[0] ?? null;
    }
    return { initialSampleMm, expectedStartMm };
  }, [chartData, run?.gcode]);

  // Gauge length reference used for strain calculations.
  // Prefer persisted machine/sample coordinate relationship from the run.
  const strainGaugeLengthMm = useMemo(() => {
    if (run?.gaugeLengthMm !== undefined && Number.isFinite(run.gaugeLengthMm) && run.gaugeLengthMm > 0) {
      return run.gaugeLengthMm;
    }
    // Fallback for legacy runs that did not persist gaugeLengthMm.
    return 1;
  }, [run?.gaugeLengthMm]);

  // Stress-strain data
  const stressStrainData = useMemo(() => {
    if (!chartData || !run?.sampleProfile) return null;

    const sp = run.sampleProfile;
    const area = sp.sampleWidth * sp.sampleThickness; // mm²
    if (area <= 0) return null;

    // Sample extension in CSV is sample-frame; strain denominator comes from
    // machine/sample reference captured at run start (gaugeLengthMm).
    const initialPosition = chartData.samplePositionMm[0] || 0;

    const data = chartData.time
      .map((_, i) => {
        const forceN = chartData.force[i];
        const pos = chartData.samplePositionMm[i];
        const stress = Math.abs(forceN) / area; // MPa
        const deltaL = Math.abs(pos - initialPosition);
        const strain = (deltaL / strainGaugeLengthMm) * 100; // %

        return { x: strain, y: stress, id: i };
      })
      .filter(
        (p) =>
          Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0,
      );

    return data;
  }, [chartData, run?.sampleProfile, strainGaugeLengthMm]);

  // Sample profile restriction limits for stress-strain
  const stressStrainLimits = useMemo(() => {
    if (!run?.sampleProfile) {
      return { maxStress: undefined, maxStrain: undefined };
    }
    const sp = run.sampleProfile;
    const area = sp.sampleWidth * sp.sampleThickness;
    if (area <= 0) return { maxStress: undefined, maxStrain: undefined };

    const maxStress = sp.maxForce / area; // MPa
    const initialPosition = chartData?.samplePositionMm?.[0] || 1;
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
                  {run.gaugeLengthMm !== undefined &&
                    Number.isFinite(run.gaugeLengthMm) && (
                      <TableRow>
                        <TableCell>Gauge length (saved)</TableCell>
                        <TableCell>{run.gaugeLengthMm.toFixed(3)} mm</TableCell>
                      </TableRow>
                    )}
                </TableBody>
              </Table>
            ) : (
              <Typography color="text.secondary">Not available</Typography>
            )}
          </Paper>
        </Grid>
      </Grid>

      {/* Charts */}
      {chartData && positionChart ? (
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
              <Box data-testid="expected-gcode-baseline" sx={{ display: 'none' }}>
                {JSON.stringify(expectedBaselineForTests)}
              </Box>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  mb: 1,
                  flexWrap: 'wrap',
                }}
              >
                <Typography variant="h6" component="span">
                  Position vs Time (Actual vs Expected)
                </Typography>
                <Tooltip
                  title={
                    'Shown in sample coordinates. Logged CSV position_um / setpoint_um are sample-relative, and expected G-code is plotted in the same sample frame.'
                  }
                >
                  <IconButton size="small" aria-label="Position chart help">
                    <HelpOutlineIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Box>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mb: 1 }}
              >
                Sample coordinate frame — expected and measured traces are directly comparable without gauge-length offset.
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
                    label: positionChart.yAxisLabel,
                  },
                ]}
                series={[
                  {
                    yAxisKey: 'position',
                    data: positionChart.actual,
                    label: 'Actual (sample)',
                    showMark: false,
                    curve: 'linear',
                    color: '#1976d2',
                  },
                  {
                    yAxisKey: 'position',
                    data: positionChart.setpoint,
                    label: 'Setpoint (sample)',
                    showMark: false,
                    curve: 'linear',
                    color: '#4caf50',
                  },
                  ...(expectedPositionData
                    ? [
                        {
                          yAxisKey: 'position' as const,
                          data: expectedPositionData,
                          label: 'Expected (G-code X)',
                          showMark: false,
                          curve: 'linear' as const,
                          color: '#ff9800',
                        },
                      ]
                    : []),
                ]}
                height={350}
                margin={{ top: 40, right: 40, bottom: 50, left: 60 }}
                sx={{
                  [`.${axisClasses.left} .${axisClasses.label}`]: {
                    transform: 'translate(-10px, 0)',
                  },
                }}
              >
                {/* Max displacement applies to sample extension magnitude. */}
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
                    },
                  ]}
                  yAxis={[
                    {
                      id: 'stress',
                      label: 'Stress (MPa)',
                      min: 0,
                    },
                  ]}
                  series={[
                    {
                      data: stressStrainData,
                      label: 'Stress-Strain',
                      color: '#1976d2',
                      markerSize: 2,
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
