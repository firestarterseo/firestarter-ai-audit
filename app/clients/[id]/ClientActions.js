'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// Two small account-management actions that had no UI before now: moving a
// client between 'lead' (one-off snapshot mode) and 'tracked' (recurring
// weekly history via the cron job -- see lib/trackAiVisibility.js), and
// deleting a client entirely. Before this, both required a direct SQL
// statement against Supabase -- fine for one client during development,
// not something to keep doing by hand going forward.
export default function ClientActions({ clientId, status }) {
  const router = useRouter()
  const [updating, setUpdating] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState(null)

  const otherStatus = status === 'tracked' ? 'lead' : 'tracked'

  async function toggleStatus() {
    setUpdating(true)
    setError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: otherStatus })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not update status')
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setUpdating(false)
    }
  }

  async function onDelete() {
    // Deleting a client cascades to every audit_runs / pillar_scores /
    // ai_visibility_tracked_runs row for them (confirmed via the DB's own
    // ON DELETE CASCADE foreign keys) -- genuinely irreversible, so this is
    // the one place in the dashboard that asks for an explicit confirm
    // before doing anything.
    const confirmed = window.confirm(
      'Delete this client permanently? This also deletes all of their audit history and AI-visibility tracking data. This cannot be undone.'
    )
    if (!confirmed) return

    setDeleting(true)
    setError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not delete client')
      router.push('/clients')
    } catch (err) {
      setError(err.message)
      setDeleting(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={toggleStatus} disabled={updating || deleting} className="btn btn-secondary" style={{ padding: '8px 14px', fontSize: 12 }}>
          {updating ? 'Updating...' : `Mark as ${otherStatus}`}
        </button>
        <button onClick={onDelete} disabled={updating || deleting} className="btn btn-secondary" style={{ padding: '8px 14px', fontSize: 12, color: 'var(--red)', borderColor: 'var(--red)' }}>
          {deleting ? 'Deleting...' : 'Delete client'}
        </button>
      </div>
      {error && <p className="field-error" style={{ margin: 0, fontSize: 12 }}>{error}</p>}
    </div>
  )
}
