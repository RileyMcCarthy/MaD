import { useState } from 'react';
import { useStore } from '@/store/useStore';
import { deviceClient } from '@/device/session';
import { latestLiveSample, liveClockSeconds, liveSamplesSince } from '@/store/liveBuffer';
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
  type CalibrationResult,
} from '@/domain/motorCalibration';
import {
  trackingMayRun,
  planTrackingRun,
  runTracking,
  suggestGains,
  summarizeTracking,
  type GainSuggestion,
  type MachineLimits,
  type MotionSample,
  type MoveMeasurement,
  type TrackingRunner,
  type TrackingSummary,
} from '@/domain/motionBenchmark';

const SEVERITY_CLASS: Record<CalibrationFinding['severity'], string> = {
  ok: 'downloaded',
  warning: 'running',
  error: 'error',
};

const SEVERITY_RANK: Record<CalibrationFinding['severity'], number> = { error: 0, warning: 1, ok: 2 };

const RATIO_PROGRESS: Record<CalibrationProgress, string> = {
  'take-up': 'taking up slack…',
  forward: 'driving forward…',
  reverse: 'driving back…',
};

/** The machine as saved: what its G-code, positions and servo actually use. */
export interface SavedMachine extends CalibrationProfile, MachineLimits {
  /** 1/s */
  servoKp: number;
  /** 1/s^2 */
  servoKi: number;
}

type TrackingReport =
  | { ran: false; why: string }
  | { ran: true; stopped: string | null; moves: MoveMeasurement[]; summary: TrackingSummary; gains: GainSuggestion };

type Report =
  | { kind: 'failed'; badge: string; message: string }
  | {
      kind: 'measured';
      profile: CalibrationProfile;
      saved: SavedMachine;
      ratio: CalibrationAssessment;
      lostMotionCounts: number | null;
      lagSeconds: number | null;
      tracking: TrackingReport;
    };

function num(v: number, digits = 1): string {
  return Number(v.toFixed(digits)).toString();
}

function toMotionSamples(sinceSeconds: number): MotionSample[] {
  return liveSamplesSince(sinceSeconds).map((s) => ({
    t: s.t,
    position: s.machinePosition,
    commanded: s.machineCommanded,
    setpoint: s.machineSetpoint,
  }));
}

type CommonRunner = Omit<TrackingRunner, 'jog'>;

/**
 * Motor calibration and motion benchmark, against the steps/mm being edited
 * above and the profile saved on the machine. Report only: nothing is saved.
 */
