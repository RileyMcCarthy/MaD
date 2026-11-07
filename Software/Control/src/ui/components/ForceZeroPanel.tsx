import { useState } from 'react';
import { useStore } from '@/store/useStore';
import { liveClockSeconds, liveSamplesSince } from '@/store/liveBuffer';
import { ZERO_READ_MS, measureZero, planZero, type SavedLoadCell, type ZeroResult } from '@/domain/forceZero';

function num(v: number, digits: number): string {
  return Number(v.toFixed(digits)).toString();
}

/** Newtons to the precision the firmware reports (1 mN), in mN below 1 N. */
function forceText(n: number): string {
  return Math.abs(n) < 1 ? `${num(n * 1000, 1)} mN` : `${num(n, 3)} N`;
}

/**
 * Load cell zero and noise, against the load cell values saved on the machine.
 * Offers the zero to the profile being edited; nothing is written until the
 * operator writes the profile.
 */
export default function ForceZeroPanel({
  saved,
  onUseZero,
}: {
  saved: SavedLoadCell;
  /** Put a zero balance (mV/V) into the profile being edited. */
  onUseZero: (zeroBalanceMvV: number) => void;
}) {
  const connected = useStore((s) => s.connection === 'connected');
  const [reading, setReading] = useState(false);
  const [result, setResult] = useState<ZeroResult | null>(null);
  const [used, setUsed] = useState(false);

  const plan = planZero(saved);

  const onRead = async () => {
    // Frozen: a profile written while it reads must not relabel the result.
    const savedAtStart = { ...saved };
    setResult(null);
    setUsed(false);
    if (useStore.getState().machineState?.testRunning) {
      setResult({ ok: false, reason: 'Not read: a test is running.' });
      return;
    }
    setReading(true);
    const t0 = liveClockSeconds();
    await new Promise<void>((resolve) => setTimeout(resolve, ZERO_READ_MS));
    const forces = liveSamplesSince(t0).map((s) => s.machineForce);
    setResult(measureZero(forces, savedAtStart));
    setReading(false);
  };

  const m = result?.ok ? result.measurement : null;
  const pctOfCapacity = (n: number) => num((Math.abs(n) / saved.capacityN) * 100, 4);

  return (
    <div>
      <h3>Zero and noise</h3>
      <p className="muted">
        Reads the load cell for {ZERO_READ_MS / 1000} s with nothing on it: the bridge signal it reads is the
        zero balance, and how much it wanders is the smallest force the machine can tell apart. It works from
        the load cell values the machine started with: after writing new ones, restart the machine before
        reading.
      </p>
      <p style={{ margin: '0 0 12px' }}>
        <span className="badge running">before reading</span> Take any sample out of the grips and let the load
        cell hang free.
      </p>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <button className="primary" onClick={onRead} disabled={reading || !plan.ok || !connected}>
          {reading ? 'Reading…' : 'Read zero'}
        </button>
      </div>
      {!plan.ok && <p className="muted">{plan.reason}</p>}

      {result && !result.ok && (
        <div style={{ marginTop: 14, padding: 14, background: 'var(--panel-2)', borderRadius: 8 }} data-testid="zero-result">
          <span className="badge error">not read</span> {result.reason}
        </div>
      )}
      {m && (
        <div style={{ marginTop: 14, padding: 14, background: 'var(--panel-2)', borderRadius: 8 }} data-testid="zero-result">
          <p style={{ margin: 0 }}>
            {m.drifting ? (
              <span className="badge running">still settling</span>
            ) : (
              <span className="badge downloaded">steady</span>
            )}{' '}
            Zero balance <strong data-testid="zero-balance">{num(m.zeroBalanceMvV, 6)} mV/V</strong>{' '}
            <span className="muted">
              (saved {num(saved.zeroBalanceMvV, 6)}; unloaded it read {forceText(m.offsetN)})
            </span>
          </p>
          {m.drifting && (
            <p style={{ margin: '8px 0 0' }}>
              The reading moved {forceText(m.driftN)} while it was read, more than its noise explains. Wait for the
              load cell to settle (a cold one can take minutes) and read again.
            </p>
          )}
          <p style={{ margin: '8px 0 0' }} data-testid="zero-noise">
            Noise <strong>±{forceText(m.noiseN)}</strong>{' '}
            <span className="muted">
              (one standard deviation; {num(m.noiseNvV, 0)} nV/V, {pctOfCapacity(m.noiseN)}% of capacity) · spread{' '}
              {forceText(m.peakToPeakN)} over {m.samples} readings
            </span>
          </p>
          <div className="row" style={{ marginTop: 10, alignItems: 'center' }}>
            <button onClick={() => { onUseZero(m.zeroBalanceMvV); setUsed(true); }} disabled={used}>
              Use this zero
            </button>
            {used && (
              <span className="muted">
                Entered in Machine configuration. Write to device and restart the machine for it to take effect.
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
