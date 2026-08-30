/**
 * Sparklines, hand-rolled.
 *
 * WHY not a library: the whole job is ~15 lines of arithmetic plus a
 * `<polyline>`, and every candidate package either ships a DOM/canvas runtime
 * or renders to a terminal. A self-contained HTML report cannot afford a UI
 * bundle to display two lines, and the byte budget is the report's scarcest
 * resource.
 *
 * WHY min/max bucket downsampling and not stride sampling: stride sampling
 * DELETES SPIKES. A one-sample overshoot is exactly the behaviour change a
 * reviewer is looking for, and every other Nth sample is precisely the way to
 * make it invisible. Min/max keeps both extremes of every bucket, so a spike
 * survives at any zoom level, at the cost of two points per bucket.
 */

export interface Bucketed {
  /** 2 points per bucket: the bucket minimum then its maximum. */
  readonly points: readonly number[];
  readonly min: number;
  readonly max: number;
}

export function bucketMinMax(values: readonly number[], buckets: number): Bucketed {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { points: [], min: 0, max: 0 };
  const n = Math.max(1, Math.min(buckets, finite.length));
  const size = finite.length / n;
  const points: number[] = [];
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let b = 0; b < n; b += 1) {
    const start = Math.floor(b * size);
    const end = Math.max(start + 1, Math.floor((b + 1) * size));
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let i = start; i < end && i < finite.length; i += 1) {
      const v = finite[i] ?? 0;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    points.push(lo, hi);
    if (lo < min) min = lo;
    if (hi > max) max = hi;
  }
  return { points, min, max };
}

export interface SparklineOptions {
  readonly width?: number;
  readonly height?: number;
  readonly buckets?: number;
}

const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 64;

/**
 * Two polylines in one inline SVG. No script, no external font, no gradient.
 *
 * `currentColor` at 35% opacity for the baseline means the chart themes itself
 * for free in light and dark mode — the alternative is two hard-coded palettes
 * that disagree with the CSS the day someone edits one of them.
 */
export function sparklineSvg(
  oldValues: readonly number[],
  newValues: readonly number[],
  label: string,
  opts: SparklineOptions = {},
): string {
  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  const buckets = opts.buckets ?? 120;

  const a = bucketMinMax(oldValues, buckets);
  const b = bucketMinMax(newValues, buckets);
  if (a.points.length === 0 && b.points.length === 0) return '';

  const min = Math.min(a.min, b.min);
  const max = Math.max(a.max, b.max);
  const span = max - min || 1;

  const toPath = (pts: readonly number[]): string => {
    if (pts.length === 0) return '';
    const step = pts.length === 1 ? 0 : width / (pts.length - 1);
    const coords: string[] = [];
    for (let i = 0; i < pts.length; i += 1) {
      const x = (i * step).toFixed(1);
      const y = (height - ((pts[i] ?? min) - min) / span * height).toFixed(1);
      coords.push(`${x},${y}`);
    }
    return coords.join(' ');
  };

  const oldPath = toPath(a.points);
  const newPath = toPath(b.points);
  // `role="img"` + `<title>` is the whole accessibility story for a sparkline;
  // it costs 40 bytes and makes the chart mean something to a screen reader.
  return [
    `<svg class="vibes-spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${label}">`,
    oldPath
      ? `<polyline points="${oldPath}" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.5"/>`
      : '',
    newPath
      ? `<polyline points="${newPath}" fill="none" stroke="var(--vibes-accent)" stroke-width="1.5"/>`
      : '',
    '</svg>',
  ].join('');
}

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

/**
 * The markdown surface's sparkline.
 *
 * GitHub strips inline SVG from rendered markdown, so the HTML chart simply
 * does not exist there. Unicode blocks are the only shape channel markdown has,
 * and an absent chart in the primary review surface is worse than a coarse one.
 */
export function sparklineText(values: readonly number[], width = 40): string {
  const { points, min, max } = bucketMinMax(values, width);
  if (points.length === 0) return '';
  const span = max - min || 1;
  let out = '';
  // One glyph per bucket: take the extreme furthest from the midpoint so a
  // spike still shows, rather than averaging it away.
  for (let i = 0; i < points.length; i += 2) {
    const lo = points[i] ?? min;
    const hi = points[i + 1] ?? lo;
    const mid = (min + max) / 2;
    const v = Math.abs(hi - mid) >= Math.abs(lo - mid) ? hi : lo;
    const idx = Math.min(BLOCKS.length - 1, Math.max(0, Math.round(((v - min) / span) * (BLOCKS.length - 1))));
    out += BLOCKS[idx] ?? BLOCKS[0];
  }
  return out;
}
