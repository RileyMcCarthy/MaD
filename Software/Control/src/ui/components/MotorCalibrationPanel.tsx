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
  type CalibrationProgress,
} from '@/domain/motorCalibration';

const SEVERITY_CLASS: Record<CalibrationFinding['severity'], string> = {
  ok: 'downloaded',
  warning: 'running',
  error: 'error',
};

const SEVERITY_RANK: Record<CalibrationFinding['severity'], number> = { error: 0, warning: 1, ok: 2 };

/** What the button says while the machine works. */
const BUTTON_PROGRESS: Record<CalibrationProgress, string> = {
  forward: 'Driving forward…',
  reverse: 'Driving back…',
};

/** What the single result line shows. */
type Outcome =
  | { kind: 'measured'; assessment: CalibrationAssessment; profile: CalibrationProfile }
  | { kind: 'failed'; badge: string; message: string };

function round(v: number, digits: number): string {
  return Number(v.toPrecision(digits)).toString();
}

/**
 * Open-loop check of the drive/encoder pair against the steps/mm being edited
 * above. Report only: it never changes the profile. One result, one line of
 * numbers, and what to do about it.
 */
export default function MotorCalibrationPanel({
  profile,
  device,
}: {
  /** The steps/mm being edited: what is judged. */
  profile: CalibrationProfile;
  /** The steps/mm saved on the machine: what its G-code and positions use. */
  device: CalibrationProfile;
}) {
  const motionEnabled = useStore((s) => s.machineState?.motionEnabled ?? false);
  const [distanceMm, setDistanceMm] = useState(CALIBRATION_DEFAULT_DISTANCE_MM);
  const [speedMmPerS, setSpeedMmPerS] = useState(CALIBRATION_DEFAULT_SPEED_MM_S);
  const [progress, setProgress] = useState<CalibrationProgress | 'starting' | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const running = progress !== null;
  const plan = planCalibration({ ...profile, distanceMm, speedMmPerS, device });

  const onRun = async () => {
    if (!plan.ok) return;
    // Frozen: editing the fields while it runs must not relabel the result.
    const judgedAgainst = { ...profile };
    setOutcome(null);
    setProgress('starting');
    try {
      const run = await runCalibration(
        {
          move: (mm, speed) => deviceClient.openLoopMove(mm, speed),
          position: () => useStore.getState().latestSample?.['Machine Position (mm)'] ?? null,
          motionEnabled: () => useStore.getState().machineState?.motionEnabled ?? false,
          testRunning: () => useStore.getState().machineState?.testRunning ?? false,
          stop: async () => {
            await deviceClient.setMotionEnabled(false);
          },
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now: () => Date.now(),
        },
        plan.request,
        device,
        setProgress,
      );
      if (!run.ok) {
        setOutcome({ kind: 'failed', badge: 'error', message: run.reason });
      } else if (run.result.outcome === 'done') {
        setOutcome({
          kind: 'measured',
          assessment: assessCalibration(run.result, judgedAgainst),
          profile: judgedAgainst,
        });
      } else {
        const refused = run.result.outcome.startsWith('refused');
        setOutcome({
          kind: 'failed',
          badge: refused ? 'not run' : 'stopped',
          message: OUTCOME_TEXT[run.result.outcome],
        });
      }
    } catch (err) {
      setOutcome({ kind: 'failed', badge: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setProgress(null);
    }
  };

  const hint = !motionEnabled ? 'Enable motion to run it.' : !plan.ok ? plan.reason : null;

  return (
    <div style={{ marginTop: 24 }}>
      <h3>Motor calibration</h3>
      <p className="muted">
        Moves the carriage a short way forward and back with the servo loop off, and checks the
        encoder and servo steps/mm above against the hardware. Nothing is saved.
      </p>

      <div className="row" style={{ alignItems: 'flex-end' }}>
        <NumberField label="Distance each way (mm)" value={distanceMm} min={0} onChange={setDistanceMm} />
        <NumberField label="Speed (mm/s)" value={speedMmPerS} min={0} onChange={setSpeedMmPerS} />
        <button className="primary" onClick={onRun} disabled={running || !plan.ok || !motionEnabled}>
          {progress === null ? 'Run calibration' : progress === 'starting' ? 'Starting…' : BUTTON_PROGRESS[progress]}
        </button>
      </div>
      {hint && !running && <p className="muted">{hint}</p>}

      {outcome && <CalibrationResultCard outcome={outcome} />}
    </div>
  );
}

function CalibrationResultCard({ outcome }: { outcome: Outcome }) {
  const cardStyle = { marginTop: 14, padding: 14, background: 'var(--panel-2)', borderRadius: 8 };
  if (outcome.kind === 'failed') {
    return (
      <div style={cardStyle} data-testid="calibration-result">
        <span className="badge error">{outcome.badge}</span> {outcome.message}
      </div>
    );
  }
  const { assessment, profile } = outcome;
  // The worst finding is the headline; anything else is one muted note.
  const byWorst = [...assessment.findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  const headline = byWorst[0];
  const rest = byWorst.filter((f) => f !== headline);
  return (
    <div style={cardStyle} data-testid="calibration-result">
      <div>
        <span className={`badge ${SEVERITY_CLASS[headline.severity]}`}>
          {headline.severity === 'ok' ? 'pass' : headline.severity}
        </span>{' '}
        {headline.message}
      </div>
      <p style={{ margin: '10px 0 0' }}>
        Sent {Math.round(assessment.pulsesSent)} pulses each way (
        {round(assessment.pulsesSent / profile.servoStepsPerMM, 3)} mm at {profile.servoStepsPerMM}{' '}
        servo steps/mm) → encoder moved{' '}
        <strong data-testid="measured-counts">{Math.round(assessment.countsMeasured)}</strong> counts{' '}
        <span className="muted">
          (expected <span data-testid="expected-counts">{Math.round(assessment.countsExpected)}</span>)
        </span>
      </p>
      {headline.id === 'ratio-mismatch' &&
        assessment.impliedServoStepsPerMM !== null &&
        assessment.impliedEncoderStepsPerMM !== null && (
          <p style={{ margin: '8px 0 0' }} data-testid="suggested-fix">
            Fix: if encoder steps/mm ({profile.encoderStepsPerMM}) is right, set servo steps/mm to{' '}
            <strong>{Math.round(assessment.impliedServoStepsPerMM)}</strong>. If servo steps/mm (
            {profile.servoStepsPerMM}) is right, set encoder steps/mm to{' '}
            <strong>{Math.round(assessment.impliedEncoderStepsPerMM)}</strong>.
          </p>
        )}
      {rest.length > 0 && (
        <p className="muted" style={{ margin: '8px 0 0' }}>
          {rest.map((f) => f.message).join(' ')}
        </p>
      )}
    </div>
  );
}
