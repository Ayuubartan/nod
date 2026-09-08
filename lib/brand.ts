/**
 * The public brand. "NOD" stays as the internal codename — repo, docs, env vars
 * (`NOD_*`), cookies (`NOD_SESSION`) — because renaming those buys nothing and would
 * log every user out. Anything a person can see goes through these constants or the
 * i18n files.
 */
export const BRAND = 'Boogaa'
export const BRAND_DOMAIN = 'joinbooga.se'
export const HELLO_EMAIL = `hello@${BRAND_DOMAIN}`
export const OPS_EMAIL_DEFAULT = `ops@${BRAND_DOMAIN}`

/** The wordmark as it is set in the logo lockup: heavy caps, docs/10. */
export const WORDMARK = 'BOOGAA'
