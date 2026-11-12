/**
 * The strip above a zoomable chart: how to zoom, and a reset button that
 * appears once the chart is zoomed in.
 */
export default function ChartZoomBar({ zoomed, onReset }: { zoomed: boolean; onReset: () => void }) {
  return (
    <div className="chart-zoom-bar">
      <span className="muted">Drag across the chart to zoom. Double-click also resets.</span>
      <button
        type="button"
        className="icon-button"
        onClick={onReset}
        disabled={!zoomed}
        title="Reset zoom"
        aria-label="Reset zoom"
        data-testid="chart-reset-zoom"
      >
        {/* Magnifier with a minus: zoom out to the whole run. */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" />
          <line x1="15.5" y1="15.5" x2="21" y2="21" />
          <line x1="7.5" y1="10.5" x2="13.5" y2="10.5" />
        </svg>
        <span>Reset zoom</span>
      </button>
    </div>
  );
}
