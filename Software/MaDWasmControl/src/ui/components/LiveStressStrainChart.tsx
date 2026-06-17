import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useStore } from '@/store/useStore';
import { deviceClient } from '@/device/session';
import { fixedDecimals, growingZeroRange, refLinesPlugin, RefLine } from './uplotRef';

const MAX_POINTS = 1000;

/**
 * Live stress–strain scatter. Accumulates points only while a test is running
 * (clears at test start), driven from device sample events via rAF redraw.
 * stress = |sample force| / (width·thickness); strain = ΔL / gauge · 100.
 */
export default function LiveStressStrainChart({ active }: { active: boolean }) {
  const sampleProfile = useStore((s) => s.sampleProfile);
  const testRunning = useStore((s) => Boolean(s.machineState?.testRunning));

  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const ptsRef = useRef<{ x: number[]; y: number[] }>({ x: [], y: [] });
  /** Bumped on every accumulation change so the rAF loop only redraws on new data. */
  const ptsVersionRef = useRef(0);
  const runningRef = useRef(false);
  const profileRef = useRef(sampleProfile);
  const initialPosRef = useRef<number | null>(null);
  const gaugeRef = useRef<number | null>(null);
  const [gauge, setGauge] = useState<number | null>(null);

  profileRef.current = sampleProfile;

  const area = sampleProfile ? sampleProfile.sampleWidth * sampleProfile.sampleThickness : 0;
  const maxStress = sampleProfile && area > 0 ? sampleProfile.maxForce / area : undefined;
  const maxStrain =
    sampleProfile && gauge && gauge > 0 ? (sampleProfile.maxDisplacement / gauge) * 100 : undefined;

  // Clear accumulation when a test starts.
  useEffect(() => {
    runningRef.current = testRunning;
    if (testRunning) {
      ptsRef.current = { x: [], y: [] };
      ptsVersionRef.current += 1;
      initialPosRef.current = null;
      gaugeRef.current = null;
      setGauge(null);
    }
  }, [testRunning]);

  // Accumulate points from device sample events. Subscribe ONCE (gauge is read
  // from a ref, so a stale closure can't skew the first sample's strain and we
  // don't churn the subscription each time the gauge updates).
  useEffect(() => {
    const unsub = deviceClient.subscribe((events) => {
      if (!runningRef.current) return;
      const sp = profileRef.current;
      if (!sp) return;
      const a = sp.sampleWidth * sp.sampleThickness;
      if (a <= 0) return;
      for (const e of events) {
        if (e.kind !== 'sample') continue;
        const machine = e.data['Machine Position (mm)'];
        const pos = e.data['Sample Position (mm)'];
        const force = e.data['Sample Force (N)'];
        if (initialPosRef.current === null) {
          initialPosRef.current = pos;
          const g = machine - pos;
          if (Number.isFinite(g) && g > 0) {
            gaugeRef.current = g;
            setGauge(g); // for the Max Strain reference-line label only
          }
        }
        const g = gaugeRef.current && gaugeRef.current > 0 ? gaugeRef.current : 1;
        const strain = (Math.abs(pos - (initialPosRef.current ?? pos)) / g) * 100;
        const stress = Math.abs(force) / a;
        if (!Number.isFinite(strain) || !Number.isFinite(stress)) continue;
        ptsRef.current.x.push(strain);
        ptsRef.current.y.push(stress);
        if (ptsRef.current.x.length > MAX_POINTS) {
          ptsRef.current.x.shift();
          ptsRef.current.y.shift();
        }
        ptsVersionRef.current += 1;
      }
    });
    return unsub;
  }, []);

  // (Re)build the plot when limits change.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const refs: RefLine[] = [];
    if (maxStress !== undefined) refs.push({ value: maxStress, label: 'Max Stress', color: '#ff5d5d' });
    const xRefs: RefLine[] = [];
    if (maxStrain !== undefined) xRefs.push({ value: maxStrain, label: 'Max Strain', color: '#ffb454' });

    const opts: uPlot.Options = {
      width: container.clientWidth || 700,
      height: 300,
      // Zero-anchored, monotonic ranges: the frame holds still (seeded from the
      // profile limits) and only grows, instead of refitting on every redraw.
      scales: { x: { time: false, range: growingZeroRange(maxStrain) }, y: { range: growingZeroRange(maxStress) } },
      axes: [
        { stroke: '#8b93a3', label: 'Strain (%)', grid: { stroke: '#2a2f3a' }, ticks: { stroke: '#2a2f3a' } },
        { stroke: '#8b93a3', label: 'Stress (MPa)', grid: { stroke: '#2a2f3a' }, ticks: { stroke: '#2a2f3a' } },
      ],
      series: [
        { value: fixedDecimals(3) },
        { label: 'Stress', stroke: '#4ea1ff', fill: '#4ea1ff', paths: () => null, points: { show: true, size: 4 }, value: fixedDecimals(3) },
      ],
      plugins: refs.length || xRefs.length ? [refLinesPlugin({ y: refs, x: xRefs })] : [],
    };
    const plot = new uPlot(opts, [new Float64Array(0), new Float64Array(0)], container);
    plotRef.current = plot;
    const resize = new ResizeObserver(() => plot.setSize({ width: container.clientWidth || 700, height: 300 }));
    resize.observe(container);
    return () => {
      resize.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [maxStress, maxStrain]);

  // rAF redraw from the accumulation buffer — only when the points changed
  // (otherwise an idle screen redraws the canvas 60×/s for nothing).
  useEffect(() => {
    if (!active) return undefined;
    let raf = 0;
    let lastVersion = -1;
    const tick = () => {
      const plot = plotRef.current;
      if (plot && ptsVersionRef.current !== lastVersion) {
        lastVersion = ptsVersionRef.current;
        plot.setData([ptsRef.current.x, ptsRef.current.y]);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <div>
      {area <= 0 && (
        <p className="muted">Set sample width × thickness (Profiles) for stress–strain.</p>
      )}
      <div ref={containerRef} style={{ width: '100%' }} />
    </div>
  );
}
