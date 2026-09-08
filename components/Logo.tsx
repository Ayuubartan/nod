import Link from 'next/link'
import { BRAND, WORDMARK } from '@/lib/brand'

/**
 * The Boogaa mark (docs/10): a teal circle with a bite taken out of its right side and
 * an orange bolt inside. Drawn inline so it costs no request and takes the current
 * colours — the wordmark is `currentColor`, which is how the dark lockup happens for
 * free (teal mark, paper wordmark on ink).
 */
export function BoogaaMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M50 50 L96.98 32.9 A50 50 0 1 0 96.98 67.1 Z" fill="#20C5C7" />
      <path d="M58 18 L30 56 L47 56 L40 84 L70 42 L53 42 Z" fill="#FF7417" />
    </svg>
  )
}

/** Primary lockup: mark + wordmark. `symbol` renders the mark alone. */
export function Logo({
  href = '/',
  size = 28,
  symbol = false,
  className = '',
}: {
  href?: string | null
  size?: number
  symbol?: boolean
  className?: string
}) {
  const inner = (
    <>
      <BoogaaMark size={size} />
      {!symbol && (
        <span
          className="font-[family-name:var(--font-display)] font-bold tracking-[-0.04em] leading-none"
          style={{ fontSize: size * 0.82 }}
        >
          {WORDMARK}
        </span>
      )}
    </>
  )
  const classes = `inline-flex items-center gap-2 text-[var(--color-ink)] ${className}`
  if (href === null) return <span className={classes}>{inner}</span>
  return (
    <Link href={href} className={classes} aria-label={BRAND}>
      {inner}
    </Link>
  )
}
