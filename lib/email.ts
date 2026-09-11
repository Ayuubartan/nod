/**
 * Transactional email via Resend — docs/06 section 7.
 *
 * Every template exists in both languages. When RESEND_API_KEY is absent the message is
 * logged instead of sent, so the whole product is exercisable locally and in tests
 * without a provider (docs/08: "Fakes activate when a provider key is absent").
 */

import { Resend } from 'resend'
import { BRAND, HELLO_EMAIL, OPS_EMAIL_DEFAULT, WORDMARK } from './brand'
import { log } from './logger'
import type { Locale } from './i18n/config'
import { formatKrDown } from './money/calc'

const from = process.env.EMAIL_FROM ?? `${BRAND} <${HELLO_EMAIL}>`
const opsEmail = process.env.OPS_EMAIL ?? OPS_EMAIL_DEFAULT
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'

const client = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null

/** Everything sent in this process while running without a key — asserted by tests. */
export const sentMail: Array<{ to: string; subject: string; html: string; tag: string }> = []

export function clearSentMail(): void {
  sentMail.length = 0
}

/** Resolves to whether a provider actually carried the message. */
async function send(args: { to: string; subject: string; html: string; tag: string }): Promise<{ sent: boolean }> {
  sentMail.push(args)
  if (!client) {
    if (process.env.NODE_ENV === 'development') {
      log.info('email (not sent: no provider key)', { tag: args.tag, subject: args.subject })
    }
    return { sent: false }
  }
  try {
    // The SDK reports API refusals (unverified domain, test-mode recipient) as a
    // returned error, not a throw. Treating those as sent would hide the sign-in code
    // from a demo user who is never going to get the mail.
    const { error } = await client.emails.send({ from, to: args.to, subject: args.subject, html: args.html })
    if (error) {
      log.error('email send refused', new Error(error.message), { tag: args.tag, name: error.name })
      return { sent: false }
    }
    return { sent: true }
  } catch (error) {
    log.error('email send failed', error, { tag: args.tag })
    return { sent: false }
  }
}

// ---------------------------------------------------------------- layout

function shell(bodyHtml: string, locale: Locale): string {
  const footer =
    locale === 'sv'
      ? `${BRAND} · Stockholm · <a href="${siteUrl}/privacy" style="color:#4B5560">Integritetspolicy</a>`
      : `${BRAND} · Stockholm · <a href="${siteUrl}/privacy" style="color:#4B5560">Privacy</a>`

  return `<!doctype html><html><body style="margin:0;background:#F4F1EA;font-family:-apple-system,Segoe UI,sans-serif;color:#111820">
<div style="max-width:520px;margin:0 auto;padding:32px 20px">
  <div style="margin-bottom:24px;font-weight:800;font-size:20px;letter-spacing:-0.04em"><span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#20C5C7;vertical-align:-1px;margin-right:8px"></span>${WORDMARK}</div>
  <div style="background:#FFFFFF;border:1px solid #E1DDD3;border-radius:12px;padding:24px">${bodyHtml}</div>
  <p style="color:#8A929B;font-size:12px;margin-top:24px">${footer}</p>
</div></body></html>`
}

const button = (href: string, label: string) =>
  `<a href="${href}" style="display:inline-block;background:#FF7417;color:#FFFFFF;font-weight:700;padding:12px 20px;border-radius:999px;text-decoration:none">${label}</a>`

// ---------------------------------------------------------------- templates

/** Sign-in code (lib/login.ts). Ten minutes, six digits, no link to click. */
export async function loginCodeEmail(email: string, code: string, locale: Locale): Promise<{ sent: boolean }> {
  const digits = `<p style="margin:16px 0 20px;font-size:32px;font-weight:800;letter-spacing:0.25em;font-family:Consolas,Menlo,monospace">${code}</p>`
  const html =
    locale === 'sv'
      ? shell(
          `<h1 style="font-size:22px;margin:0 0 12px">Din inloggningskod</h1>
           <p style="margin:0;color:#4B5560">Skriv in koden i ${BRAND}. Den gäller i tio minuter.</p>
           ${digits}
           <p style="margin:0;color:#8A929B;font-size:13px">Har du inte försökt logga in kan du ignorera det här mejlet. Ingen kan logga in utan koden.</p>`,
          locale,
        )
      : shell(
          `<h1 style="font-size:22px;margin:0 0 12px">Your sign-in code</h1>
           <p style="margin:0;color:#4B5560">Enter this code in ${BRAND}. It is valid for ten minutes.</p>
           ${digits}
           <p style="margin:0;color:#8A929B;font-size:13px">If you didn't try to sign in you can ignore this email. Nobody can sign in without the code.</p>`,
          locale,
        )

  return send({
    to: email,
    subject: locale === 'sv' ? `${code} är din ${BRAND}-kod` : `${code} is your ${BRAND} code`,
    html,
    tag: 'login_code',
  })
}

