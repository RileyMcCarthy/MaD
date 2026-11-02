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

/**
 * A range that keeps the given ref values in view, snapping the bounds to a "nice" step so the axis
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

/**
 * uPlot plugin that shows the values under the cursor in a small box next to
 * it, alongside a solid vertical line (styled in styles.css). The legend under
 * the chart carries the same numbers, but reading them there means looking
 * away from the trace. Each series row uses that series' own `value`
 * formatter, so the box and the legend always agree.
 */
export function cursorTooltipPlugin(opts: { xLabel: string; xDecimals?: number }): uPlot.Plugin {
  let tip: HTMLDivElement | null = null;
  const xFmt = fixedDecimals(opts.xDecimals ?? 2);
  return {
    hooks: {
      init: (u: uPlot) => {
        tip = document.createElement('div');
        tip.className = 'u-tooltip';
        tip.style.display = 'none';
        u.over.appendChild(tip);
      },
      setCursor: (u: uPlot) => {
        if (!tip) return;
        const { left, top, idx } = u.cursor;
        if (idx == null || left == null || left < 0 || top == null || top < 0) {
          tip.style.display = 'none';
          return;
        }
        const rows: HTMLDivElement[] = [];
        const row = (label: string, value: string, color?: string) => {
          const r = document.createElement('div');
          r.className = 'u-tooltip-row';
          const name = document.createElement('span');
          name.className = 'u-tooltip-label';
          if (color) name.style.color = color;
          name.textContent = label;
          const val = document.createElement('span');
          val.className = 'u-tooltip-value';
          val.textContent = value;
          r.append(name, val);
          rows.push(r);
        };
        row(opts.xLabel, xFmt(u, u.data[0][idx] ?? null));
        u.series.forEach((s, i) => {
          if (i === 0 || s.show === false) return;
          const v = u.data[i]?.[idx] ?? null;
          const text =
            typeof s.value === 'function'
              ? String(s.value(u, v as number, i, idx))
              : v == null || !Number.isFinite(v)
                ? '—'
                : v.toFixed(3);
          // uPlot normalises `stroke` to a function once the chart is built.
          const stroke = typeof s.stroke === 'function' ? s.stroke(u, i) : s.stroke;
          const color = typeof stroke === 'string' ? stroke : undefined;
          row(typeof s.label === 'string' ? s.label : `Series ${i}`, text, color);
        });
        tip.replaceChildren(...rows);
        tip.style.display = 'block';
        // Sit right of the cursor; flip to the left near the right edge.
        const overW = u.over.clientWidth;
        const tipW = tip.offsetWidth;
        const x = left + 14 + tipW > overW ? left - 14 - tipW : left + 14;
        tip.style.transform = `translate(${Math.max(0, x)}px, ${Math.max(0, Math.min(top, u.over.clientHeight - tip.offsetHeight))}px)`;
      },
    },
  };
}

/**
 * uPlot scale `range` that fits the data in view with a little padding, so the
 * trace fills the chart's height. uPlot hands it the min/max of the points
 * inside the visible x window, so zooming in on a section also stretches that
 * section vertically. Limit lines outside the data are not pulled into view.
 */
export function fitDataRange(padFraction = 0.05): (u: uPlot, min: number, max: number) => [number, number] {
  return (_u, min, max) => {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
    const span = max - min || Math.abs(max) * 0.1 || 1;
    const pad = span * padFraction;
    return [min - pad, max + pad];
  };
}

/**
 * Hook for a chart that zooms on x by dragging: reports whether the x scale
 * is narrower than the full data, so the chart can offer a reset button.
 */
export function zoomStatePlugin(fullX: [number, number], onZoomed: (zoomed: boolean) => void): uPlot.Plugin {
  return {
    hooks: {
      setScale: (u: uPlot, key: string) => {
        if (key !== 'x') return;
        const { min, max } = u.scales.x;
        if (min == null || max == null) return;
        const span = fullX[1] - fullX[0] || 1;
        onZoomed(min > fullX[0] + span * 1e-6 || max < fullX[1] - span * 1e-6);
      },
    },
  };
}
