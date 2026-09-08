/**
 * The referral cookie: /r/CODE sets it, joinWaitlist reads it. Thirty days, so a
 * link opened on Monday still counts for the friend who shared it when the form is
 * finally filled in on Friday. The form field wins when both are present.
 */
export const REF_COOKIE = 'NOD_REF'
export const REF_MAX_AGE_S = 60 * 60 * 24 * 30