export async function sendWaitlistConfirmation(args: {
  email: string
  position: number
  /** Signed link to /queue — opening it verifies the address (lib/queue-session.ts). */
  queueUrl: string
  shareUrl: string
  locale?: Locale
}): Promise<void> {
  const locale = args.locale ?? 'sv'
  const html =
    locale === 'sv'
      ? shell(
          `<h1 style="font-size:22px;margin:0 0 12px">Tack – du är med.</h1>
           <p style="margin:0 0 16px;color:#4B5560">Du är nummer <strong style="color:#111820">${args.position}</strong> i kön. Bekräfta din e-post så räknas du – och se din plats, dina poäng och din inbjudningslänk.</p>
           ${button(args.queueUrl, 'Bekräfta och se din plats')}
           <p style="margin:24px 0 8px;color:#4B5560">Varje vän som går med via din länk och bekräftar sig flyttar dig framåt:</p>
           <p style="margin:0"><code style="background:#F4F1EA;padding:8px 12px;border-radius:8px;display:inline-block">${args.shareUrl}</code></p>`,
          locale,
        )
      : shell(
          `<h1 style="font-size:22px;margin:0 0 12px">Thanks – you're in.</h1>
           <p style="margin:0 0 16px;color:#4B5560">You're number <strong style="color:#111820">${args.position}</strong> in the queue. Confirm your email to count – and see your place, your points and your invite link.</p>
           ${button(args.queueUrl, 'Confirm and see your place')}
           <p style="margin:24px 0 8px;color:#4B5560">Every friend who joins through your link and confirms moves you up:</p>
           <p style="margin:0"><code style="background:#F4F1EA;padding:8px 12px;border-radius:8px;display:inline-block">${args.shareUrl}</code></p>`,
          locale,
        )

  await send({
    to: args.email,
    subject: locale === 'sv' ? `Du är nummer ${args.position} i kön` : `You're number ${args.position} in the queue`,
    html,
    tag: 'waitlist_confirmation',
  })
}

/** "Email me my link" on /queue when the cookie is gone. */
export async function sendQueueLink(args: { email: string; queueUrl: string; locale?: Locale }): Promise<void> {
  const locale = args.locale ?? 'sv'
  const html =
    locale === 'sv'
      ? shell(
          `<h1 style="font-size:22px;margin:0 0 12px">Din plats i kön</h1>
           <p style="margin:0 0 16px;color:#4B5560">Här är din personliga länk. Den gäller i 30 dagar.</p>
           ${button(args.queueUrl, 'Se din plats')}`,
          locale,
        )
      : shell(
          `<h1 style="font-size:22px;margin:0 0 12px">Your place in the queue</h1>
           <p style="margin:0 0 16px;color:#4B5560">Here is your personal link. It works for 30 days.</p>
           ${button(args.queueUrl, 'See your place')}`,
          locale,
        )
  await send({
    to: args.email,
    subject: locale === 'sv' ? 'Din plats i kön' : 'Your place in the queue',
    html,
    tag: 'queue_link',
  })
}

