'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  confirmPhone,
  leaveQueue,
  saveQueueProfile,
  setSmsPreference,
  startPhoneVerification,
} from '@/app/(marketing)/queue/actions'
import { EVENTS, track } from '@/lib/analytics'
import { LoginForm } from '@/components/LoginForm'

/**
 * Page two of the waitlist game (docs/13): "YOU'RE IN — #14 821 — Stockholm — TOP 15%",
 * the level bar, the invite buttons, the point-earning tasks, this week's city board,
 * the recent events, and the SMS switch. Everything here is a number from lib/queue —
 * nothing is invented for effect.
 */

export type QueueView = {
  email: string
  city: string
  position: number
  points: number
  rank: { rank: number; total: number; percentile: number }
  cityRank: { rank: number; total: number; percentile: number }
  level: { level: number; key: string }
  next: { key: string; referrals: number; remaining: number; priority: boolean } | null
  verifiedReferrals: number
  shareUrl: string
  referralCode: string
  emailVerified: boolean
  phone: string | null
  phoneVerified: boolean
  phoneVerificationAvailable: boolean
  profile: {
    displayName: string
    handle: string
    ageBracket: string
    followersBracket: string
    categories: string[]
    complete: boolean
  }
  smsOn: boolean
  week: { points: number; rank: number | null }
  leaderboard: { entryId: string; name: string; points: number; level: number; me: boolean }[]
  events: { id: string; type: string; data: Record<string, unknown>; at: string }[]
  /** Null while the gate is up and this person has not been let in yet. */
  access: { until: string | null } | null
  gate: boolean
  converted: boolean
}

const LEVEL_ICONS: Record<string, string> = { queue: '👀', connector: '⚡', social: '🔥', insider: '🚀', founding: '👑' }
const AGE_BRACKETS = ['18-20', '21-25', '26-30', '31+'] as const
const FOLLOWER_BRACKETS = ['lt300', '300-1k', '1k-5k', '5k-20k', '20k+'] as const
const CATEGORIES = ['gym', 'food', 'study', 'travel', 'fashion', 'gaming', 'nightlife', 'hobby'] as const

const fmt = (n: number) => n.toLocaleString('sv-SE')

