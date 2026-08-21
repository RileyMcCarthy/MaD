import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  TestRunEntry,
  parseTestCSV,
  TestDataPoint,
  generateExpectedMotion,
  interpolateExpected,
  computeStressStrain,
} from '@/domain';
import { dataStore } from '@/storage/DataStore';
import StaticLineChart from '@/ui/components/StaticLineChart';
import StaticScatterChart from '@/ui/components/StaticScatterChart';

export default function TestRunViewer() {
  const { testName } = useParams<{ testName: string }>();
  const navigate = useNavigate();
  const [run, setRun] = useState<TestRunEntry | null>(null);
  const [points, setPoints] = useState<TestDataPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!testName) return;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const entry = await dataStore.getTestRun(testName);
        if (!entry) {
          setError('Test run not found.');
          return;
        }
        setRun(entry);
        const csv = await dataStore.readTestCsv(testName);
        if (csv) setPoints(parseTestCSV(csv));
        else setError('No data file — download the run first.');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [testName]);

  const times = useMemo(() => points.map((p) => p.timeS), [points]);
  const force = useMemo(() => points.map((p) => p.forceN), [points]);
  const actual = useMemo(() => points.map((p) => p.positionMm), [points]);
  const setpoint = useMemo(() => points.map((p) => p.setpointMm), [points]);

  const expected = useMemo(() => {
    if (!run?.gcode?.length || points.length === 0) return null;
    const initial = points[0].positionMm ?? points[0].setpointMm ?? 0;
    return interpolateExpected(generateExpectedMotion(run.gcode, initial), times);
  }, [run?.gcode, points, times]);

  const stressStrain = useMemo(() => {
    if (!run?.sampleProfile || points.length === 0) return null;
    return computeStressStrain(points, run.sampleProfile, run.gaugeLengthMm ?? 1);
  }, [run?.sampleProfile, run?.gaugeLengthMm, points]);

  if (loading) {
    return (
      <div>
        <h1>Test Run</h1>
        <div className="panel muted">Loading…</div>
      </div>
    );
  }

  if (error || !run) {
    return (
      <div>
        <button onClick={() => navigate('/runs')}>← Back</button>
        <div className="panel fault" style={{ marginTop: 12 }}>
          {error || 'Test run not found.'}
        </div>
      </div>
    );
  }

  const sp = run.sampleProfile;
  const hasData = points.length > 0;

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <button onClick={() => navigate('/runs')}>← Back</button>
        <h1 style={{ margin: 0 }}>{run.testName}</h1>
        <span className={`badge ${run.status}`}>{run.status}</span>
      </div>

      {/* Info cards */}
      <div className="grid cols-2">
        <div className="panel">
          <h2>Sample Profile</h2>
          <table>
            <tbody>
              <tr><td>Max Force</td><td>{sp.maxForce} N</td></tr>
              <tr><td>Max Displacement</td><td>{sp.maxDisplacement} mm</td></tr>
              <tr><td>Width × Thickness</td><td>{sp.sampleWidth} × {sp.sampleThickness} mm</td></tr>
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h2>Run</h2>
          <table>
            <tbody>
              <tr><td>Motion profile</td><td>{run.motionProfile?.name || '—'}</td></tr>
              <tr><td>Started</td><td className="muted">{new Date(run.startedAt).toLocaleString()}</td></tr>
              {run.completedAt && (
                <tr><td>Completed</td><td className="muted">{new Date(run.completedAt).toLocaleString()}</td></tr>
              )}
              <tr><td>Data points</td><td>{points.length}</td></tr>
              {run.gaugeLengthMm !== undefined && Number.isFinite(run.gaugeLengthMm) && (
                <tr><td>Gauge length</td><td>{run.gaugeLengthMm.toFixed(3)} mm</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {!hasData ? (
        <div className="panel muted">No data to plot.</div>
      ) : (
        <>
          <div className="panel" data-testid="chart-force">
            <h2>Force vs Time</h2>
            <StaticLineChart
              xLabel="Time (s)"
              yLabel="Force (N)"
              x={times}
              series={[{ label: 'Force', color: '#4ea1ff', data: force }]}
              yRefLines={[{ value: sp.maxForce, label: 'Max Force', color: '#ff5d5d' }]}
            />
          </div>

          <div className="panel" data-testid="chart-position">
            <h2>Position vs Time (Actual / Setpoint / Expected)</h2>
            <StaticLineChart
              xLabel="Time (s)"
              yLabel="Sample extension (mm)"
              x={times}
              series={[
                { label: 'Actual', color: '#4ea1ff', data: actual },
                { label: 'Setpoint', color: '#2bd4a7', data: setpoint },
                ...(expected ? [{ label: 'Expected (G-code)', color: '#ffb454', data: expected }] : []),
              ]}
              yRefLines={[{ value: sp.maxDisplacement, label: 'Max Displacement', color: '#ffb454' }]}
            />
          </div>

          <div className="panel" data-testid="chart-stress-strain">
            <h2>Stress–Strain</h2>
            {stressStrain && stressStrain.data.length > 0 ? (
              <StaticScatterChart
                xLabel="Strain (%)"
                yLabel="Stress (MPa)"
                points={stressStrain.data}
                xRefLines={
                  stressStrain.maxStrain !== undefined
                    ? [{ value: stressStrain.maxStrain, label: 'Max Strain', color: '#ffb454' }]
                    : []
                }
                yRefLines={
                  stressStrain.maxStress !== undefined
                    ? [{ value: stressStrain.maxStress, label: 'Max Stress', color: '#ff5d5d' }]
                    : []
                }
              />
            ) : (
              <p className="muted">No valid stress–strain data (needs sample width × thickness).</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