/** Ops opened the doors: 48 hours to sign in (docs/13). */
export async function sendAccessGranted(args: { email: string; link: string; expiresAt: Date | null; locale?: Locale }): Promise<void> {
  const locale = args.locale ?? 'sv'
  const until = args.expiresAt
    ? args.expiresAt.toLocaleString(locale === 'sv' ? 'sv-SE' : 'en-GB', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Stockholm' })
    : null
  const html =
    locale === 'sv'
      ? shell(
          `<h1 style="font-size:22px;margin:0 0 12px">Din tur.</h1>
           <p style="margin:0 0 16px;color:#4B5560">${BRAND} öppnar för dig nu. Öppna ditt konto med samma e-postadress – inget lösenord, vi mejlar en kod.${until ? ` Din invite gäller till ${until}.` : ''}</p>
           ${button(args.link, 'Öppna ditt konto')}`,
          locale,
        )
      : shell(
          `<h1 style="font-size:22px;margin:0 0 12px">Your turn.</h1>
           <p style="margin:0 0 16px;color:#4B5560">${BRAND} is opening for you now. Open your account with this same address – no password, we email a code.${until ? ` Your invite is valid until ${until}.` : ''}</p>
           ${button(args.link, 'Open your account')}`,
          locale,
        )
  await send({
    to: args.email,
    subject: locale === 'sv' ? `Din tur – ${BRAND} öppnar för dig` : `Your turn – ${BRAND} is opening for you`,
    html,
    tag: 'waitlist_access',
  })
}

export async function sendBrandEnquiryToOps(enquiry: {
  id: string
  company: string
  name: string
  email: string
  budgetBracket: string
  objective: string | null
  message: string | null
}): Promise<void> {
  await send({
    to: opsEmail,
    subject: `Brand enquiry: ${enquiry.company} (${enquiry.budgetBracket})`,
    html: shell(
      `<h1 style="font-size:18px;margin:0 0 12px">New brand enquiry</h1>
       <p style="margin:0;color:#4B5560">
         <strong style="color:#111820">${enquiry.company}</strong><br/>
         ${enquiry.name} — ${enquiry.email}<br/>
         Budget: ${enquiry.budgetBracket}<br/>
         Objective: ${enquiry.objective ?? '—'}
       </p>
       <p style="margin:16px 0 0;color:#4B5560;white-space:pre-wrap">${enquiry.message ?? ''}</p>`,
      'en',
    ),
    tag: 'brand_enquiry',
  })
}

export async function sendBrandUserInvite(args: { email: string; brandName: string; link: string }): Promise<void> {
  await send({
    to: args.email,
    subject: `You've been invited to ${args.brandName} on ${BRAND}`,
    html: shell(
      `<h1 style="font-size:20px;margin:0 0 12px">${args.brandName} on ${BRAND}</h1>
       <p style="margin:0 0 20px;color:#4B5560">You've been given access to the ${args.brandName} campaign dashboard. This link signs you in.</p>
       ${button(args.link, 'Open the dashboard')}`,
      'en',
    ),
    tag: 'brand_invite',
  })
}

export async function sendCampaignLiveToBrand(args: {
  email: string
  campaignName: string
  campaignId: string
}): Promise<void> {
  await send({
    to: args.email,
    subject: `${args.campaignName} is live`,
    html: shell(
      `<h1 style="font-size:20px;margin:0 0 12px">${args.campaignName} is live</h1>
       <p style="margin:0 0 20px;color:#4B5560">Participants can claim it now. You'll get an email at 50%, 90% and 100% fill.</p>
       ${button(`${siteUrl}/campaigns/${args.campaignId}`, 'Open the dashboard')}`,
      'en',
    ),
    tag: 'campaign_live',
  })
}

export async function sendBrandReviewNeeded(args: {
  email: string
  campaignName: string
  campaignId: string
  count: number
  reminder?: boolean
}): Promise<void> {
  await send({
    to: args.email,
    subject: args.reminder
      ? `Reminder: ${args.count} placements waiting for review`
      : `${args.count} placements need your review`,
    html: shell(
      `<h1 style="font-size:20px;margin:0 0 12px">${args.count} to review</h1>
       <p style="margin:0 0 20px;color:#4B5560">Placements on ${args.campaignName} are waiting. Anything not reviewed within 24 hours is approved automatically.</p>
       ${button(`${siteUrl}/campaigns/${args.campaignId}/review`, 'Review now')}`,
      'en',
    ),
    tag: 'brand_review_needed',
  })
}

export async function sendFillThreshold(args: {
  email: string
  campaignName: string
  campaignId: string
  percent: number
}): Promise<void> {
  await send({
    to: args.email,
    subject: `${args.campaignName} is ${args.percent}% filled`,
    html: shell(
      `<h1 style="font-size:20px;margin:0 0 12px">${args.percent}% filled</h1>
       <p style="margin:0 0 20px;color:#4B5560">${args.campaignName} has reached ${args.percent}% of its budget.</p>
       ${button(`${siteUrl}/campaigns/${args.campaignId}`, 'Open the dashboard')}`,
      'en',
    ),
    tag: 'fill_threshold',
  })
}

export async function sendFinalReport(args: {
  email: string
  campaignName: string
  campaignId: string
  qualifiedViews: number
  spentOre: number
  effectiveCpmOre: number
  disputeWindowEndsAt: Date
}): Promise<void> {
  await send({
    to: args.email,
    subject: `Final report: ${args.campaignName}`,
    html: shell(
      `<h1 style="font-size:20px;margin:0 0 12px">${args.campaignName} — final report</h1>
       <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
         <tr><td style="padding:6px 0;color:#4B5560">Qualified views</td><td style="text-align:right;font-weight:600">${args.qualifiedViews.toLocaleString('sv-SE')}</td></tr>
         <tr><td style="padding:6px 0;color:#4B5560">Spent</td><td style="text-align:right;font-weight:600">${formatKrDown(args.spentOre)}</td></tr>
         <tr><td style="padding:6px 0;color:#4B5560">Effective CPM</td><td style="text-align:right;font-weight:600">${formatKrDown(args.effectiveCpmOre)}</td></tr>
       </table>
       <p style="margin:0 0 20px;color:#4B5560">You can dispute individual placements until ${args.disputeWindowEndsAt.toISOString().slice(0, 10)}.</p>
       ${button(`${siteUrl}/campaigns/${args.campaignId}/report`, 'Open the report')}`,
      'en',
    ),
    tag: 'final_report',
  })
}

export async function sendDataExport(args: { email: string; downloadUrl: string; locale: Locale }): Promise<void> {
  const sv = args.locale === 'sv'
  await send({
    to: args.email,
    subject: sv ? `Dina uppgifter från ${BRAND}` : `Your ${BRAND} data`,
    html: shell(
      sv
        ? `<h1 style="font-size:20px;margin:0 0 12px">Dina uppgifter</h1>
           <p style="margin:0 0 20px;color:#4B5560">Här är en kopia av allt vi sparar om dig. Länken gäller i 7 dagar.</p>
           ${button(args.downloadUrl, 'Ladda ner')}`
        : `<h1 style="font-size:20px;margin:0 0 12px">Your data</h1>
           <p style="margin:0 0 20px;color:#4B5560">Here's a copy of everything we hold about you. The link works for 7 days.</p>
           ${button(args.downloadUrl, 'Download')}`,
      args.locale,
    ),
    tag: 'data_export',
  })
}
