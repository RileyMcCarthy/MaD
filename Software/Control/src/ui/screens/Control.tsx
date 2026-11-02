import { useState } from 'react';
import { useStore } from '@/store/useStore';
import {
  DEFAULT_JOG_MM,
  FaultedReason,
  JOG_INCREMENTS_MM,
  RestrictedReason,
  NotificationType,
  blocksMotion,
  formatJogIncrementLabel,
  isSelectedJogIncrement,
} from '@/domain';
import {
  FAULT_HINTS,
  RESTRICTION_HINTS,
  faultBadgeLabel,
  restrictionBadgeLabel,
} from '@/domain/stateLabels';
import { motionButton } from '@/domain/motionControl';
import { machineStatus } from '@/domain/machineStatus';
import LiveCombinedChart from '@/ui/components/LiveCombinedChart';
import LiveStressStrainChart from '@/ui/components/LiveStressStrainChart';
import NumberField from '@/ui/components/NumberField';
import TestRunner from '@/ui/components/TestRunner';

const READOUT_HINTS: Record<string, string> = {
  'Machine Force': 'Absolute force reading.',
  'Machine Position': 'Jaw separation from encoder feedback (sample position + gauge length).',
  'Machine Setpoint': 'Where the motion trajectory says the gantry should be right now, acceleration included. Machine Position follows it.',
  'Machine Target': 'Where the current move ends.',
  'Sample Force': 'Force applied to the sample.',
  'Sample Position': 'Extension from gauge-zero: machine position minus length at "zero length".',
};

function Readout({ label, value, unit }: { label: string; value?: number; unit: string }) {
  return (
    <div className="readout" title={READOUT_HINTS[label]}>
      <div className="label">{label}</div>
      <div className="value">
        {value !== undefined && Number.isFinite(value) ? value.toFixed(3) : '—'}
        <span className="muted" style={{ fontSize: 13 }}>
          {' '}
          {unit}
        </span>
      </div>
    </div>
  );
}

/** The run history lives on Test runs; nothing here needs refreshing. */
const noHistory = () => {};

