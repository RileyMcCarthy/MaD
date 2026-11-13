import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { RefLine, cursorTooltipPlugin, fitDataRange, refLinesPlugin, zoomStatePlugin } from './uplotRef';
import ChartZoomBar from './ChartZoomBar';

interface StaticScatterChartProps {
  xLabel: string;
  yLabel: string;
  points: Array<{ x: number; y: number }>;
  color?: string;
  xRefLines?: RefLine[];
  yRefLines?: RefLine[];
  height?: number;
}

/** Points-only uPlot chart (markers, no connecting line) for stress–strain etc. */
export default function StaticScatterChart({
  xLabel,
  yLabel,
  points,
  color = '#4ea1ff',
  xRefLines = [],
  yRefLines = [],
  height = 360,
}: StaticScatterChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const xsAll = points.map((p) => p.x).filter((v) => Number.isFinite(v));
  const fullX: [number, number] = xsAll.length ? [Math.min(...xsAll), Math.max(...xsAll)] : [0, 1];

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);

    const opts: uPlot.Options = {
      width: container.clientWidth || 600,
      height,
      scales: {
        x: { time: false, range: fitDataRange(0.02) },
        y: { range: fitDataRange() },
      },
      axes: [
        { stroke: '#8b93a3', label: xLabel, grid: { stroke: '#2a2f3a' }, ticks: { stroke: '#2a2f3a' } },
        { stroke: '#8b93a3', label: yLabel, grid: { stroke: '#2a2f3a' }, ticks: { stroke: '#2a2f3a' } },
      ],
      series: [
        {},
        {
          label: yLabel,
          stroke: color,
          fill: color,
          // points-only: suppress the connecting path, show markers
          paths: () => null,
          points: { show: true, size: 4 },
        },
      ],
      cursor: { y: false },
      plugins: [
        ...(xRefLines.length || yRefLines.length ? [refLinesPlugin({ x: xRefLines, y: yRefLines })] : []),
        cursorTooltipPlugin({ xLabel, xDecimals: 3 }),
        zoomStatePlugin(fullX, setZoomed),
      ],
    };
    const data: uPlot.AlignedData = [xs, ys];
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
  }, [xLabel, yLabel, height, color, JSON.stringify(points), JSON.stringify(xRefLines), JSON.stringify(yRefLines)]);

  const resetZoom = () => plotRef.current?.setScale('x', { min: fullX[0], max: fullX[1] });

  return (
    <div>
      <ChartZoomBar zoomed={zoomed} onReset={resetZoom} />
      <div ref={containerRef} style={{ width: '100%' }} />
    </div>
  );
}
