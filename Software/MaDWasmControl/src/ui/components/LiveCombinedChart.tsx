import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useStore } from '@/store/useStore';
import { getLiveSeries } from '@/store/liveBuffer';
import { RefLine, refLinesPlugin, stableRange } from './uplotRef';

type Coord = 'machine' | 'sample';

const SWEEP_S = 60;

function asPositive(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
function minPositive(values: unknown[]): number | undefined {
  const xs = values.map(asPositive).filter((v): v is number => v !== undefined);
  return xs.length ? Math.min(...xs) : undefined;
}

/**
 * Combined live chart: position (left axis) and force (right axis) on one plot,
 * with a 60 s rolling window, a machine/sample coordinate toggle, and Max
 * Force / Max Position reference lines from the machine config + sample profile.
 * Driven imperatively from the out-of-React `liveBuffer`.
 */
export default function LiveCombinedChart({ active }: { active: boolean }) {
  const [coord, setCoord] = useState<Coord>('machine');
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const config = useStore((s) => s.config);
  const sampleProfile = useStore((s) => s.sampleProfile);
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  const tensileMax = config?.['Tensile Force Max (N)'];
  const positionMax = config?.['Position Max (mm)'];
  const limitForce =
    coord === 'machine' ? asPositive(tensileMax) : minPositive([sampleProfile?.maxForce, tensileMax]);
  const limitPosition =
    coord === 'machine' ? asPositive(positionMax) : minPositive([sampleProfile?.maxDisplacement, positionMax]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const forceRefs: RefLine[] =
      limitForce !== undefined ? [{ value: 0, label: '', color: '' }, { value: limitForce, label: '', color: '' }] : [];
    const posRefs: RefLine[] =
      limitPosition !== undefined ? [{ value: 0, label: '', color: '' }, { value: limitPosition, label: '', color: '' }] : [];

    const refLines: RefLine[] = [];
    if (limitForce !== undefined)
      refLines.push({ value: limitForce, label: 'Max Force', color: '#ff5d5d', scale: 'force' });
    if (limitPosition !== undefined)
      refLines.push({ value: limitPosition, label: 'Max Position', color: '#ffb454', scale: 'pos' });

    const posLabel = coord === 'machine' ? 'Machine Position (mm)' : 'Sample Position (mm)';
    const forceLabel = coord === 'machine' ? 'Machine Force (N)' : 'Sample Force (N)';

    const series: uPlot.Series[] =
      coord === 'machine'
        ? [
            { label: 't' },
            { label: 'Position', scale: 'pos', stroke: '#4ea1ff', width: 1.5, points: { show: false } },
            { label: 'Setpoint', scale: 'pos', stroke: '#ffb454', width: 1, points: { show: false } },
            { label: 'Force', scale: 'force', stroke: '#2bd4a7', width: 1.5, points: { show: false } },
          ]
        : [
            { label: 't' },
            { label: 'Position', scale: 'pos', stroke: '#4ea1ff', width: 1.5, points: { show: false } },
            { label: 'Force', scale: 'force', stroke: '#2bd4a7', width: 1.5, points: { show: false } },
          ];

    const opts: uPlot.Options = {
      width: container.clientWidth || 700,
      height: 300,
      scales: {
        x: { time: false },
        // Snapped ranges keep the axis tick labels still while data streams.
        pos: { range: stableRange(posRefs) },
        force: { range: stableRange(forceRefs) },
      },
      axes: [
        {
          scale: 'x',
          stroke: '#8b93a3',
          label: 'Time (s)',
          grid: { stroke: '#2a2f3a' },
          ticks: { stroke: '#2a2f3a' },
          // Whole-second labels: a fixed width keeps the right-hand axis/readouts
          // from reflowing as the window scrolls.
          values: (_u, splits) => splits.map((v) => Math.round(v).toString()),
        },
        { scale: 'pos', side: 3, stroke: '#8b93a3', label: posLabel, grid: { stroke: '#2a2f3a' }, ticks: { stroke: '#2a2f3a' } },
        { scale: 'force', side: 1, stroke: '#8b93a3', label: forceLabel, grid: { show: false }, ticks: { stroke: '#2a2f3a' } },
      ],
      series,
      plugins: refLines.length ? [refLinesPlugin({ y: refLines })] : [],
    };

    const empty = new Float64Array(0);
    const initial: uPlot.AlignedData = [empty, ...series.slice(1).map(() => empty)];
    const plot = new uPlot(opts, initial, container);
    plotRef.current = plot;

    const resize = new ResizeObserver(() => plot.setSize({ width: container.clientWidth || 700, height: 300 }));
    resize.observe(container);
    return () => {
      resize.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [coord, limitForce, limitPosition]);

  useEffect(() => {
    if (!active) return undefined;
    let raf = 0;
    // Only redraw when the data actually advanced since the last frame — an idle
    // Live screen otherwise does continuous 60 fps canvas work for no new data.
    let lastLen = -1;
    let lastT = Number.NaN;
    const tick = () => {
      const plot = plotRef.current;
      // While paused the buffer keeps filling but the plot stays frozen, so the
      // cursor/legend can be read; Resume snaps back to the live edge.
      if (plot && !pausedRef.current) {
        const s = getLiveSeries();
        const tEnd = s.length > 0 ? s.t[s.length - 1] : Number.NaN;
        if (s.length !== lastLen || tEnd !== lastT) {
          lastLen = s.length;
          lastT = tEnd;
          const data: uPlot.AlignedData =
            coord === 'machine'
              ? [s.t, s.machinePosition, s.machineSetpoint, s.machineForce]
              : [s.t, s.samplePosition, s.sampleForce];
          plot.setData(data);
          if (s.length > 0) {
            // Fit the window to the data actually present (rolling at SWEEP_S) so
            // the trace fills the plot from the first sample — rather than pinning
            // 0..60 and leaving the seeded/early data as a sliver.
            const tMax = s.t[s.length - 1];
            const tMin = s.t[0];
            const min = Math.max(tMin, tMax - SWEEP_S);
            const max = tMax > min ? tMax : min + 1;
            plot.setScale('x', { min, max });
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, coord]);

  return (
    <div>
      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 8 }}>
        <button
          onClick={() => setPaused((p) => !p)}
          title="Freeze the chart to inspect values (data keeps recording; Resume jumps back to live)."
          data-testid="chart-pause"
        >
          {paused ? '▶ Resume' : '⏸ Pause'}
        </button>
        <div className="toggle">
          <button className={coord === 'machine' ? 'active' : ''} onClick={() => setCoord('machine')}>
            Machine
          </button>
          <button className={coord === 'sample' ? 'active' : ''} onClick={() => setCoord('sample')}>
            Sample
          </button>
        </div>
      </div>
      <div ref={containerRef} style={{ width: '100%' }} />
    </div>
  );
}
