import { useState } from 'react';
import { useStore } from '@/store/useStore';
import { FaultedReason, RestrictedReason, NotificationType } from '@/domain';
import LiveCombinedChart from '@/ui/components/LiveCombinedChart';
import LiveStressStrainChart from '@/ui/components/LiveStressStrainChart';

const FAULT_HINTS: Record<number, string> = {
  [FaultedReason.NONE]: 'No faults detected.',
  [FaultedReason.COG]: 'Cogging detected in the machine.',
  [FaultedReason.WATCHDOG]: 'Watchdog timer triggered.',
  [FaultedReason.ESD_POWER]: 'ESD power fault detected.',
  [FaultedReason.ESD_SWITCH]: 'ESD switch fault detected.',
  [FaultedReason.ESD_UPPER]: 'Upper ESD fault detected.',
  [FaultedReason.ESD_LOWER]: 'Lower ESD fault detected.',
  [FaultedReason.SERVO_COMMUNICATION]: 'Servo communication fault detected.',
  [FaultedReason.FORCE_GAUGE_COMMUNICATION]: 'Force gauge communication fault detected.',
  [FaultedReason.USER_REQUEST]: 'User requested to disable the machine.',
};

const RESTRICTION_HINTS: Record<number, string> = {
  [RestrictedReason.NONE]: 'No restrictions detected.',
  [RestrictedReason.SAMPLE_LENGTH]: 'Sample length restriction.',
  [RestrictedReason.SAMPLE_TENSION]: 'Sample tension restriction.',
  [RestrictedReason.MACHINE_TENSION]: 'Machine tension restriction.',
  [RestrictedReason.UPPER_ENDSTOP]: 'Upper endstop restriction.',
  [RestrictedReason.LOWER_ENDSTOP]: 'Lower endstop restriction.',
  [RestrictedReason.DOOR]: 'Door restriction.',
};

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
            Motion: {state?.motionEnabled ? 'enabled' : 'disabled'}
          </span>
          <span className="badge">Test: {state?.testRunning ? 'running' : 'idle'}</span>
          <span
            className={`badge ${state && state.faultedReason !== FaultedReason.NONE ? 'error' : ''}`}
            title={state ? FAULT_HINTS[state.faultedReason] : undefined}
          >
            Fault: {state ? FaultedReason[state.faultedReason] : '—'}
          </span>
          <span
            className="badge"
            title={state ? RESTRICTION_HINTS[state.restrictedReason] : undefined}
          >
            Restriction: {state ? RestrictedReason[state.restrictedReason] : '—'}
          </span>
        </div>
      </div>

      <div className="panel">
        <h2>Controls</h2>
        <div className="row">
          {/* Motion enable/disable stays available during a test — disabling is a stop. */}
          <button onClick={() => setMotionEnabled(!state?.motionEnabled)}>
            {state?.motionEnabled ? 'Disable motion' : 'Enable motion'}
          </button>
          <button onClick={() => homeAxis()} disabled={testRunning}>Home (G28)</button>
          <button onClick={() => zeroForce()} disabled={testRunning}>Zero force</button>
          <button onClick={() => zeroLength()} disabled={testRunning}>Zero length</button>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <label className="field">
            Jog (mm)
            <input
              type="number"
              step="0.1"
              value={jogMm}
              disabled={testRunning}
              onChange={(e) => setJogMm(Number(e.target.value))}
            />
          </label>
          <label className="field">
            Speed (mm/s)
            <input
              type="number"
              step="0.1"
              value={jogSpeed}
              disabled={testRunning}
              onChange={(e) => setJogSpeed(Number(e.target.value))}
            />
          </label>
          <button onClick={() => void jog(-Math.abs(jogMm))} disabled={testRunning}>− Jog down</button>
          <button onClick={() => void jog(Math.abs(jogMm))} disabled={testRunning}>+ Jog up</button>
        </div>
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
