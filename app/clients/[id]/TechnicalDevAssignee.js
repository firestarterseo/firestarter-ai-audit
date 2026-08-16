'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// Per-client "default developer" for Technical Foundation fix work -- ports
// the mockup's assign-row (#pane-technical's "Fix detail" step) as plain
// client data, nothing more. Scope explicitly cut down from what the
// mockup showed: the mockup's assign-row also had a due date and a
// "Create Asana task" button/status card, and this repo has zero real
// Asana integration today (confirmed by a full grep of the codebase) even
// though this session happens to have live Asana workspace access -- wiring
// that up for real would create real tasks in a real workspace, which is a
// separate decision, not something to fold into "the default-dev field."
// This component only ever writes clients.default_dev via a plain PATCH;
// nothing here calls Asana or creates a task anywhere.
//
// The option list is the same 6 names the mockup used in both its
// Technical Foundation and Content Authority assign-rows (Hamza Khan,
// Francine Gautier, Jeff, Kyle Carney, Leo Resplandor, Skyler Malley) --
// there's no real team/roster table in this DB to source it from instead,
// so it's a small hardcoded constant here rather than an invented one;
// update DEV_OPTIONS directly if the team roster changes.
const DEV_OPTIONS = ['Hamza Khan', 'Francine Gautier', 'Jeff', 'Kyle Carney', 'Leo Resplandor', 'Skyler Malley']

export default function TechnicalDevAssignee({ clientId, defaultDev }) {
  const router = useRouter()
  const [value, setValue] = useState(defaultDev || '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  const dirty = (value || '') !== (defaultDev || '')

  async function save() {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_dev: value })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not save default developer')
      setSaved(true)
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
      <div className="assign-field">
        <label htmlFor="tech-default-dev" style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--muted-2)', textTransform: 'uppercase', letterSpacing: 0.3, display: 'block', marginBottom: 4 }}>
          Default developer for this client
        </label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            id="tech-default-dev"
            value={value}
            onChange={e => { setValue(e.target.value); setSaved(false) }}
            style={{ fontSize: 12.5, padding: '6px 10px', border: '1px solid var(--border-strong)', borderRadius: 6, background: '#fff', color: 'var(--text)', minWidth: 200 }}
          >
            <option value="">-- none set --</option>
            {DEV_OPTIONS.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
          <button
            className="btn btn-secondary"
            style={{ padding: '6px 14px', fontSize: 12 }}
            onClick={save}
            disabled={!dirty || saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          {saved && !dirty && <span className="text-tiny" style={{ color: 'var(--grade-a)' }}>Saved</span>}
        </div>
        <p className="text-tiny text-muted" style={{ margin: '6px 0 0', maxWidth: 460 }}>
          This is a plain note on the client, not a task assignment -- there's no Asana (or other task-tracker) integration in this tool yet, so nothing gets created or notified when you set this.
        </p>
        {error && <p className="field-error" style={{ margin: '6px 0 0', fontSize: 12 }}>{error}</p>}
      </div>
    </div>
  )
}
