import { useState } from 'react';
import { useStore } from '@/store/useStore';
import { FaultedReason, NotificationType } from '@/domain';
import {
  FAULT_HINTS,
  RESTRICTION_HINTS,
  faultBadgeLabel,
  restrictionBadgeLabel,
} from '@/domain/stateLabels';
import LiveCombinedChart from '@/ui/components/LiveCombinedChart';
import LiveStressStrainChart from '@/ui/components/LiveStressStrainChart';

const READOUT_HINTS: Record<string, string> = {
  'Machine Force': 'Absolute force reading.',
  'Machine Position': 'Jaw separation from encoder feedback (sample position + gauge length).',
  'Machine Setpoint': 'Commanded machine position.',
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

export default function Live() {
  const connected = useStore((s) => s.connection === 'connected');
  const sample = useStore((s) => s.latestSample);
  const state = useStore((s) => s.machineState);
  const setMotionEnabled = useStore((s) => s.setMotionEnabled);
  const manualMove = useStore((s) => s.manualMove);
  const homeAxis = useStore((s) => s.homeAxis);
  const zeroForce = useStore((s) => s.zeroForce);
  const zeroLength = useStore((s) => s.zeroLength);
  const testRunning = useStore((s) => Boolean(s.machineState?.testRunning));
  // No state frame yet (fresh connect, or a reconnect reset it to null) means
  // the machine's condition is UNKNOWN — which must never be collapsed into a
  // safe-sounding default. `Boolean(state?.testRunning)` reads unknown as "no
  // test running" and enabled every manual control while the gantry could be
  // mid-move; the badges likewise rendered unknown as "idle"/"disabled". The
  // Fault and Restriction badges below already render '—' for exactly this
  // case — Motion and Test now follow the same rule, and the controls stay
  // locked until the machine has actually said what it is doing.
  const stateKnown = state !== null;
  const manualBlocked = !stateKnown || testRunning;
  const notify = useStore((s) => s.notify);

  const [jogMm, setJogMm] = useState(1);
  const [jogSpeed, setJogSpeed] = useState(5);

  const jog = async (mm: number) => {
    if (!Number.isFinite(mm) || mm === 0 || !Number.isFinite(jogSpeed) || jogSpeed <= 0) {
      notify(NotificationType.WARN, 'Enter a valid jog distance and a speed greater than 0.');
      return;
    }
    const ok = await manualMove(mm, jogSpeed);
    if (!ok) notify(NotificationType.WARN, 'Jog was rejected by the machine.');
  };

  if (!connected) {
    return (
      <div>
        <h1>Live</h1>
        <div className="panel muted">Connect a device to see live data.</div>
      </div>
    );
  }

  return (
    <div>
      <h1>Live</h1>

      <div className="panel">
        <h2>Readouts</h2>
        <div className="grid cols-3">
          <Readout label="Machine Force" value={sample?.['Machine Force (N)']} unit="N" />
          <Readout label="Machine Position" value={sample?.['Machine Position (mm)']} unit="mm" />
          <Readout label="Machine Setpoint" value={sample?.['Machine Setpoint (mm)']} unit="mm" />
          <Readout label="Sample Force" value={sample?.['Sample Force (N)']} unit="N" />
          <Readout label="Sample Position" value={sample?.['Sample Position (mm)']} unit="mm" />
        </div>
      </div>

      <div className="panel">
        <h2>State</h2>
        <div className="row">
          <span className="badge">
            Motion: {stateKnown ? (state.motionEnabled ? 'enabled' : 'disabled') : '—'}
          </span>
          <span className="badge">Test: {stateKnown ? (state.testRunning ? 'running' : 'idle') : '—'}</span>
          <span
            className={`badge ${state && state.faultedReason !== FaultedReason.NONE ? 'error' : ''}`}
            title={state ? FAULT_HINTS[state.faultedReason] : undefined}
          >
            Fault: {state ? faultBadgeLabel(state.faultedReason) : '—'}
          </span>
          <span
            className="badge"
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
          <button onClick={() => setMotionEnabled(!state?.motionEnabled)} disabled={!stateKnown}>
            {!stateKnown ? 'Motion …' : state.motionEnabled ? 'Disable motion' : 'Enable motion'}
          </button>
          <button onClick={() => homeAxis()} disabled={manualBlocked}>Home (G28)</button>
          <button onClick={() => zeroForce()} disabled={manualBlocked}>Zero force</button>
          <button onClick={() => zeroLength()} disabled={manualBlocked}>Zero length</button>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <label className="field">
            Jog (mm)
            <input
              type="number"
              step="0.1"
              value={jogMm}
              disabled={manualBlocked}
              onChange={(e) => setJogMm(Number(e.target.value))}
            />
          </label>
          <label className="field">
            Speed (mm/s)
            <input
              type="number"
              step="0.1"
              value={jogSpeed}
              disabled={manualBlocked}
              onChange={(e) => setJogSpeed(Number(e.target.value))}
            />
          </label>
          <button onClick={() => void jog(-Math.abs(jogMm))} disabled={manualBlocked}>− Jog down</button>
          <button onClick={() => void jog(Math.abs(jogMm))} disabled={manualBlocked}>+ Jog up</button>
        </div>
        {!stateKnown && (
          <p className="muted" style={{ marginTop: 8 }}>
            Waiting for the machine to report its state — controls unlock when it does.
          </p>
        )}
        {testRunning && (
          <p className="muted" style={{ marginTop: 8 }}>
            Manual controls are disabled while a test is running. Use STOP (top bar) to halt.
          </p>
        )}
      </div>

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
