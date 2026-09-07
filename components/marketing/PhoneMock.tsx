/**
 * Hero visual — docs/01 section 1: "a phone mock showing a normal cafe photo, a small
 * amber nod marker on the cup, and a wallet card '+42 kr'. No stock photos of
 * influencers." Drawn as inline SVG so it costs no image request and stays crisp on the
 * cheap Android phones the pilot audience uses.
 */
import { BRAND } from '@/lib/brand'
export function PhoneMock({ caption }: { caption: string }) {
  return (
    <figure className="mx-auto w-full max-w-[280px]">
      <svg viewBox="0 0 280 500" role="img" aria-label={caption} className="w-full h-auto">
        <defs>
          <clipPath id="phone-screen">
            <rect x="12" y="12" width="256" height="476" rx="28" />
          </clipPath>
          <linearGradient id="table" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#E8DDCB" />
            <stop offset="100%" stopColor="#D6C7AE" />
          </linearGradient>
        </defs>

        <rect x="0" y="0" width="280" height="500" rx="38" fill="#14110F" />
        <g clipPath="url(#phone-screen)">
          <rect x="12" y="12" width="256" height="476" fill="#FAF7F2" />

          {/* the cafe photo */}
          <rect x="12" y="60" width="256" height="300" fill="url(#table)" />
          <ellipse cx="140" cy="300" rx="86" ry="18" fill="#00000012" />
          {/* saucer + cup */}
          <ellipse cx="140" cy="286" rx="58" ry="16" fill="#FFFFFF" />
          <path d="M104 200h72v52a36 36 0 0 1-36 36 36 36 0 0 1-36-36z" fill="#FFFFFF" />
          <path d="M176 214h14a16 16 0 0 1 0 32h-14z" fill="none" stroke="#FFFFFF" strokeWidth="8" />
          <ellipse cx="140" cy="200" rx="36" ry="10" fill="#C99A6B" />
          {/* notebook + phone on the table, so it reads as a real photo */}
          <rect x="30" y="238" width="54" height="40" rx="4" fill="#F0E7D8" />
          <rect x="196" y="246" width="42" height="30" rx="4" fill="#2E2823" opacity="0.7" />

          {/* the nod marker on the cup */}
          <circle cx="140" cy="236" r="20" fill="none" stroke="#F5A524" strokeWidth="2" opacity="0.4" />
          <circle cx="140" cy="236" r="7" fill="#F5A524" />

          {/* caption row */}
          <text x="28" y="392" fontSize="13" fill="#5C554D" fontFamily="system-ui">
            Reklam – i samarbete med
          </text>
          <text x="28" y="410" fontSize="13" fill="#5C554D" fontFamily="system-ui">
            ditt kaffe
          </text>

          {/* wallet card */}
          <rect x="24" y="424" width="232" height="48" rx="12" fill="#FFFFFF" stroke="#E8E2DA" />
          <circle cx="48" cy="448" r="8" fill="#F5A524" />
          <text x="66" y="446" fontSize="11" fill="#A39B91" fontFamily="system-ui">
            {BRAND}
          </text>
          <text x="66" y="460" fontSize="12" fill="#5C554D" fontFamily="system-ui">
            Utbetalt via Swish
          </text>
          <text
            x="240"
            y="455"
            fontSize="19"
            fontWeight="800"
            fill="#1F9D6B"
            textAnchor="end"
            fontFamily="ui-monospace, monospace"
          >
            +42 kr
          </text>
        </g>
        <rect x="106" y="20" width="68" height="6" rx="3" fill="#2E2823" />
      </svg>
      <figcaption className="sr-only">{caption}</figcaption>
    </figure>
  )
}
