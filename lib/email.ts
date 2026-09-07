/**
 * Transactional email via Resend — docs/06 section 7.
 *
 * Every template exists in both languages. When RESEND_API_KEY is absent the message is
 * logged instead of sent, so the whole product is exercisable locally and in tests
 * without a provider (docs/08: "Fakes activate when a provider key is absent").
 */

import { Resend } from 'resend'
import { log } from './logger'
import type { Locale } from './i18n/config'
import { formatKrDown } from './money/calc'

const from = process.env.EMAIL_FROM ?? 'NOD <hello@nod.se>'
const opsEmail = process.env.OPS_EMAIL ?? 'ops@nod.se'
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'

const client = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null

/** Everything sent in this process while running without a key — asserted by tests. */
export const sentMail: Array<{ to: string; subject: string; html: string; tag: string }> = []

export function clearSentMail(): void {
  sentMail.length = 0
}

async function send(args: { to: string; subject: string; html: string; tag: string }): Promise<void> {
  sentMail.push(args)
  if (!client) {
    if (process.env.NODE_ENV === 'development') {
      log.info('email (not sent: no provider key)', { tag: args.tag, subject: args.subject })
    }
    return
  }
  try {
    await client.emails.send({ from, to: args.to, subject: args.subject, html: args.html })
  } catch (error) {
    log.error('email send failed', error, { tag: args.tag })
  }
}

// ---------------------------------------------------------------- layout

function shell(bodyHtml: string, locale: Locale): string {
  const footer =
    locale === 'sv'
      ? `NOD · Stockholm · <a href="${siteUrl}/privacy" style="color:#5C554D">Integritetspolicy</a>`
      : `NOD · Stockholm · <a href="${siteUrl}/privacy" style="color:#5C554D">Privacy</a>`

  return `<!doctype html><html><body style="margin:0;background:#FAF7F2;font-family:-apple-system,Segoe UI,sans-serif;color:#14110F">
<div style="max-width:520px;margin:0 auto;padding:32px 20px">
  <div style="font-weight:800;font-size:20px;letter-spacing:-0.02em;margin-bottom:24px">NOD</div>
  <div style="background:#FFFFFF;border:1px solid #E8E2DA;border-radius:12px;padding:24px">${bodyHtml}</div>
  <p style="color:#A39B91;font-size:12px;margin-top:24px">${footer}</p>
</div></body></html>`
}

const button = (href: string, label: string) =>
  `<a href="${href}" style="display:inline-block;background:#F5A524;color:#14110F;font-weight:600;padding:12px 20px;border-radius:999px;text-decoration:none">${label}</a>`

// ---------------------------------------------------------------- templates

export async function sendWaitlistConfirmation(args: {
  email: string
  position: number
  shareUrl: string
  handle: string
  locale?: Locale
}): Promise<void> {
  const locale = args.locale ?? 'sv'
  const html =
    locale === 'sv'
      ? shell(
          `<h1 style="font-size:22px;margin:0 0 12px">Du är med.</h1>
           <p style="margin:0 0 16px;color:#5C554D">Du är nummer <strong style="color:#14110F">${args.position}</strong> i kön. Vi hör av oss innan första kampanjen drar igång i Stockholm.</p>
           <p style="margin:0 0 8px;color:#5C554D">Bjud in en kompis så flyttas ni båda fram:</p>
           <p style="margin:0 0 20px"><code style="background:#FAF7F2;padding:8px 12px;border-radius:8px;display:inline-block">${args.shareUrl}</code></p>
           ${button(args.shareUrl, 'Dela din länk')}`,
          locale,
        )
      : shell(
          `<h1 style="font-size:22px;margin:0 0 12px">You're in.</h1>
           <p style="margin:0 0 16px;color:#5C554D">You're number <strong style="color:#14110F">${args.position}</strong> in the queue. We'll be in touch before the first Stockholm campaign goes live.</p>
           <p style="margin:0 0 8px;color:#5C554D">Invite a friend and you both move up:</p>
           <p style="margin:0 0 20px"><code style="background:#FAF7F2;padding:8px 12px;border-radius:8px;display:inline-block">${args.shareUrl}</code></p>
           ${button(args.shareUrl, 'Share your link')}`,
          locale,
        )

  await send({
    to: args.email,
    subject: locale === 'sv' ? `Du är nummer ${args.position} i kön` : `You're number ${args.position} in the queue`,
    html,
    tag: 'waitlist_confirmation',
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
       <p style="margin:0;color:#5C554D">
         <strong style="color:#14110F">${enquiry.company}</strong><br/>
         ${enquiry.name} — ${enquiry.email}<br/>
         Budget: ${enquiry.budgetBracket}<br/>
         Objective: ${enquiry.objective ?? '—'}
       </p>
       <p style="margin:16px 0 0;color:#5C554D;white-space:pre-wrap">${enquiry.message ?? ''}</p>`,
      'en',
    ),
    tag: 'brand_enquiry',
  })
}

export async function sendBrandUserInvite(args: { email: string; brandName: string; link: string }): Promise<void> {
  await send({
    to: args.email,
    subject: `You've been invited to ${args.brandName} on NOD`,
    html: shell(
      `<h1 style="font-size:20px;margin:0 0 12px">${args.brandName} on NOD</h1>
       <p style="margin:0 0 20px;color:#5C554D">You've been given access to the ${args.brandName} campaign dashboard. This link signs you in.</p>
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
       <p style="margin:0 0 20px;color:#5C554D">Participants can claim it now. You'll get an email at 50%, 90% and 100% fill.</p>
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
       <p style="margin:0 0 20px;color:#5C554D">Placements on ${args.campaignName} are waiting. Anything not reviewed within 24 hours is approved automatically.</p>
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
       <p style="margin:0 0 20px;color:#5C554D">${args.campaignName} has reached ${args.percent}% of its budget.</p>
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
         <tr><td style="padding:6px 0;color:#5C554D">Qualified views</td><td style="text-align:right;font-weight:600">${args.qualifiedViews.toLocaleString('sv-SE')}</td></tr>
         <tr><td style="padding:6px 0;color:#5C554D">Spent</td><td style="text-align:right;font-weight:600">${formatKrDown(args.spentOre)}</td></tr>
         <tr><td style="padding:6px 0;color:#5C554D">Effective CPM</td><td style="text-align:right;font-weight:600">${formatKrDown(args.effectiveCpmOre)}</td></tr>
       </table>
       <p style="margin:0 0 20px;color:#5C554D">You can dispute individual placements until ${args.disputeWindowEndsAt.toISOString().slice(0, 10)}.</p>
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
    subject: sv ? 'Dina uppgifter från NOD' : 'Your NOD data',
    html: shell(
      sv
        ? `<h1 style="font-size:20px;margin:0 0 12px">Dina uppgifter</h1>
           <p style="margin:0 0 20px;color:#5C554D">Här är en kopia av allt vi sparar om dig. Länken gäller i 7 dagar.</p>
           ${button(args.downloadUrl, 'Ladda ner')}`
        : `<h1 style="font-size:20px;margin:0 0 12px">Your data</h1>
           <p style="margin:0 0 20px;color:#5C554D">Here's a copy of everything we hold about you. The link works for 7 days.</p>
           ${button(args.downloadUrl, 'Download')}`,
      args.locale,
    ),
    tag: 'data_export',
  })
}
