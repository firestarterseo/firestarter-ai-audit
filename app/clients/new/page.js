'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function NewClientPage() {
  const router = useRouter()
  const [form, setForm] = useState({ name: '', url: '', city: '', region: '', category: '', status: 'lead', notes: '' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  async function onSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to create client')
      // Client setup starts with Business Profile, not the audit page --
      // this is where the first automatic Client/Industry Intelligence
      // classification pass happens (see settings/business-profile/page.js).
      router.push(`/clients/${data.client.id}/settings/business-profile`)
    } catch (err) {
      setError(err.message)
      setSubmitting(false)
    }
  }

  function set(field) {
    return e => setForm(f => ({ ...f, [field]: e.target.value }))
  }

  return (
    <div style={{ maxWidth: 520 }}>
      <div className="section-label">Internal Grader</div>
      <h1 style={{ marginBottom: 24 }}>Add client</h1>
      <form onSubmit={onSubmit} className="card" style={{ padding: 28 }}>
        <label className="field-label">Name *</label>
        <input className="field-input" value={form.name} onChange={set('name')} required />

        <label className="field-label">URL *</label>
        <input className="field-input" placeholder="https://example.com" value={form.url} onChange={set('url')} required />

        <label className="field-label">City</label>
        <input className="field-input" value={form.city} onChange={set('city')} />

        <label className="field-label">Region / State</label>
        <input className="field-input" value={form.region} onChange={set('region')} />

        <label className="field-label">Category</label>
        <input className="field-input" placeholder="e.g. accounting and tax service" value={form.category} onChange={set('category')} />

        <label className="field-label">Status</label>
        <select className="field-input" value={form.status} onChange={set('status')}>
          <option value="lead">Lead (no history -- snapshot mode)</option>
          <option value="tracked">Tracked client (recurring history)</option>
        </select>

        <label className="field-label">Notes</label>
        <textarea className="field-input" style={{ minHeight: 70 }} value={form.notes} onChange={set('notes')} />

        {error && <p className="field-error">{error}</p>}

        <button type="submit" disabled={submitting} className="btn btn-primary" style={{ width: '100%' }}>
          {submitting ? 'Creating...' : 'Create client'}
        </button>
      </form>
    </div>
  )
}
