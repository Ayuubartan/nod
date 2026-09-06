'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { opsCreateBrand } from '@/app/(ops)/actions'

/** Creates the Brand and invites its first admin by magic link (docs/02 section B). */
export function CreateBrandForm() {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <form
      className="card p-4 grid gap-3 sm:grid-cols-4 sm:items-end"
      action={async (formData: FormData) => {
        setPending(true)
        setError(null)
        const result = await opsCreateBrand({
          name: formData.get('name'),
          orgNumber: formData.get('orgNumber') || null,
          adminEmail: formData.get('adminEmail'),
        })
        setPending(false)
        if (result.ok) router.refresh()
        else setError(result.error)
      }}
    >
      <div>
        <label className="label" htmlFor="brand-name">Name</label>
        <input id="brand-name" name="name" required className="field text-sm" />
      </div>
      <div>
        <label className="label" htmlFor="brand-org">Org number</label>
        <input id="brand-org" name="orgNumber" className="field text-sm" />
      </div>
      <div>
        <label className="label" htmlFor="brand-admin">Admin email</label>
        <input id="brand-admin" name="adminEmail" type="email" required className="field text-sm" />
      </div>
      <button type="submit" className="btn btn-primary text-sm" disabled={pending}>
        Create and invite
      </button>
      {error && <p className="error-text sm:col-span-4">{error}</p>}
    </form>
  )
}
