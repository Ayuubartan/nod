/** The three step icons from docs/10: play (pick), phone (post), wallet (get paid). */
export function StepIcon({ kind }: { kind: 'play' | 'phone' | 'wallet' }) {
  const paths = {
    play: <path d="M9 7.5v9l7.5-4.5z" />,
    phone: (
      <>
        <rect x="7" y="3.5" width="10" height="17" rx="2.5" />
        <path d="M10.5 17.5h3" />
      </>
    ),
    wallet: (
      <>
        <rect x="3.5" y="6.5" width="17" height="12" rx="2.5" />
        <path d="M3.5 10h17M15 14h2" />
      </>
    ),
  }
  return (
    <span className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-[var(--color-teal)] text-[#111820]">
      <svg
        viewBox="0 0 24 24"
        width="24"
        height="24"
        fill={kind === 'play' ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {paths[kind]}
      </svg>
    </span>
  )
}
