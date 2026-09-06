/**
 * Brand sign-in — email magic link via Supabase Auth (docs/02 section B).
 * Ops creates the Brand and invites the first admin in the pilot, so there is no
 * self-serve signup here by design (docs/09 "Not in scope").
 */
export default function BrandSignInPage() {
  return (
    <div className="max-w-sm mx-auto card p-6 text-center">
      <h1 className="text-xl mb-2">NOD</h1>
      <p className="text-sm text-[var(--color-ink-2)]">
        Brand accounts are created by NOD. Check your inbox for the sign-in link, or contact
        hello@nod.se.
      </p>
    </div>
  )
}