export default function Control() {
  const connected = useStore((s) => s.connection === 'connected');
  const sample = useStore((s) => s.latestSample);
  const state = useStore((s) => s.machineState);
  const setMotionEnabled = useStore((s) => s.setMotionEnabled);
  const manualMove = useStore((s) => s.manualMove);
  const homeAxis = useStore((s) => s.homeAxis);
  const zeroForce = useStore((s) => s.zeroForce);
  const zeroLength = useStore((s) => s.zeroLength);
  // The store explains a jog refused for the firmware itself; the toast below
  // is for a jog the machine turned down.
  const firmwareBlocks = useStore((s) => blocksMotion(s.firmwareCompat));
  // No state frame yet (fresh connect, or a reconnect reset it to null) means
  // the machine's condition is UNKNOWN — which must never be collapsed into a
  // safe-sounding default. `Boolean(state?.testRunning)` reads unknown as "no
  // test running" and enabled every manual control while the gantry could be
  // mid-move; the badges likewise rendered unknown as "idle"/"disabled". The
  // Fault and Restriction badges below already render '—' for exactly this
  // case — Motion and Test now follow the same rule, and the controls stay
  // locked until the machine has actually said what it is doing.
  const stateKnown = state !== null;
  const status = machineStatus(state);
  // Jog and home need motion on (the firmware drops moves while it is off);
  // zeroing does not move the gantry, so it only needs a known, idle machine.
  const moveBlocked = !status.canMove;
  const zeroBlocked = !status.canZero;
  const motion = state ? motionButton(state) : null;
  const faulted = state !== null && state.faultedReason !== FaultedReason.NONE;
  const restricted = state !== null && state.restrictedReason !== RestrictedReason.NONE;
  const motionButtonClass = motion
    ? motion.enable
      ? 'ok'
      : faulted
        ? 'danger'
        : ''
    : '';
  const notify = useStore((s) => s.notify);

  const [jogMm, setJogMm] = useState<number>(DEFAULT_JOG_MM);
  const [jogSpeed, setJogSpeed] = useState(5);

  const jog = async (mm: number) => {
    if (!Number.isFinite(mm) || mm === 0 || !Number.isFinite(jogSpeed) || jogSpeed <= 0) {
      notify(NotificationType.WARN, 'Enter a valid jog distance and a speed greater than 0.');
      return;
    }
    const ok = await manualMove(mm, jogSpeed);
    if (!ok && !firmwareBlocks) notify(NotificationType.WARN, 'Jog was rejected by the machine.');
  };

  if (!connected) {
    return (
      <div>
        <h1>Control</h1>
        <div className="panel muted">Connect a device to see live data.</div>
      </div>
    );
  }

  return (
    <div>
      <h1>Control</h1>

      <div className="panel">
        <h2>Readouts</h2>
        <div className="grid cols-3">
          <Readout label="Machine Force" value={sample?.['Machine Force (N)']} unit="N" />
          <Readout label="Machine Position" value={sample?.['Machine Position (mm)']} unit="mm" />
          <Readout label="Machine Setpoint" value={sample?.['Machine Commanded (mm)']} unit="mm" />
          <Readout label="Machine Target" value={sample?.['Machine Setpoint (mm)']} unit="mm" />
          <Readout label="Sample Force" value={sample?.['Sample Force (N)']} unit="N" />
          <Readout label="Sample Position" value={sample?.['Sample Position (mm)']} unit="mm" />
        </div>
      </div>

      <div className="panel">
        <h2>State</h2>
        <div
          className={`machine-status tone-${status.tone}`}
          role="status"
          data-testid="machine-status"
          data-tone={status.tone}
        >
          <div className="machine-status-title">{status.title}</div>
          <div className="machine-status-detail" data-testid={faulted ? 'live-fault-hint' : undefined}>
            {status.detail}
          </div>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <span className={`badge ${stateKnown ? (state.motionEnabled ? 'tone-ok' : 'tone-warn') : ''}`}>
            Motion: {stateKnown ? (state.motionEnabled ? 'enabled' : 'disabled') : '—'}
          </span>
          <span className={`badge ${stateKnown && state.testRunning ? 'tone-info' : ''}`}>
            Test: {stateKnown ? (state.testRunning ? 'running' : 'idle') : '—'}
          </span>
          <span
            className={`badge ${stateKnown ? (faulted ? 'tone-danger' : 'tone-ok') : ''}`}
            title={state ? FAULT_HINTS[state.faultedReason] : undefined}
          >
            Fault: {state ? faultBadgeLabel(state.faultedReason) : '—'}
          </span>
          <span
            className={`badge ${stateKnown ? (restricted ? 'tone-warn' : 'tone-ok') : ''}`}
            title={state ? RESTRICTION_HINTS[state.restrictedReason] : undefined}
          >
            Restriction: {state ? restrictionBadgeLabel(state.restrictedReason) : '—'}
          </span>
        </div>
      </div>

      <div className="panel">
        <h2>Controls</h2>
        <div className="row">
          {/* Motion enable/disable stays available during a test — disabling is a
              stop. It is NOT available while the state is unknown: enabling
              motion on a machine we have not heard from is a guess, and
              `!state?.motionEnabled` would have sent enable=true on null. */}
          {/* While faulted the machine reports motion off but refuses every
              enable, so the button offers a disable — the only thing that
              clears a latched stall (see domain/motionControl.ts). */}
          <button
            className={motionButtonClass}
            onClick={() => { if (motion) void setMotionEnabled(motion.enable); }}
            disabled={!motion}
            title={state && faulted ? FAULT_HINTS[state.faultedReason] : undefined}
          >
            {motion ? motion.label : 'Motion …'}
          </button>
          {/* A refused Home rejects; the store has already said why in a toast. */}
          <button
            onClick={() => void homeAxis().catch(() => undefined)}
            disabled={moveBlocked}
            title={moveBlocked ? status.moveBlockedReason : 'Homes the axis (G28)'}
          >
            Home
          </button>
          <button onClick={() => zeroForce()} disabled={zeroBlocked}>Zero force</button>
          <button onClick={() => zeroLength()} disabled={zeroBlocked}>Zero length</button>
        </div>
        <div className="row" style={{ marginTop: 12, alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
          <NumberField label="Jog (mm)" value={jogMm} disabled={moveBlocked} onChange={setJogMm} />
          <div
            className="toggle"
            role="group"
            aria-label="Jog increment"
            title="Preset jog distances. 0.1 mm is for gauge length / preload on short samples."
          >
            {JOG_INCREMENTS_MM.map((mm) => (
              <button
                key={mm}
                type="button"
                className={isSelectedJogIncrement(jogMm, mm) ? 'active' : ''}
                aria-pressed={isSelectedJogIncrement(jogMm, mm)}
                disabled={moveBlocked}
                onClick={() => setJogMm(mm)}
              >
                {formatJogIncrementLabel(mm)} mm
              </button>
            ))}
          </div>
          <NumberField
            label="Speed (mm/s)"
            value={jogSpeed}
            disabled={moveBlocked}
            onChange={setJogSpeed}
          />
          <button
            onClick={() => void jog(-Math.abs(jogMm))}
            disabled={moveBlocked}
            title={moveBlocked ? status.moveBlockedReason : undefined}
          >
            − Jog down
          </button>
          <button
            onClick={() => void jog(Math.abs(jogMm))}
            disabled={moveBlocked}
            title={moveBlocked ? status.moveBlockedReason : undefined}
          >
            + Jog up
          </button>
        </div>
      </div>

      <TestRunner onChanged={noHistory} />

      <div className="panel" data-testid="live-combined-chart">
        <h2>Force &amp; Position</h2>
        <LiveCombinedChart active={connected} />
      </div>

      <div className="panel" data-testid="live-stress-strain">
        <h2>Stress–Strain (during test)</h2>
        <LiveStressStrainChart active={connected} />
      </div>
    </div>
  );
}
