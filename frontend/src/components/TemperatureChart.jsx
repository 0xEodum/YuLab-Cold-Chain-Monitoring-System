import { useMemo, useState } from "react";
import { formatClock, formatTemp } from "../lib/format.js";

const WIDTH = 720;
const HEIGHT = 260;
const PAD = { top: 16, right: 16, bottom: 28, left: 44 };
const MARKER_R = 4;
const Y_TICKS = 5;

/** Linear scale helper: domain [d0, d1] -> range [r0, r1]. */
function scale(d0, d1, r0, r1) {
  const span = d1 - d0 || 1;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** Chart geometry for readings (tenths of °C) against an allowed band. Exported for tests. */
export function chartLayout(readings, minTemp, maxTemp) {
  const temps = readings.map((r) => r.temperature);
  const lo = Math.min(minTemp, ...temps) - 10;
  const hi = Math.max(maxTemp, ...temps) + 10;
  const times = readings.map((r) => r.timestamp);
  const t0 = times.length ? Math.min(...times) : 0;
  const t1 = times.length ? Math.max(...times) : 1;
  const x = scale(t0, t1, PAD.left, WIDTH - PAD.right);
  const y = scale(lo, hi, HEIGHT - PAD.bottom, PAD.top);
  const points = readings.map((r) => ({ ...r, cx: readings.length === 1 ? WIDTH / 2 : x(r.timestamp), cy: y(r.temperature) }));
  const ticks = Array.from({ length: Y_TICKS }, (_, i) => Math.round(lo + ((hi - lo) * i) / (Y_TICKS - 1)));
  return { points, y, ticks, lo, hi, t0, t1 };
}

export function TemperatureChart({ readings, minTemp, maxTemp }) {
  const [hover, setHover] = useState(null);
  const layout = useMemo(() => chartLayout(readings, minTemp, maxTemp), [readings, minTemp, maxTemp]);
  const { points, y, ticks } = layout;

  if (readings.length === 0) {
    return <div className="chart-empty">Показаний пока нет — график появится после первой отправки датчика.</div>;
  }

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join(" ");
  const bandTop = y(maxTemp);
  const bandBottom = y(minTemp);

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * WIDTH;
    let best = null;
    for (const p of points) {
      if (!best || Math.abs(p.cx - px) < Math.abs(best.cx - px)) best = p;
    }
    setHover(best);
  };

  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Температура по ${readings.length} показаниям, допустимо ${formatTemp(minTemp)}…${formatTemp(maxTemp)}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* allowed band */}
        <rect
          x={PAD.left}
          y={bandTop}
          width={WIDTH - PAD.left - PAD.right}
          height={Math.max(0, bandBottom - bandTop)}
          className="chart-band"
        />
        {/* y grid + labels */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(t)} y2={y(t)} className="chart-grid" />
            <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" className="chart-label">
              {(t / 10).toFixed(0)}°
            </text>
          </g>
        ))}
        <text x={PAD.left} y={HEIGHT - 8} className="chart-label">
          {formatClock(layout.t0)}
        </text>
        <text x={WIDTH - PAD.right} y={HEIGHT - 8} textAnchor="end" className="chart-label">
          {formatClock(layout.t1)}
        </text>
        {/* series */}
        <path d={path} className="chart-line" />
        {points.map((p) => (
          <circle
            key={p.sequence}
            cx={p.cx}
            cy={p.cy}
            r={p.inRange ? MARKER_R : MARKER_R + 2}
            className={p.inRange ? "chart-dot" : "chart-dot chart-dot-violation"}
          />
        ))}
        {/* hover layer */}
        {hover ? (
          <g>
            <line x1={hover.cx} x2={hover.cx} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="chart-crosshair" />
            <circle cx={hover.cx} cy={hover.cy} r={MARKER_R + 3} className="chart-dot-ring" />
          </g>
        ) : null}
      </svg>
      {hover ? (
        <div className="chart-tooltip" style={{ left: `${(hover.cx / WIDTH) * 100}%` }}>
          <div>
            <strong>#{hover.sequence}</strong> · {formatTemp(hover.temperature)}
            {hover.inRange ? "" : " — нарушение"}
          </div>
          <div className="muted small">
            {formatClock(hover.timestamp)} · блок #{hover.blockNumber}
          </div>
        </div>
      ) : null}
      <div className="chart-legend muted small">
        Полоса — допустимый диапазон {formatTemp(minTemp)} … {formatTemp(maxTemp)}; крупные маркеры — показания вне диапазона.
      </div>
    </div>
  );
}
