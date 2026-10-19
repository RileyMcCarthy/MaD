import { useState } from 'react';
import { useStore } from '@/store/useStore';
import { deviceClient } from '@/device/session';
import NumberField from '@/ui/components/NumberField';
import {
  CALIBRATION_DEFAULT_DISTANCE_MM,
  CALIBRATION_DEFAULT_SPEED_MM_S,
  OUTCOME_TEXT,
  assessCalibration,
  planCalibration,
  runCalibration,
  type CalibrationAssessment,
  type CalibrationFinding,
  type CalibrationProfile,
  type CalibrationResult,
} from '@/domain/motorCalibration';

const SEVERITY_CLASS: Record<CalibrationFinding['severity'], string> = {
  ok: 'downloaded',
  warning: 'running',
  error: 'error',
};

function fmt(n: number, digits = 4): string {
  return Number(n.toPrecision(digits)).toString();
}

/**
 * Open-loop check of the drive/encoder pair against the steps/mm being
 * edited above. Report only: it never changes the profile.
 */
export default function MotorCalibrationPanel({ profile }: { profile: CalibrationProfile }) {
  const motionEnabled = useStore((s) => s.machineState?.motionEnabled ?? false);
  const [distanceMm, setDistanceMm] = useState(CALIBRATION_DEFAULT_DISTANCE_MM);
  const [speedMmPerS, setSpeedMmPerS] = useState(CALIBRATION_DEFAULT_SPEED_MM_S);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<CalibrationResult | null>(null);
  const [assessment, setAssessment] = useState<CalibrationAssessment | null>(null);
  const [error, setError] = useState<string | null>(null);

  const plan = planCalibration({ ...profile, distanceMm, speedMmPerS });

  const onRun = async () => {
    if (!plan.ok) return;
    // The profile the run was planned from, frozen: editing the fields while
    // it runs must not change what the result is judged against.
    const judgedAgainst = { ...profile };
    setRunning(true);
    setError(null);
    setAssessment(null);
    setProgress(null);
    try {
      const run = await runCalibration(
        {
          start: (r) => deviceClient.startMotorCalibration(r),
          read: () => deviceClient.readMotorCalibrationResult(),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now: () => Date.now(),
        },
        plan.request,
        setProgress,
      );
      if (!run.ok) {
        setError(run.reason);
      } else if (run.result.outcome === 'done') {
        setAssessment(assessCalibration(run.result, judgedAgainst));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{ marginTop: 24 }}>
      <h3>Motor calibration</h3>
      <p className="muted">
        Drives the carriage open loop (servo loop off) a short distance forward and back, and checks
        how far the encoder moved against the encoder and servo steps/mm above. Nothing is changed:
        the results tell you what to fix. Enable motion and keep the carriage clear of the end
        stops.
      </p>

      <div className="row" style={{ marginBottom: 12, alignItems: 'flex-end' }}>
        <NumberField label="Distance each way (mm)" value={distanceMm} min={0} onChange={setDistanceMm} />
        <NumberField label="Speed (mm/s)" value={speedMmPerS} min={0} onChange={setSpeedMmPerS} />
        <button className="primary" onClick={onRun} disabled={running || !plan.ok || !motionEnabled}>
          {running ? 'Running…' : 'Run calibration'}
        </button>
      </div>

      {!motionEnabled && <p className="muted">Enable motion to run the calibration.</p>}
      {!plan.ok && <p className="muted">{plan.reason}</p>}
      {plan.ok && (
        <p className="muted">
          {plan.request.pulses} pulses each way at {plan.request.frequency} pulses/s; stops if the
          encoder moves more than {plan.request.maxCounts} counts.
        </p>
      )}

      {progress && !assessment && <p>{OUTCOME_TEXT[progress.outcome]}</p>}
      {error && <p className="badge error">{error}</p>}

      {assessment && <CalibrationReport assessment={assessment} />}
    </div>
  );
}

function CalibrationReport({ assessment }: { assessment: CalibrationAssessment }) {
  const rows = [
    { name: 'Forward', leg: assessment.forward },
    { name: 'Back', leg: assessment.reverse },
  ];
  return (
    <>
      <table>
        <thead>
          <tr>
            <th>Direction</th>
            <th>Pulses sent</th>
            <th>Encoder counts</th>
            <th>Counts per pulse</th>
            <th>Profile expects</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ name, leg }) => (
            <tr key={name}>
              <td>{name}</td>
              <td>{leg.pulses}</td>
              <td>{leg.counts}</td>
              <td>{fmt(leg.countsPerPulse)}</td>
              <td>{fmt(assessment.expectedCountsPerPulse)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {assessment.findings.map((f) => (
          <li key={f.id} style={{ margin: '8px 0' }}>
            <span className={`badge ${SEVERITY_CLASS[f.severity]}`}>{f.severity}</span> {f.message}
          </li>
        ))}
      </ul>

      {assessment.findings.some((f) => f.id === 'ratio-mismatch') &&
        assessment.impliedServoStepsPerMM !== null &&
        assessment.impliedEncoderStepsPerMM !== null && (
          <p className="muted">
            If encoder steps/mm is right, servo steps/mm should be about{' '}
            <strong>{fmt(assessment.impliedServoStepsPerMM, 5)}</strong>. If servo steps/mm is
            right, encoder steps/mm should be about{' '}
            <strong>{fmt(assessment.impliedEncoderStepsPerMM, 5)}</strong>. Check the encoder's
            counts per revolution and the drive's pulses per revolution to tell which.
          </p>
        )}
    </>
  );
}
