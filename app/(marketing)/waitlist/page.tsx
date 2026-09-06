import { redirect } from 'next/navigation'

/** Deep link to the form (docs/01 routes). The form lives in the landing page flow. */
export default function WaitlistPage() {
  redirect('/#waitlist')
}
