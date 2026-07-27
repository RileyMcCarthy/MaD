import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { RefLine, refLinesPlugin, rangeIncluding } from './uplotRef';

export interface StaticSeries {
  label: string;
  color: string;
  data: number[];
}

interface StaticLineChartProps {
  xLabel: string;
  yLabel: string;
  x: number[];
  series: StaticSeries[];
  /** Horizontal reference lines (limits) on the y axis. */
  yRefLines?: RefLine[];
  height?: number;
}

/** A non-streaming uPlot line chart for fixed data (e.g. test-run analysis). */
export default function StaticLineChart({
  xLabel,
  yLabel,
  x,
  series,
  yRefLines = [],
  height = 320,
}: StaticLineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const opts: uPlot.Options = {
      width: container.clientWidth || 600,
      height,
      scales: {
        x: { time: false },
        y: yRefLines.length ? { range: rangeIncluding(yRefLines) } : {},
      },
      axes: [
        { stroke: '#8b93a3', label: xLabel, grid: { stroke: '#2a2f3a' }, ticks: { stroke: '#2a2f3a' } },
        { stroke: '#8b93a3', label: yLabel, grid: { stroke: '#2a2f3a' }, ticks: { stroke: '#2a2f3a' } },
      ],
      series: [
        { label: xLabel },
        ...series.map((s) => ({ label: s.label, stroke: s.color, width: 1.5, points: { show: false } })),
      ],
      plugins: yRefLines.length ? [refLinesPlugin({ y: yRefLines })] : [],
    };
    const data: uPlot.AlignedData = [x, ...series.map((s) => s.data)];
    const plot = new uPlot(opts, data, container);
    plotRef.current = plot;

    const resize = new ResizeObserver(() => {
      plot.setSize({ width: container.clientWidth || 600, height });
    });
    resize.observe(container);

    return () => {
      resize.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xLabel, yLabel, height, JSON.stringify(x), JSON.stringify(series), JSON.stringify(yRefLines)]);

  return <div ref={containerRef} style={{ width: '100%' }} />;
}
