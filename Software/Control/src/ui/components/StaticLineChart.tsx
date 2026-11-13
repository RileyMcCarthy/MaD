import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { RefLine, cursorTooltipPlugin, fitDataRange, refLinesPlugin, zoomStatePlugin } from './uplotRef';
import ChartZoomBar from './ChartZoomBar';

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

/**
 * A non-streaming uPlot line chart for fixed data (e.g. test-run analysis).
 * Drag across it to zoom in on time; the y axis fits the data in view.
 */
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
  const [zoomed, setZoomed] = useState(false);
  const fullX: [number, number] = [x[0] ?? 0, x[x.length - 1] ?? 1];

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const opts: uPlot.Options = {
      width: container.clientWidth || 600,
      height,
      scales: {
        x: { time: false },
        y: { range: fitDataRange() },
      },
      axes: [
        { stroke: '#8b93a3', label: xLabel, grid: { stroke: '#2a2f3a' }, ticks: { stroke: '#2a2f3a' } },
        { stroke: '#8b93a3', label: yLabel, grid: { stroke: '#2a2f3a' }, ticks: { stroke: '#2a2f3a' } },
      ],
      series: [
        { label: xLabel },
        ...series.map((s) => ({ label: s.label, stroke: s.color, width: 1.5, points: { show: false } })),
      ],
      cursor: { y: false },
      plugins: [
        ...(yRefLines.length ? [refLinesPlugin({ y: yRefLines })] : []),
        cursorTooltipPlugin({ xLabel }),
        zoomStatePlugin(fullX, setZoomed),
      ],
    };
    const data: uPlot.AlignedData = [x, ...series.map((s) => s.data)];
    const plot = new uPlot(opts, data, container);
    plotRef.current = plot;
    setZoomed(false);

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

  const resetZoom = () => plotRef.current?.setScale('x', { min: fullX[0], max: fullX[1] });

  return (
    <div>
      <ChartZoomBar zoomed={zoomed} onReset={resetZoom} />
      <div ref={containerRef} style={{ width: '100%' }} />
    </div>
  );
}
