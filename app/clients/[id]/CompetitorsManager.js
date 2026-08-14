'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

const SOURCE_LABEL = {
  ai_citation: 'AI citation',
  ahrefs: 'Ahrefs',
  manual: 'manual'
}

export default function CompetitorsManager({ clientId, competitors, clientDomain = null, bare = false }) {
  const router = useRouter()
  const [showInactive, setShowInactive] = useState(false)
  const [domainInput, setDomainInput] = useState('')
  const [nameInput, setNameInput] = useState('')
  const [adding, setAdding] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)

  const all = competitors || []
  const active = all.filter(c => c.active !== false)
  const inactive = all.filter(c => c.active === false)
  const visible = showInactive ? all : active

  async function addCompetitor(e) {
    e.preventDefault()
    const domain = domainInput.trim()
    if (!domain) return
    setAdding(true)
    setError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/competitors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, name: nameInput.trim() || undefined })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not add competitor')
      setDomainInput('')
      setNameInput('')
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setAdding(false)
    }
  }

  async function toggleActive(competitor) {
    setBusyId(competitor.id)
    setError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/competitors`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ competitorId: competitor.id, active: competitor.active === false })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Update failed')
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className={bare ? undefined : 'card'} style={bare ? undefined : { padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>Tracked competitors</div>
        <span className="pill pill-tracked" style={{ marginLeft: 'auto' }}>
          {active.length} active
        </span>
      </div>
      <p className="text-small text-muted" style={{ margin: '0 0 12px' }}>
        Auto-detected from AI-citation "cited instead" data and Ahrefs organic-keyword overlap on every audit -- at least 2 active competitors are needed for this pillar to grade. Add one by hand below if you know of a competitor that hasn't shown up yet.
      </p>

      {(clientDomain || visible.length > 0) && (
        <div style={{ display: 'grid', gap: 6, marginBottom: 14 }}>
          {/* "This is you" row -- rendered as a plain row in the SAME list
              as everyone else (like a search-results list, per direct
              feedback -- a separate callout box read as disconnected from
              "the list"), not a distinct box above it. Your own domain is
              still deliberately excluded from the tracked-competitor tally
              itself (see lib/competitorDetection.js's self-domain matching)
              so it never inflates the win/loss score against itself, but
              this way it reads as "here's where you sit, for reference,"
              not "silently removed with no explanation." Display-only --
              not a client_competitors row, nothing to toggle or delete. */}
          {clientDomain && (
            <div className="text-small" style={{ padding: '8px 10px', background: 'var(--bg-alt)', borderRadius: 'var(--radius-sm)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontWeight: 600 }}>{clientDomain}</span>
                <span className="pill pill-you">This is you</span>
                <span className="text-tiny text-muted" style={{ marginLeft: 'auto' }}>Excluded from the competitor tally below</span>
              </div>
            </div>
          )}
          {visible.map(c => (
            <div key={c.id} className="text-small" style={{
              padding: '8px 10px', background: 'var(--bg-alt)', borderRadius: 'var(--radius-sm)',
              opacity: c.active === false ? 0.55 : 1
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontWeight: 600 }}>{c.name || c.domain}</span>
                {c.name && <span className="text-muted">({c.domain})</span>}
                <span className="pill pill-lead" style={{ textTransform: 'none' }}>{SOURCE_LABEL[c.source] || c.source}</span>
                {c.active === false && <span className="pill pill-lead">deactivated</span>}
                <button
                  type="button"
                  onClick={() => toggleActive(c)}
                  disabled={busyId === c.id}
                  className="btn btn-secondary"
                  style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: 12 }}
                >
                  {busyId === c.id ? '...' : c.active === false ? 'Reactivate' : 'Deactivate'}
                </button>
              </div>
              {c.detection_note && (
                <p className="text-tiny text-muted" style={{ margin: '6px 0 0' }}>
                  ⚠ {c.detection_note}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {visible.length === 0 && (
        <p className="text-small text-muted" style={{ margin: '0 0 14px' }}>No competitors detected yet -- they'll appear here as audits run, or add one manually below.</p>
      )}

      {inactive.length > 0 && (
        <button
          type="button"
          onClick={() => setShowInactive(s => !s)}
          className="btn btn-secondary"
          style={{ fontSize: 12, padding: '4px 10px', marginBottom: 14 }}
        >
          {showInactive ? 'Hide deactivated' : `Show ${inactive.length} deactivated`}
        </button>
      )}

      <form onSubmit={addCompetitor} style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <input
          className="field-input"
          style={{ marginBottom: 0, flex: '2 1 200px' }}
          placeholder="Competitor domain (e.g. rival.com)"
          value={domainInput}
          onChange={e => setDomainInput(e.target.value)}
        />
        <input
          className="field-input"
          style={{ marginBottom: 0, flex: '1 1 140px' }}
          placeholder="Name (optional)"
          value={nameInput}
          onChange={e => setNameInput(e.target.value)}
        />
        <button type="submit" disabled={adding || !domainInput.trim()} className="btn btn-primary">
          {adding ? 'Adding...' : 'Add competitor'}
        </button>
      </form>

      {error && <p className="field-error" style={{ marginTop: 12 }}>{error}</p>}
    </div>
  )
}