export default function MotorCalibrationPanel({
  profile,
  saved,
}: {
  /** The steps/mm being edited: what the ratio check judges. */
  profile: CalibrationProfile;
  /** The profile saved on the machine: what the moves and the tracking run use. */
  saved: SavedMachine;
}) {
  const motionEnabled = useStore((s) => s.machineState?.motionEnabled ?? false);
  const [distanceMm, setDistanceMm] = useState(CALIBRATION_DEFAULT_DISTANCE_MM);
  const [speedMmPerS, setSpeedMmPerS] = useState(CALIBRATION_DEFAULT_SPEED_MM_S);
  const [progress, setProgress] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);

  const running = progress !== null;
  const plan = planCalibration({ ...profile, distanceMm, speedMmPerS, device: saved });
  const tracking = planTrackingRun(saved);

  const common: CommonRunner = {
    samplesSince: toMotionSamples,
    clock: liveClockSeconds,
    motionEnabled: () => useStore.getState().machineState?.motionEnabled ?? false,
    stop: async () => {
      await deviceClient.setMotionEnabled(false);
    },
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };

  const onRun = async () => {
    if (!plan.ok) return;
    // Frozen: editing the fields while it runs must not relabel the result.
    const judgedAgainst = { ...profile };
    const savedAtStart = { ...saved };
    setReport(null);
    setProgress('Starting…');
    try {
      const run = await runCalibration(
        {
          ...common,
          move: (mm, speed) => deviceClient.openLoopMove(mm, speed),
          position: () => latestLiveSample()?.machinePosition ?? null,
          testRunning: () => useStore.getState().machineState?.testRunning ?? false,
        },
        plan.request,
        savedAtStart,
        (p) => setProgress(`Drive and encoder: ${RATIO_PROGRESS[p]}`),
      );
      if (!run.ok) {
        setReport({ kind: 'failed', badge: 'error', message: run.reason });
      } else if (run.result.outcome !== 'done') {
        setReport({
          kind: 'failed',
          badge: run.result.outcome.startsWith('refused') ? 'not run' : 'stopped',
          message: OUTCOME_TEXT[run.result.outcome],
        });
      } else {
        setReport(await finishReport(run.result, judgedAgainst, savedAtStart, common, setProgress));
      }
    } catch (err) {
      setReport({ kind: 'failed', badge: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setProgress(null);
    }
  };

  const hint = !motionEnabled ? 'Enable motion to run it.' : !plan.ok ? plan.reason : null;

  return (
    <div style={{ marginTop: 24 }}>
      <h3>Motor calibration</h3>
      <p className="muted">
        Checks the encoder and servo steps/mm above against the hardware with the servo loop off, then
        runs a short test program closed loop to measure how closely the servo follows its encoder, and
        suggests servo gains. Nothing is saved.
      </p>
      {tracking.ok ? (
        <p data-testid="calibration-warning" style={{ margin: '0 0 12px' }}>
          <span className="badge running">before running</span> Velocity Max, Acceleration Max and
          Position Max must be right in the profile saved on the machine. The test program moves up to{' '}
          {num(tracking.travelMm / 2, 3)} mm either side of where the carriage is now, at up to{' '}
          {saved.maxVelocityMmPerS} mm/s and {saved.maxAccelMmPerS2} mm/s². Leave that much room each
          way.
        </p>
      ) : (
        <p className="muted">{tracking.reason}</p>
      )}

      <div className="row" style={{ alignItems: 'flex-end' }}>
        <NumberField label="Check distance (mm)" value={distanceMm} min={0} onChange={setDistanceMm} />
        <NumberField label="Check speed (mm/s)" value={speedMmPerS} min={0} onChange={setSpeedMmPerS} />
        <button className="primary" onClick={onRun} disabled={running || !plan.ok || !motionEnabled}>
          {progress ?? 'Run calibration'}
        </button>
      </div>
      {hint && !running && <p className="muted">{hint}</p>}

      {report && <CalibrationReport report={report} />}
    </div>
  );
}

async function finishReport(
  result: CalibrationResult,
  profile: CalibrationProfile,
  saved: SavedMachine,
  common: CommonRunner,
  setProgress: (p: string) => void,
): Promise<Report> {
  const ratio = assessCalibration(result, profile);
  const base = {
    kind: 'measured' as const,
    profile,
    saved,
    ratio,
    lostMotionCounts: result.lostMotionCounts ?? null,
    lagSeconds: result.lagSeconds ?? null,
  };
  if (ratio.findings.some((f) => f.severity === 'error')) {
    return {
      ...base,
      tracking: { ran: false, why: 'Fix the drive and encoder first: the servo cannot track on these settings.' },
    };
  }
  if (!trackingMayRun(profile, saved)) {
    return {
      ...base,
      tracking: {
        ran: false,
        why: 'The tracking run moves with the steps/mm saved on the machine, and they differ from the ones checked here. Write these to the device, restart the machine, and run again.',
      },
    };
  }
  const plan = planTrackingRun(saved);
  if (!plan.ok) return { ...base, tracking: { ran: false, why: plan.reason } };
  const run = await runTracking(
    { ...common, jog: (mm, speed) => deviceClient.manualMove(mm, speed) },
    plan.moves,
    saved,
    (i) => setProgress(`Tracking: move ${i + 1} of ${plan.moves.length}…`),
  );
  const summary = summarizeTracking(run.measurements);
  const stopped =
    run.outcome === 'done'
      ? null
      : run.outcome === 'aborted-overtravel'
        ? 'Stopped: the carriage went further than a move asked for.'
        : run.outcome === 'aborted-motion-disabled'
          ? 'Stopped: motion was disabled.'
          : 'Stopped: the machine turned a move down.';
  return {
    ...base,
    tracking: {
      ran: true,
      stopped,
      moves: run.measurements,
      summary,
      gains: suggestGains({ lagSeconds: result.lagSeconds ?? null, limits: saved, summary }),
    },
  };
}

function CalibrationReport({ report }: { report: Report }) {
  const card = { marginTop: 14, padding: 14, background: 'var(--panel-2)', borderRadius: 8 };
  if (report.kind === 'failed') {
    return (
      <div style={card} data-testid="calibration-result">
        <span className="badge error">{report.badge}</span> {report.message}
      </div>
    );
  }
  const { ratio, profile, saved } = report;
  const byWorst = [...ratio.findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const headline = byWorst[0];
  const rest = byWorst.slice(1);
  const umPerCount = 1000 / saved.encoderStepsPerMM;
  return (
    <div style={card} data-testid="calibration-result">
      <h4 style={{ margin: '0 0 8px' }}>Drive and encoder</h4>
      <div>
        <span className={`badge ${SEVERITY_CLASS[headline.severity]}`}>
          {headline.severity === 'ok' ? 'pass' : headline.severity}
        </span>{' '}
        {headline.message}
      </div>
      <p style={{ margin: '8px 0 0' }}>
        Sent {Math.round(ratio.pulsesSent)} pulses each way → encoder moved{' '}
        <strong data-testid="measured-counts">{Math.round(ratio.countsMeasured)}</strong> counts{' '}
        <span className="muted">
          (expected <span data-testid="expected-counts">{Math.round(ratio.countsExpected)}</span>)
        </span>
      </p>
      {headline.id === 'ratio-mismatch' &&
        ratio.impliedServoStepsPerMM !== null &&
        ratio.impliedEncoderStepsPerMM !== null && (
          <p style={{ margin: '8px 0 0' }} data-testid="suggested-fix">
            Fix: if encoder steps/mm ({profile.encoderStepsPerMM}) is right, set servo steps/mm to{' '}
            <strong>{Math.round(ratio.impliedServoStepsPerMM)}</strong>. If servo steps/mm (
            {profile.servoStepsPerMM}) is right, set encoder steps/mm to{' '}
            <strong>{Math.round(ratio.impliedEncoderStepsPerMM)}</strong>.
          </p>
        )}
      {rest.length > 0 && (
        <p className="muted" style={{ margin: '8px 0 0' }}>
          {rest.map((f) => f.message).join(' ')}
        </p>
      )}
      <p style={{ margin: '8px 0 0' }}>
        Lost motion on reversal:{' '}
        <strong data-testid="lost-motion">
          {report.lostMotionCounts === null
            ? '—'
            : `${report.lostMotionCounts} counts (${num(report.lostMotionCounts * umPerCount)} µm)`}
        </strong>
        {report.lagSeconds !== null && <span className="muted"> · drive lag {num(report.lagSeconds * 1000)} ms</span>}
      </p>

      <h4 style={{ margin: '16px 0 8px' }}>Tracking</h4>
      {report.tracking.ran ? (
        <TrackingSection tracking={report.tracking} saved={saved} />
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          Not run. {report.tracking.why}
        </p>
      )}
    </div>
  );
}

function TrackingSection({
  tracking,
  saved,
}: {
  tracking: Extract<TrackingReport, { ran: true }>;
  saved: SavedMachine;
}) {
  const s = tracking.summary;
  return (
    <>
      {tracking.stopped && (
        <p style={{ margin: '0 0 8px' }}>
          <span className="badge error">stopped</span> {tracking.stopped}
        </p>
      )}
      <p style={{ margin: 0 }} data-testid="tracking-summary">
        Stops within <strong>±{num(s.maxAbsFinalErrorUm)} µm</strong>{' '}
        <span className="muted">(mean {num(s.meanAbsFinalErrorUm)} µm)</span> · peak following error{' '}
        <strong>{num(s.maxFollowingErrorUm)} µm</strong> · overshoot <strong>{num(s.maxOvershootUm)} µm</strong>
        {s.maxSettleMs !== null && (
          <>
            {' '}
            · settles in <strong>{Math.round(s.maxSettleMs)} ms</strong>
          </>
        )}
      </p>
      <p className="muted" style={{ margin: '4px 0 0' }}>
        Measured against the machine&apos;s own encoder: how closely the servo follows it, not the
        carriage&apos;s true position.
      </p>
      <details style={{ marginTop: 8 }}>
        <summary className="muted">Each move</summary>
        <table>
          <thead>
            <tr>
              <th>Move</th>
              <th>Stop error (µm)</th>
              <th>Peak following (µm)</th>
              <th>Overshoot (µm)</th>
              <th>Settle (ms)</th>
            </tr>
          </thead>
          <tbody>
            {tracking.moves.map((m, i) => (
              <tr key={i}>
                <td>{m.label}</td>
                <td>{num(m.finalErrorUm)}</td>
                <td>{num(m.peakFollowingErrorUm)}</td>
                <td>{num(m.overshootUm)}</td>
                <td>{m.settleMs === null ? '—' : Math.round(m.settleMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <h4 style={{ margin: '16px 0 8px' }}>Suggested servo gains</h4>
      <p style={{ margin: 0 }} data-testid="suggested-gains">
        Servo Kp <strong>{tracking.gains.kp}</strong> /s, Servo Ki <strong>{tracking.gains.ki}</strong> /s²{' '}
        <span className="muted">
          (now {saved.servoKp} and {saved.servoKi})
        </span>
      </p>
      <p className="muted" style={{ margin: '4px 0 0' }}>
        {tracking.gains.notes.join(' ')} A starting point: enter them above, Write to device, restart the
        machine, and run this again to compare.
      </p>
    </>
  );
}
