import { useEffect, useState } from 'react';
import { useStore } from '@/store/useStore';
import NumberField from '@/ui/components/NumberField';
import { planZero, summarizeReadings, type ForceReading, type SavedLoadCell } from '@/domain/forceZero';
import { LIGHT_LOAD_SHARE, STANDARD_GRAVITY, fitSensitivity, type WeightPoint } from '@/domain/forceSensitivity';
import { forceText, num, readMachineForces } from '@/ui/components/loadCellReading';

interface ReadPoint extends WeightPoint {
  /** The weight was still swinging while it was read. */
  drifting: boolean;
}

/**
 * Load cell sensitivity from known weights, against the load cell values saved
 * on the machine. Offers the sensitivity to the profile being edited; nothing
 * is written until the operator writes the profile.
 */
export default function LoadCellSensitivityPanel({
  saved,
  onUseSensitivity,
}: {
  saved: SavedLoadCell;
  /** Put a sensitivity (mV/V) into the profile being edited. */
  onUseSensitivity: (sensitivityMvV: number) => void;
}) {
  const connected = useStore((s) => s.connection === 'connected');
  const [busy, setBusy] = useState<'unloaded' | 'weight' | null>(null);
  const [firstUnloaded, setFirstUnloaded] = useState<ForceReading | null>(null);
  const [unloaded, setUnloaded] = useState<ForceReading | null>(null);
  const [points, setPoints] = useState<ReadPoint[]>([]);
  const [massKg, setMassKg] = useState(0);
  const [gravity, setGravity] = useState(STANDARD_GRAVITY);
  const [error, setError] = useState<string | null>(null);
  const [used, setUsed] = useState(false);

  // Readings are only comparable on the load cell values they were taken with.
  useEffect(() => {
    setFirstUnloaded(null);
    setUnloaded(null);
    setPoints([]);
    setUsed(false);
  }, [saved.capacityN, saved.sensitivityMvV, saved.zeroBalanceMvV]);

  const plan = planZero(saved);
  const ready = plan.ok && connected && busy === null;

  const read = async (kind: 'unloaded' | 'weight') => {
    setError(null);
    setBusy(kind);
    try {
      const read = await readMachineForces();
      const r = read.ok ? summarizeReadings(read.forcesN) : read;
      if (!r.ok) {
        setError(r.reason);
        return;
      }
      if (kind === 'unloaded') {
        setUnloaded(r.reading);
        setFirstUnloaded((f) => f ?? r.reading);
      } else if (unloaded) {
        setPoints((ps) => [
          ...ps,
          { massKg, unloadedN: unloaded.meanN, loadedN: r.reading.meanN, drifting: r.reading.drifting },
        ]);
        setUsed(false);
      }
    } finally {
      setBusy(null);
    }
  };

  const fit = points.length > 0 ? fitSensitivity(points, saved, gravity) : null;
  const zeroShiftN =
    firstUnloaded && unloaded && unloaded !== firstUnloaded ? unloaded.meanN - firstUnloaded.meanN : null;

  return (
    <div style={{ marginTop: 24 }}>
      <h3>Sensitivity from known weights</h3>
      <p className="muted">
        Hang known masses from the load cell and compare what it reads with mass × gravity. Each weight is
        measured as the change from the unloaded reading, so the zero balance does not need to be right first.
        Use the heaviest weights you have, ideally up to at least {LIGHT_LOAD_SHARE * 100}% of capacity, and
        count the hanger in the mass. It works from the load cell values the machine started with: after
        writing new ones, restart the machine before reading.
      </p>
      <p style={{ margin: '0 0 12px' }}>
        <span className="badge running">before reading</span> The load cell must hang vertically, with the
        weight pulling it the way a sample would.
      </p>
      {!plan.ok && <p className="muted">{plan.reason}</p>}

      <div className="row" style={{ alignItems: 'flex-end' }}>
        <button onClick={() => read('unloaded')} disabled={!ready}>
          {busy === 'unloaded' ? 'Reading…' : unloaded ? 'Read unloaded again' : '1. Read unloaded'}
        </button>
        <NumberField label="Mass (kg)" value={massKg} min={0} onChange={setMassKg} />
        <button className="primary" onClick={() => read('weight')} disabled={!ready || !unloaded || !(massKg > 0)}>
          {busy === 'weight' ? 'Reading…' : '2. Read with weight'}
        </button>
        <NumberField label="Gravity (m/s²)" value={gravity} min={0} onChange={setGravity} />
      </div>
      {unloaded && (
        <p className="muted" style={{ margin: '8px 0 0' }} data-testid="sensitivity-unloaded">
          Unloaded {forceText(unloaded.meanN)} ±{forceText(unloaded.noiseN)}
          {unloaded.drifting && ' (still settling)'}
          {zeroShiftN !== null && ` · ${forceText(zeroShiftN)} from the first unloaded reading`}
        </p>
      )}
      {error && (
        <p style={{ margin: '8px 0 0' }}>
          <span className="badge error">not read</span> {error}
        </p>
      )}

      {points.length > 0 && (
        <div style={{ marginTop: 14, padding: 14, background: 'var(--panel-2)', borderRadius: 8 }} data-testid="sensitivity-result">
          <table>
            <thead>
              <tr>
                <th>Mass (kg)</th>
                <th>Known (N)</th>
                <th>Read (N)</th>
                <th>Error</th>
                <th>Off the line</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => {
                const f = fit?.ok ? fit.fit.points[i] : null;
                return (
                  <tr key={i}>
                    <td>
                      {p.massKg}
                      {p.drifting && <span className="badge running" style={{ marginLeft: 6 }}>swinging</span>}
                    </td>
                    <td>{num(p.massKg * gravity, 3)}</td>
                    <td>{num(p.loadedN - p.unloadedN, 3)}</td>
                    <td>{f ? `${num(f.errorPct, 2)}%` : '—'}</td>
                    <td>{f && points.length > 1 ? forceText(f.residualN) : '—'}</td>
                    <td>
                      <button onClick={() => setPoints((ps) => ps.filter((_, j) => j !== i))}>Remove</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {fit && !fit.ok && (
            <p style={{ margin: '8px 0 0' }}>
              <span className="badge error">no fit</span> {fit.reason}
            </p>
          )}
          {fit?.ok && (
            <>
              <p style={{ margin: '12px 0 0' }}>
                Sensitivity <strong data-testid="fitted-sensitivity">{num(fit.fit.sensitivityMvV, 6)} mV/V</strong>{' '}
                <span className="muted">
                  (saved {num(saved.sensitivityMvV, 6)}; the machine reads{' '}
                  {num(Math.abs((Math.abs(fit.fit.scale) - 1) * 100), 2)}% {Math.abs(fit.fit.scale) > 1 ? 'high' : 'low'})
                </span>
              </p>
              {fit.fit.linearityPct !== null && (
                <p style={{ margin: '4px 0 0' }}>
                  Linearity <strong>{num(fit.fit.linearityPct, 3)}%</strong>{' '}
                  <span className="muted">of the heaviest weight: the furthest any weight sits from the fitted line</span>
                </p>
              )}
              {fit.fit.polarityReversed && (
                <p style={{ margin: '8px 0 0' }}>
                  <span className="badge running">polarity</span> The weights read as pushing. If they hang the way a
                  sample pulls, the load cell is wired the other way round, and the new sensitivity flips its sign
                  to match.
                </p>
              )}
              {fit.fit.lightLoad && (
                <p style={{ margin: '8px 0 0' }}>
                  <span className="badge running">light</span> The heaviest weight is under{' '}
                  {LIGHT_LOAD_SHARE * 100}% of the {saved.capacityN} N capacity, so the line is stretched a long way
                  to full scale. Add a heavier weight if you can.
                </p>
              )}
              {points.some((p) => p.drifting) && (
                <p style={{ margin: '8px 0 0' }}>
                  <span className="badge running">swinging</span> A weight was still moving while it was read.
                  Remove it, let it settle, and read it again.
                </p>
              )}
              <div className="row" style={{ marginTop: 10, alignItems: 'center' }}>
                <button
                  onClick={() => {
                    onUseSensitivity(fit.fit.sensitivityMvV);
                    setUsed(true);
                  }}
                  disabled={used}
                >
                  Use this sensitivity
                </button>
                {used && (
                  <span className="muted">
                    Entered in Machine configuration. Write to device and restart the machine for it to take effect.
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
