/**
 * Daily qualified views — docs/02 B2.
 *
 * Inline SVG bars rather than a charting library: it is one series, it must render in
 * an email-forwarded screenshot, and adding ~90 kB of JavaScript to a dashboard for a
 * bar chart is not a trade worth making.
 */
export function DailyViewsChart({ data }: { data: Array<{ day: string; views: number }> }) {
  if (data.length === 0) return null

  const max = Math.max(...data.map((d) => d.views), 1)
  const width = Math.max(data.length * 24, 240)
  const height = 120
  const barWidth = 16

  return (
    <div className="card p-4 overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height + 24}`}
        width={width}
        height={height + 24}
        role="img"
        aria-label={`Qualified views per day, peak ${max.toLocaleString('sv-SE')}`}
      >
        {data.map((point, index) => {
          const barHeight = Math.max(2, (point.views / max) * height)
          return (
            <g key={point.day}>
              <rect
                x={index * 24 + 4}
                y={height - barHeight}
                width={barWidth}
                height={barHeight}
                rx={3}
                fill="var(--color-blue)"
              >
                <title>{`${point.day}: ${point.views.toLocaleString('sv-SE')}`}</title>
              </rect>
              {index % Math.ceil(data.length / 8 || 1) === 0 && (
                <text
                  x={index * 24 + 12}
                  y={height + 16}
                  fontSize="9"
                  textAnchor="middle"
                  fill="var(--color-ink-3)"
                >
                  {point.day.slice(5)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
