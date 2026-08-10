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
      router.push(`/clients/${data.client.id}`)
    } catch (err) {
      setError(err.message)
      setSubmitting(false)
    }
  }

  function set(field) {
    return e => setForm(f => ({ ...f, [field]: e.target.value }))
  }

  const inputStyle = { display: 'block', width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', marginBottom: 12, fontSize: 14 }
  const labelStyle = { display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }

  return (
    <div style={{ maxWidth: 480 }}>
      <h1 style={{ fontSize: 22 }}>Add client</h1>
      <form onSubmit={onSubmit} style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, padding: 20 }}>
        <label style={labelStyle}>Name *</label>
        <input style={inputStyle} value={form.name} onChange={set('name')} required />

        <label style={labelStyle}>URL *</label>
        <input style={inputStyle} placeholder="https://example.com" value={form.url} onChange={set('url')} required />

        <label style={labelStyle}>City</label>
        <input style={inputStyle} value={form.city} onChange={set('city')} />

        <label style={labelStyle}>Region / State</label>
        <input style={inputStyle} value={form.region} onChange={set('region')} />

        <label style={labelStyle}>Category</label>
        <input style={inputStyle} placeholder="e.g. accounting and tax service" value={form.category} onChange={set('category')} />

        <label style={labelStyle}>Status</label>
        <select style={inputStyle} value={form.status} onChange={set('status')}>
          <option value="lead">Lead (no history -- snapshot mode)</option>
          <option value="tracked">Tracked client (recurring history)</option>
        </select>

        <label style={labelStyle}>Notes</label>
        <textarea style={{ ...inputStyle, minHeight: 60 }} value={form.notes} onChange={set('notes')} />

        {error && <p style={{ color: '#dc2626', fontSize: 13 }}>{error}</p>}

        <button type="submit" disabled={submitting} style={{ background: '#111827', color: 'white', padding: '10px 16px', borderRadius: 6, border: 'none', fontSize: 14, cursor: 'pointer' }}>
          {submitting ? 'Creating...' : 'Create client'}
        </button>
      </form>
    </div>
  )
}
