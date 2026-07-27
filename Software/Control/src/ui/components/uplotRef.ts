import uPlot from 'uplot';

export interface RefLine {
  value: number;
  label: string;
  color: string;
  /** y-scale key to position against (default 'y'); used for dual-axis charts. */
  scale?: string;
}

/**
 * uPlot plugin that draws dashed reference lines (horizontal for `y`, vertical
 * for `x`) with labels — e.g. Max Force / Max Strain limits.
 */
export function refLinesPlugin(opts: { x?: RefLine[]; y?: RefLine[] }): uPlot.Plugin {
  return {
    hooks: {
      draw: (u: uPlot) => {
        const { ctx } = u;
        const { left, top, width, height } = u.bbox;
        ctx.save();
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1.5;
        ctx.font = '11px sans-serif';
        ctx.textBaseline = 'bottom';

        for (const r of opts.y ?? []) {
          if (!Number.isFinite(r.value)) continue;
          const y = u.valToPos(r.value, r.scale ?? 'y', true);
          if (y < top || y > top + height) continue;
          ctx.strokeStyle = r.color;
          ctx.fillStyle = r.color;
          ctx.beginPath();
          ctx.moveTo(left, y);
          ctx.lineTo(left + width, y);
          ctx.stroke();
          ctx.textAlign = 'right';
          ctx.fillText(r.label, left + width - 4, y - 2);
        }

        for (const r of opts.x ?? []) {
          if (!Number.isFinite(r.value)) continue;
          const x = u.valToPos(r.value, 'x', true);
          if (x < left || x > left + width) continue;
          ctx.strokeStyle = r.color;
          ctx.fillStyle = r.color;
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x, top + height);
          ctx.stroke();
          ctx.save();
          ctx.textAlign = 'left';
          ctx.translate(x + 3, top + 4);
          ctx.textBaseline = 'top';
          ctx.fillText(r.label, 0, 0);
          ctx.restore();
        }
        ctx.restore();
      },
    },
  };
}

/**
 * Build a uPlot `series.value` formatter that renders a fixed number of decimal
 * places (and shows `—` when the cursor is off the data). Constant decimals keep
 * the live legend from jittering as values stream in; pair with the
 * `.u-legend` tabular-nums rule in styles.css so digit widths stay constant too.
 */
export function fixedDecimals(decimals: number): (u: uPlot, v: number | null) => string {
  return (_u, v) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(decimals));
}

/**
 * uPlot scale `range` for a live, accumulating series that grows from 0 — e.g. a
 * stress–strain curve. Unlike `stableRange`, the frame is anchored at 0 and is
 * **monotonic**: it only ever expands, so the plot holds still instead of
 * refitting (and visibly rescaling) on every redraw as points stream in. Seed it
 * with a known maximum (a profile limit) so the axis is stable from the very
 * first point; the top snaps to a round number for readable ticks.
 */
export function growingZeroRange(seedMax?: number): (u: uPlot, min: number, max: number) => [number, number] {
  const niceCeil = (v: number): number => {
    if (!(v > 0)) return 1;
    const mag = 10 ** Math.floor(Math.log10(v));
    const n = v / mag; // 1..10
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * mag;
  };
  let top = Number.isFinite(seedMax) && (seedMax as number) > 0 ? niceCeil(seedMax as number) : 0;
  return (_u, _min, max) => {
    const want = Math.max(Number.isFinite(max) ? max : 0, top, 1e-9);
    top = Math.max(top, niceCeil(want));
    return [0, top];
  };
}

/** Build a uPlot scale `range` fn that keeps the given ref values in view. */
export function rangeIncluding(refs: RefLine[]): (u: uPlot, min: number, max: number) => [number, number] {
  const vals = refs.map((r) => r.value).filter((v) => Number.isFinite(v));
  return (_u, min, max) => {
    let lo = min;
    let hi = max;
    for (const v of vals) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    if (lo === hi) hi = lo + 1;
    const pad = (hi - lo) * 0.05;
    return [lo - pad, hi + pad];
  };
}

/**
 * Like `rangeIncluding`, but snaps the bounds to a "nice" step so the axis
 * labels hold still while live data streams in. A raw padded range moves every
 * frame (pad = 5% of an ever-changing span), which makes the tick labels
 * unreadable; snapped bounds only change when the data actually crosses a step.
 */
export function stableRange(refs: RefLine[] = []): (u: uPlot, min: number, max: number) => [number, number] {
  const vals = refs.map((r) => r.value).filter((v) => Number.isFinite(v));
  return (_u, min, max) => {
    let lo = Number.isFinite(min) ? min : 0;
    let hi = Number.isFinite(max) ? max : 1;
    for (const v of vals) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    if (hi - lo < 1e-9) hi = lo + 1;
    const step = 10 ** Math.floor(Math.log10((hi - lo) / 2));
    return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
  };
}