export function QueueStatus({ view }: { view: QueueView }) {
  const t = useTranslations('queue')
  const levels = useTranslations('queue.levels')
  const common = useTranslations('common')
  const [copied, setCopied] = useState(false)
  const [opening, setOpening] = useState(false)

  const shareText = t('shareText', { url: view.shareUrl })
  const share = (channel: string, href: string) => {
    track(EVENTS.referralLinkCopied, { channel })
    window.open(href, '_blank', 'noopener')
  }

  const canOpenAccount = view.access !== null

  return (
    <section className="section">
      <div className="wrap max-w-xl grid gap-4">
        {/* Identity */}
        <div className="card p-6 text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-[var(--color-red)] mb-3">
            {view.emailVerified || view.phoneVerified ? t('youreIn') : t('almostIn')}
          </p>
          <p className="amount text-5xl font-bold tabular">#{fmt(view.rank.rank)}</p>
          <p className="text-sm text-[var(--color-ink-2)] mt-2">
            {t(`cities.${view.city}`)} · {t('topPercent', { percent: view.cityRank.percentile })} ·{' '}
            {t('points', { points: fmt(view.points) })}
          </p>
          <p className="text-xs text-[var(--color-ink-3)] mt-1">{t('ofTotal', { total: fmt(view.rank.total) })}</p>

          <div className="mt-5 text-left">
            <div className="flex items-center justify-between text-sm mb-1">
              <span className="font-semibold">
                {LEVEL_ICONS[view.level.key]} {levels(view.level.key)}
              </span>
              {view.next && (
                <span className="text-[var(--color-ink-2)]">
                  {t('nextLevel', { count: view.next.remaining, level: levels(view.next.key) })}
                </span>
              )}
            </div>
            {view.next ? (
              <>
                <div className="h-2 rounded-full bg-[var(--color-bg)] border border-[var(--color-line)] overflow-hidden">
                  <div
                    className="h-full bg-[var(--color-red)] transition-all"
                    style={{ width: `${Math.round((view.verifiedReferrals / view.next.referrals) * 100)}%` }}
                  />
                </div>
                <p className="text-xs text-[var(--color-ink-3)] mt-1 tabular">
                  {view.verifiedReferrals}/{view.next.referrals}
                  {view.next.remaining === 1 && ` · ${t('oneMore')}`}
                  {view.next.priority && ` · ${t('priorityAtNext')}`}
                </p>
              </>
            ) : (
              <p className="text-xs text-[var(--color-ink-3)]">{t('topLevel')}</p>
            )}
          </div>
        </div>

        {/* Access */}
        {view.converted ? (
          <div className="card p-6">
            <h2 className="text-lg mb-1">{t('access.doneTitle')}</h2>
            <p className="text-sm text-[var(--color-ink-2)] mb-3">{t('access.doneBody')}</p>
            <a href="/sign-in" className="btn btn-primary w-full">
              {t('access.signIn')}
            </a>
          </div>
        ) : canOpenAccount ? (
          <div className="card p-6">
            <h2 className="text-lg mb-1">{view.gate ? t('access.turnTitle') : t('access.openTitle')}</h2>
            <p className="text-sm text-[var(--color-ink-2)] mb-3">
              {view.gate && view.access?.until
                ? t('access.turnBody', { until: new Date(view.access.until).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' }) })
                : t('access.openBody')}
            </p>
            {opening ? (
              <LoginForm audience="PARTICIPANT" next="/onboarding" initialEmail={view.email} embedded />
            ) : (
              <button
                type="button"
                className="btn btn-primary w-full"
                onClick={() => {
                  track(EVENTS.waitlistOpenAccount, {})
                  setOpening(true)
                }}
              >
                {t('access.open')}
              </button>
            )}
          </div>
        ) : null}

        {/* Invite */}
        <div className="card p-6">
          <h2 className="text-lg mb-1">{t('invite.title')}</h2>
          <p className="text-sm text-[var(--color-ink-2)] mb-3">{t('invite.body')}</p>
          <code className="block text-sm tabular bg-[var(--color-bg)] border border-[var(--color-line)] rounded-lg px-3 py-2 mb-3 break-all">
            {view.shareUrl}
          </code>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="btn btn-primary col-span-2"
              onClick={() => {
                void navigator.clipboard.writeText(view.shareUrl)
                setCopied(true)
                track(EVENTS.referralLinkCopied, { channel: 'copy' })
              }}
            >
              {copied ? common('copied') : t('invite.copy')}
            </button>
            <a className="btn btn-secondary" href={`sms:?&body=${encodeURIComponent(shareText)}`} onClick={() => track(EVENTS.referralLinkCopied, { channel: 'sms' })}>
              {t('invite.sms')}
            </a>
            <button type="button" className="btn btn-secondary" onClick={() => share('whatsapp', `https://wa.me/?text=${encodeURIComponent(shareText)}`)}>
              WhatsApp
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => share('snapchat', `https://www.snapchat.com/scan?attachmentUrl=${encodeURIComponent(view.shareUrl)}`)}>
              Snapchat
            </button>
            <a className="btn btn-secondary" href={`/api/og/invite/${view.referralCode}`} download onClick={() => track(EVENTS.referralLinkCopied, { channel: 'story' })}>
              {t('invite.story')}
            </a>
          </div>
        </div>

        {/* Tasks */}
        <div className="card p-6">
          <h2 className="text-lg mb-3">{t('tasks.title')}</h2>
          <ul className="grid gap-3">
            <Task done={view.emailVerified} label={t('tasks.email')} hint={view.emailVerified ? null : t('tasks.emailHint')} points={null} />
            <Task done={view.phoneVerified} label={t('tasks.phone')} points={100} hint={null}>
              {!view.phoneVerified && view.phoneVerificationAvailable && <PhoneVerify initialPhone={view.phone ?? ''} />}
              {!view.phoneVerified && !view.phoneVerificationAvailable && (
                <p className="text-xs text-[var(--color-ink-3)]">{t('tasks.phoneSoon')}</p>
              )}
            </Task>
            <Task done={view.profile.complete} label={t('tasks.profile')} points={100} hint={null}>
              {!view.profile.complete && <ProfileForm profile={view.profile} />}
            </Task>
            <Task done={view.profile.categories.length > 0} label={t('tasks.interests')} points={50} hint={null}>
              {view.profile.categories.length === 0 && <InterestsForm />}
            </Task>
          </ul>
        </div>

        {/* This week */}
        <div className="card p-6">
          <h2 className="text-lg mb-1">{t('week.title', { city: t(`cities.${view.city}`) })}</h2>
          <p className="text-sm text-[var(--color-ink-2)] mb-3">
            {view.week.rank
              ? t('week.you', { rank: view.week.rank, points: fmt(view.week.points) })
              : t('week.none')}
          </p>
          {view.leaderboard.length > 0 ? (
            <ol className="grid gap-1 text-sm">
              {view.leaderboard.map((row, i) => (
                <li key={row.entryId} className={`flex items-center justify-between rounded-lg px-3 py-2 ${row.me ? 'bg-[var(--color-bg)] font-semibold' : ''}`}>
                  <span>
                    <span className="tabular text-[var(--color-ink-3)] mr-2">{i + 1}.</span>
                    {row.me ? t('week.me') : row.name || t('week.anonymous')}
                  </span>
                  <span className="tabular">+{fmt(row.points)} ⚡</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-[var(--color-ink-3)]">{t('week.empty', { city: t(`cities.${view.city}`) })}</p>
          )}
        </div>

        {/* Events */}
        {view.events.length > 0 && (
          <div className="card p-6">
            <h2 className="text-lg mb-3">{t('events.title')}</h2>
            <ul className="grid gap-2 text-sm">
              {view.events.map((event) => (
                <li key={event.id} className="flex justify-between gap-3">
                  <span>{describe(event, t, levels)}</span>
                  <span className="text-xs text-[var(--color-ink-3)] tabular whitespace-nowrap">
                    {new Date(event.at).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Settings */}
        <SmsSettings phone={view.phone} smsOn={view.smsOn} />

        <p className="text-xs text-[var(--color-ink-3)] text-center">
          {t('positionNote', { position: fmt(view.position) })}
        </p>
      </div>
    </section>
  )
}

function describe(
  event: { type: string; data: Record<string, unknown> },
  t: ReturnType<typeof useTranslations<'queue'>>,
  levels: ReturnType<typeof useTranslations<'queue.levels'>>,
): string {
  const points = typeof event.data.points === 'number' ? event.data.points : 0
  switch (event.type) {
    case 'EMAIL_VERIFIED':
      return t('events.emailVerified')
    case 'PHONE_VERIFIED':
      return t('events.phoneVerified', { points })
    case 'PROFILE_COMPLETED':
      return t('events.profile', { points })
    case 'FRIEND_JOINED':
      return t('events.friendJoined')
    case 'FRIEND_VERIFIED':
      return event.data.counted ? t('events.friendVerified', { points }) : t('events.friendNotCounted')
    case 'LEVEL_UNLOCKED':
      return t('events.level', { level: levels(String(event.data.key ?? 'queue')), bonus: typeof event.data.bonus === 'number' ? event.data.bonus : 0 })
    case 'REWARD_UNLOCKED':
      return t('events.boost', { points })
    case 'ACCESS_GRANTED':
      return t('events.access')
    default:
      return event.type
  }
}

function Task({
  done,
  label,
  points,
  hint,
  children,
}: {
  done: boolean
  label: string
  points: number | null
  hint: string | null
  children?: React.ReactNode
}) {
  return (
    <li>
      <div className="flex items-center justify-between text-sm">
        <span className={done ? 'text-[var(--color-ink-3)] line-through' : 'font-medium'}>
          {done ? '✓' : '○'} {label}
        </span>
        {points !== null && <span className="tabular text-[var(--color-ink-2)]">+{points} ⚡</span>}
      </div>
      {hint && <p className="text-xs text-[var(--color-ink-3)] mt-1">{hint}</p>}
      {children && <div className="mt-2">{children}</div>}
    </li>
  )
}

function PhoneVerify({ initialPhone }: { initialPhone: string }) {
  const t = useTranslations('queue.phone')
  const router = useRouter()
  const [phone, setPhone] = useState(initialPhone)
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [devCode, setDevCode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  return (
    <div className="grid gap-2">
      {!sent ? (
        <div className="flex gap-2">
          <input
            className="field"
            inputMode="tel"
            autoComplete="tel"
            placeholder="070-123 45 67"
            aria-label={t('number')}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-secondary whitespace-nowrap"
            disabled={pending || phone.length < 8}
            onClick={() =>
              start(async () => {
                setError(null)
                const result = await startPhoneVerification(phone)
                if (result.ok) {
                  setSent(true)
                  setDevCode(result.devCode ?? null)
                } else setError(t(`errors.${result.error}`))
              })
            }
          >
            {t('send')}
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <input
            className="field tabular"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            aria-label={t('code')}
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
          <button
            type="button"
            className="btn btn-primary whitespace-nowrap"
            disabled={pending || code.length !== 6}
            onClick={() =>
              start(async () => {
                setError(null)
                const result = await confirmPhone(phone, code)
                if (result.ok) router.refresh()
                else setError(t(`errors.${result.error}`))
              })
            }
          >
            {t('confirm')}
          </button>
        </div>
      )}
      {devCode && (
        <p className="text-xs text-[var(--color-ink-3)]">
          {t('devCode')} <code className="tabular">{devCode}</code>
        </p>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}

function ProfileForm({ profile }: { profile: QueueView['profile'] }) {
  const t = useTranslations('queue.profile')
  const w = useTranslations('marketing.waitlist')
  const router = useRouter()
  const [displayName, setDisplayName] = useState(profile.displayName)
  const [handle, setHandle] = useState(profile.handle)
  const [ageBracket, setAgeBracket] = useState(profile.ageBracket)
  const [followersBracket, setFollowersBracket] = useState(profile.followersBracket)
  const [pending, start] = useTransition()

  return (
    <div className="grid gap-2">
      <input className="field" placeholder={t('displayName')} aria-label={t('displayName')} maxLength={40} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      <input className="field" placeholder={w('handlePlaceholder')} aria-label={w('handle')} autoComplete="username" value={handle} onChange={(e) => setHandle(e.target.value)} />
      <div className="grid grid-cols-2 gap-2">
        <select className="field" aria-label={w('ageBracket')} value={ageBracket} onChange={(e) => setAgeBracket(e.target.value)}>
          <option value="" disabled>
            {w('ageBracket')}
          </option>
          {AGE_BRACKETS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select className="field" aria-label={w('followersBracket')} value={followersBracket} onChange={(e) => setFollowersBracket(e.target.value)}>
          <option value="" disabled>
            {w('followersBracket')}
          </option>
          {FOLLOWER_BRACKETS.map((f) => (
            <option key={f} value={f}>
              {w(`followersOptions.${f}`)}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        className="btn btn-secondary w-full"
        disabled={pending || !handle || !ageBracket || !followersBracket}
        onClick={() =>
          start(async () => {
            const result = await saveQueueProfile({ displayName, handle, ageBracket, followersBracket })
            if (result.ok) router.refresh()
          })
        }
      >
        {t('save')}
      </button>
      <p className="text-xs text-[var(--color-ink-3)]">{t('nameHint')}</p>
    </div>
  )
}

function InterestsForm() {
  const chips = useTranslations('marketing.who.chips')
  const t = useTranslations('queue.profile')
  const router = useRouter()
  const [categories, setCategories] = useState<string[]>([])
  const [pending, start] = useTransition()
  const toggle = (value: string) =>
    setCategories((current) => (current.includes(value) ? current.filter((c) => c !== value) : [...current, value]))

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            className="chip text-xs"
            aria-pressed={categories.includes(c)}
            onClick={() => toggle(c)}
          >
            {chips(c)}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="btn btn-secondary w-full"
        disabled={pending || categories.length === 0}
        onClick={() =>
          start(async () => {
            const result = await saveQueueProfile({ categories })
            if (result.ok) router.refresh()
          })
        }
      >
        {t('save')}
      </button>
    </div>
  )
}

function SmsSettings({ phone, smsOn }: { phone: string | null; smsOn: boolean }) {
  const t = useTranslations('queue.sms')
  const router = useRouter()
  const [pending, start] = useTransition()
  const [leaving, setLeaving] = useState(false)

  return (
    <div className="card p-6">
      <h2 className="text-lg mb-1">{t('title')}</h2>
      <p className="text-sm text-[var(--color-ink-2)] mb-3">{t('body')}</p>
      {phone ? (
        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={smsOn}
            disabled={pending}
            onChange={(e) =>
              start(async () => {
                await setSmsPreference(e.target.checked)
                router.refresh()
              })
            }
          />
          <span>{t('toggle')}</span>
        </label>
      ) : (
        <p className="text-xs text-[var(--color-ink-3)]">{t('noPhone')}</p>
      )}
      <p className="text-xs text-[var(--color-ink-3)] mt-2">{t('stopHint')}</p>
      <div className="mt-4 pt-4 border-t border-[var(--color-line)]">
        {leaving ? (
          <div className="flex items-center gap-3 text-sm">
            <span>{t('leaveConfirm')}</span>
            <button
              type="button"
              className="btn btn-secondary text-sm"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  await leaveQueue()
                  router.push('/')
                })
              }
            >
              {t('leaveYes')}
            </button>
            <button type="button" className="text-sm underline" onClick={() => setLeaving(false)}>
              {t('leaveNo')}
            </button>
          </div>
        ) : (
          <button type="button" className="text-xs underline text-[var(--color-ink-3)]" onClick={() => setLeaving(true)}>
            {t('leave')}
          </button>
        )}
      </div>
    </div>
  )
}
