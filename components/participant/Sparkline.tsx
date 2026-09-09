/** Tiny inline line chart for a series of counts — no library, renders on the server. */
export function Sparkline({ values, width = 240, height = 40 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const step = width / (values.length - 1)
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`)
  const last = points[points.length - 1]?.split(',') ?? ['0', '0']

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none" aria-hidden="true">
      <polyline fill="none" stroke="var(--color-teal-dk)" strokeWidth="2" strokeLinejoin="round" points={points.join(' ')} />
      <circle cx={last[0]} cy={last[1]} r="3" fill="var(--color-orange)" />
    </svg>
  )
}
