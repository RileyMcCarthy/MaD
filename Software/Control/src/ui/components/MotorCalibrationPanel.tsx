import { useState } from 'react';
import { useStore } from '@/store/useStore';
import { deviceClient } from '@/device/session';
import { latestLiveSample, liveClockSeconds, liveSamplesSince } from '@/store/liveBuffer';
import {
  CALIBRATION_CHECK_DISTANCE_MM,
  CALIBRATION_CHECK_SPEED_MM_S,
  OUTCOME_TEXT,
  assessCalibration,
  planCalibration,
  runCalibration,
  type CalibrationAssessment,
  type CalibrationFinding,
  type CalibrationProfile,
  type CalibrationProgress,
} from '@/domain/motorCalibration';
import {
  ACCEL_DELIVERED_MIN,
  assessAcceleration,
  trackingMayRun,
  planTrackingRun,
  runTracking,
  suggestGains,
  summarizeTracking,
  type AccelVerdict,
  type GainSuggestion,
  type MachineLimits,
  type MotionSample,
  type MoveMeasurement,
  type TrackingRunner,
  type TrackingOutcome,
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

type CheckReport =
  | { kind: 'failed'; badge: string; message: string }
  | {
      kind: 'measured';
      profile: CalibrationProfile;
      saved: SavedMachine;
      ratio: CalibrationAssessment;
      lostMotionCounts: number | null;
      lagSeconds: number | null;
    };

type MotionReport =
  | { kind: 'failed'; message: string }
  | {
      kind: 'measured';
      stopped: string | null;
      moves: MoveMeasurement[];
      summary: TrackingSummary;
      accel: AccelVerdict;
      gains: GainSuggestion;
    };

/** A drive and encoder check that passed: the steps/mm it passed on and the drive lag it measured. */
interface PassedCheck {
  encoderStepsPerMM: number;
  servoStepsPerMM: number;
  lagSeconds: number | null;
}

/** Samples arrive every ~13 ms, so a settle shorter than one sample is "at once". */
const SAMPLE_MS = 15;

function settleText(ms: number): string {
  return ms < SAMPLE_MS ? 'at once' : `in ${Math.round(ms)} ms`;
}

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

const CARD = { marginTop: 14, padding: 14, background: 'var(--panel-2)', borderRadius: 8 };

/**
 * Motor calibration as two routines against the profile saved on the machine.
 * Report only: nothing is saved.
 *
 * 1. Drive and encoder check: pulses out against encoder counts in, with the
 *    servo loop off, judged against the steps/mm being edited.
 * 2. Motion calibration: the closed-loop acceleration sweep and tracking run,
 *    and suggested servo gains. It moves closed loop on the SAVED steps/mm, so
 *    it unlocks only once the check has passed on exactly those.
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
  const [checkProgress, setCheckProgress] = useState<string | null>(null);
  const [checkReport, setCheckReport] = useState<CheckReport | null>(null);
  const [passed, setPassed] = useState<PassedCheck | null>(null);
  const [motionProgress, setMotionProgress] = useState<string | null>(null);
  const [motionReport, setMotionReport] = useState<MotionReport | null>(null);

  const running = checkProgress !== null || motionProgress !== null;
  const plan = planCalibration({
    ...profile,
    distanceMm: CALIBRATION_CHECK_DISTANCE_MM,
    speedMmPerS: CALIBRATION_CHECK_SPEED_MM_S,
    device: saved,
  });
  const tracking = planTrackingRun(saved);
  const checkedSaved = passed !== null && trackingMayRun(passed, saved);

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

  const onCheck = async () => {
    if (!plan.ok) return;
    // Frozen: editing the fields while it runs must not relabel the result.
    const judgedAgainst = { ...profile };
    const savedAtStart = { ...saved };
    setCheckReport(null);
    setPassed(null);
    setCheckProgress('Starting…');
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
        (p) => setCheckProgress(RATIO_PROGRESS[p]),
      );
      if (!run.ok) {
        setCheckReport({ kind: 'failed', badge: 'error', message: run.reason });
      } else if (run.result.outcome !== 'done') {
        setCheckReport({
          kind: 'failed',
          badge: run.result.outcome.startsWith('refused') ? 'not run' : 'stopped',
          message: OUTCOME_TEXT[run.result.outcome],
        });
      } else {
        const ratio = assessCalibration(run.result, judgedAgainst);
        const lagSeconds = run.result.lagSeconds ?? null;
        setCheckReport({
          kind: 'measured',
          profile: judgedAgainst,
          saved: savedAtStart,
          ratio,
          lostMotionCounts: run.result.lostMotionCounts ?? null,
          lagSeconds,
        });
        if (!ratio.findings.some((f) => f.severity === 'error')) setPassed({ ...judgedAgainst, lagSeconds });
      }
    } catch (err) {
      setCheckReport({ kind: 'failed', badge: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setCheckProgress(null);
    }
  };

  const onMotion = async () => {
    if (!tracking.ok || passed === null) return;
    const savedAtStart = { ...saved };
    const lagSeconds = passed.lagSeconds;
    setMotionReport(null);
    setMotionProgress('Starting…');
    try {
      const run = await runTracking(
        { ...common, jog: (mm, speed) => deviceClient.manualMove(mm, speed) },
        tracking.moves,
        savedAtStart,
        (i) => setMotionProgress(`Move ${i + 1} of ${tracking.moves.length}…`),
      );
      const summary = summarizeTracking(run.measurements);
      setMotionReport({
        kind: 'measured',
        stopped: STOPPED_TEXT[run.outcome],
        moves: run.measurements,
        summary,
        accel: assessAcceleration(run.measurements, savedAtStart, lagSeconds),
        gains: suggestGains({ lagSeconds, limits: savedAtStart, summary }),
      });
    } catch (err) {
      setMotionReport({ kind: 'failed', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setMotionProgress(null);
    }
  };

  const checkHint = !motionEnabled ? 'Enable motion to run it.' : !plan.ok ? plan.reason : null;
  const motionHint = !tracking.ok
    ? tracking.reason
    : !checkedSaved
      ? passed === null
        ? 'Run the drive and encoder check first: this moves closed loop on the steps/mm saved on the machine.'
        : 'The check passed on steps/mm the machine has not saved. Write them to the device, restart the machine, and run the check again.'
      : !motionEnabled
        ? 'Enable motion to run it.'
        : null;

  return (
    <div>
      <h3>1 · Drive and encoder check</h3>
      <p className="muted">
        Sends a known number of step pulses with the servo loop off ({CALIBRATION_CHECK_DISTANCE_MM} mm each way at{' '}
        {CALIBRATION_CHECK_SPEED_MM_S} mm/s) and counts what the encoder sees, to check the encoder and servo
        steps/mm in Machine configuration against the hardware. Also measures lost motion on reversal and the
        drive&apos;s lag.
      </p>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <button className="primary" onClick={onCheck} disabled={running || !plan.ok || !motionEnabled}>
          {checkProgress ?? 'Run check'}
        </button>
      </div>
      {checkHint && checkProgress === null && <p className="muted">{checkHint}</p>}
      {checkReport && <CheckResult report={checkReport} />}

      <h3 style={{ marginTop: 24 }}>2 · Motion calibration</h3>
      <p className="muted">
        Runs a short test program closed loop: it ramps at Acceleration Max to a quarter, half, three quarters
        and all of Velocity Max to check the machine can deliver that acceleration, measures how closely the
        servo follows its encoder, and suggests servo gains.
      </p>
      {tracking.ok && (
        <p data-testid="calibration-warning" style={{ margin: '0 0 12px' }}>
          <span className="badge running">before running</span> Velocity Max, Acceleration Max and Position Max
          must be right in the profile saved on the machine. The test program moves up to{' '}
          {num(tracking.travelMm / 2, 3)} mm either side of where the carriage is now, at up to{' '}
          {saved.maxVelocityMmPerS} mm/s and {saved.maxAccelMmPerS2} mm/s². Leave that much room each way.
        </p>
      )}
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <button
          className="primary"
          onClick={onMotion}
          disabled={running || !tracking.ok || !checkedSaved || !motionEnabled}
        >
          {motionProgress ?? 'Run motion calibration'}
        </button>
      </div>
      {motionHint && motionProgress === null && <p className="muted">{motionHint}</p>}
      {motionReport && <MotionResult report={motionReport} saved={saved} />}
    </div>
  );
}

const STOPPED_TEXT: Record<TrackingOutcome, string | null> = {
  done: null,
  'aborted-overtravel': 'Stopped: the carriage went further than a move asked for.',
  'aborted-motion-disabled': 'Stopped: motion was disabled.',
  'aborted-timeout': 'Stopped: a move never finished.',
  'move-refused': 'Stopped: the machine turned a move down.',
};

function CheckResult({ report }: { report: CheckReport }) {
  if (report.kind === 'failed') {
    return (
      <div style={CARD} data-testid="calibration-result">
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
    <div style={CARD} data-testid="calibration-result">
      <div>
        <span className={`badge ${SEVERITY_CLASS[headline.severity]}`}>
          {headline.severity === 'ok' ? 'pass' : headline.severity}
        </span>{' '}
        {headline.message}
      </div>
      <p style={{ margin: '8px 0 0' }}>
        Sent {Math.round(ratio.pulsesSent)} pulses each way → encoder moved{' '}
        {ratio.countsMeasured === null ? (
          <strong data-testid="per-direction-counts">
            forward {Math.round(ratio.forward.counts)} · back {Math.round(ratio.reverse.counts)}
          </strong>
        ) : (
          <strong data-testid="measured-counts">{Math.round(ratio.countsMeasured)}</strong>
        )}{' '}
        counts{' '}
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
            : `${report.lostMotionCounts} ${Math.abs(report.lostMotionCounts) === 1 ? 'count' : 'counts'} (${num(report.lostMotionCounts * umPerCount)} µm)`}
        </strong>
        {report.lagSeconds !== null && <span className="muted"> · drive lag {num(report.lagSeconds * 1000)} ms</span>}
      </p>
    </div>
  );
}

function MotionResult({ report, saved }: { report: MotionReport; saved: SavedMachine }) {
  if (report.kind === 'failed') {
    return (
      <div style={CARD} data-testid="motion-result">
        <span className="badge error">error</span> {report.message}
      </div>
    );
  }
  return (
    <div style={CARD} data-testid="motion-result">
      <h4 style={{ margin: '0 0 8px' }}>Tracking</h4>
      <TrackingSection tracking={report} saved={saved} />
    </div>
  );
}

function TrackingSection({
  tracking,
  saved,
}: {
  tracking: Extract<MotionReport, { kind: 'measured' }>;
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
            · settles <strong>{settleText(s.maxSettleMs)}</strong>
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
                <td>{m.settleMs === null ? '—' : m.settleMs < SAMPLE_MS ? '< 15' : Math.round(m.settleMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <h4 style={{ margin: '16px 0 8px' }}>Acceleration</h4>
      <AccelSection accel={tracking.accel} saved={saved} />

      <h4 style={{ margin: '16px 0 8px' }}>Suggested servo gains</h4>
      <p style={{ margin: 0 }} data-testid="suggested-gains">
        Servo Kp <strong>{tracking.gains.kp}</strong> /s, Servo Ki <strong>{tracking.gains.ki}</strong> /s²{' '}
        <span className="muted">
          (now {saved.servoKp} and {saved.servoKi})
        </span>
      </p>
      <p className="muted" style={{ margin: '4px 0 0' }}>
        {tracking.gains.notes.join(' ')} A starting point: enter them in Machine configuration, Write to device, restart the
        machine, and run this again to compare.
      </p>
    </>
  );
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function AccelSection({ accel, saved }: { accel: AccelVerdict; saved: SavedMachine }) {
  const limit = `Acceleration Max (${saved.maxAccelMmPerS2} mm/s²)`;
  const untested =
    accel.kind === 'pass' && accel.topSpeedMmPerS < saved.maxVelocityMmPerS
      ? ` In the room available the moves only reached ${num(accel.topSpeedMmPerS, 2)} mm/s, so ramps to higher speeds are untested.`
      : '';
  return (
    <>
      <p style={{ margin: 0 }} data-testid="acceleration-verdict">
        {accel.kind === 'pass' && (
          <>
            <span className="badge downloaded">pass</span> The carriage kept up with {limit} at every speed up to{' '}
            {num(accel.topSpeedMmPerS, 2)} mm/s.{untested}
          </>
        )}
        {accel.kind === 'too-high' && (
          <>
            <span className="badge error">too high</span> {limit} is more than this machine delivers: ramping to{' '}
            {num(accel.worst.reachedMmPerS, 2)} mm/s the carriage managed about {pct(accel.worst.delivered)} of it
            (at least {pct(ACCEL_DELIVERED_MIN)} needed). Lower Acceleration Max, or Velocity Max, Write to device,
            restart the machine, and run this again.
          </>
        )}
        {accel.kind === 'not-judged' && (
          <span className="muted">Not judged: the run stopped before every speed of the sweep had been measured.</span>
        )}
      </p>
      {accel.steps.length > 0 && (
        <table style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>Ramp to (mm/s)</th>
              <th>Peak following (µm)</th>
              <th>Acceleration delivered</th>
            </tr>
          </thead>
          <tbody>
            {accel.steps.map((st) => (
              <tr key={st.share}>
                <td>
                  {num(st.reachedMmPerS, 2)}
                  {st.reachedMmPerS < st.speedMmPerS && <span className="muted"> (of {num(st.speedMmPerS, 2)})</span>}
                </td>
                <td>{num(st.peakFollowingErrorUm)}</td>
                <td>{pct(st.delivered)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
