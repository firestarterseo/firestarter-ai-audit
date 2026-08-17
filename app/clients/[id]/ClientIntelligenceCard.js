'use client'

// Phase 1b -- Client / Industry Intelligence AM review surface.
//
// Interaction philosophy (per the approved spec): SYSTEM RESEARCHES ->
// SYSTEM PRESENTS -> AM REVIEWS -> AM CORRECTS ONLY WHEN NEEDED. This is
// deliberately NOT another audit-pillar wizard with a grade badge and a
// pile of recommendations -- it's shared context infrastructure other
// pillars will read from (getClientIndustryProfile). The primary view
// stays a compact "here's what we detected" summary; evidence is a
// drill-down (<details>), not always expanded; nothing here blocks the AM
// from leaving the page without confirming anything.

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'

const FIELD_ORDER = [
  'business_model',
  'industry',
  'vertical_subindustry',
  'specialty',
  'primary_products_services',
  'secondary_products_services',
  'primary_customer_use_case',
  'primary_geography_markets'
]

const LIST_FIELDS = new Set(['primary_products_services', 'secondary_products_services', 'primary_geography_markets'])

// Phase 1b completion fix (2026-08-17) -- must match
// lib/clientIndustryIntelligence.js's STALE_ITEM_REMOVAL_SENTINEL exactly.
// Duplicated here (not imported) because that module is server-only
// (pulls in lib/supabaseServer.js) and this is a Client Component -- see
// that file's own note on this same duplication.
const STALE_ITEM_REMOVAL_SENTINEL = '__phase1b_no_longer_detected__'

const FIELD_LABELS = {
  business_model: 'Business Model',
  industry: 'Industry',
  vertical_subindustry: 'Vertical / Subindustry',
  specialty: 'Specialty',
  primary_products_services: 'Primary Products/Services',
  secondary_products_services: 'Secondary Products/Services',
  primary_customer_use_case: 'Primary Customer / Use Case',
  primary_geography_markets: 'Primary Geography / Markets'
}

const CONFIDENCE_LABEL = {
  confirmed_by_direct_evidence: 'Direct evidence',
  likely: 'Likely',
  uncertain: 'Uncertain'
}
const CONFIDENCE_STYLE = {
  confirmed_by_direct_evidence: { background: '#dcfce7', color: '#166534' },
  likely: { background: '#dbeafe', color: '#1e40af' },
  uncertain: { background: '#fef3c7', color: '#92400e' }
}

const STATUS_LABEL = {
  unconfirmed: 'Unconfirmed',
  confirmed: 'Confirmed',
  overridden: 'Overridden by AM',
  stale_recommendation_pending: 'Needs review',
  legacy_unconfirmed_category: 'Legacy category'
}
const STATUS_STYLE = {
  unconfirmed: { background: '#f3f4f6', color: '#4b5563' },
  confirmed: { background: '#dbeafe', color: '#1e40af' },
  overridden: { background: '#dcfce7', color: '#166534' },
  stale_recommendation_pending: { background: '#fee2e2', color: '#991b1b' },
  legacy_unconfirmed_category: { background: '#fef3c7', color: '#92400e' }
}

function Badge({ label, style }) {
  return <span className="pill" style={{ ...style, textTransform: 'none' }}>{label}</span>
}

// A single field/item slot -- scalar fields render one of these; list
// fields render one per item (plus an empty state when the list is empty).
function FieldSlot({ fieldKey, itemIndex, field, recommendation, clientId, onChanged, setError }) {
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [overrideValue, setOverrideValue] = useState(field?.value || '')

  async function callAction(payload) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/profile-fields`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error || 'Action failed')
      onChanged(data.profile)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const hasValue = field && field.value != null
  const status = field?.confirmationStatus || null

  return (
    <div className="text-small" style={{ padding: '10px 12px', background: 'var(--bg-alt)', borderRadius: 'var(--radius-sm)', marginBottom: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>
          {hasValue ? field.value : <span className="text-muted">Not detected</span>}
        </span>
        {field?.confidence && <Badge label={CONFIDENCE_LABEL[field.confidence] || field.confidence} style={CONFIDENCE_STYLE[field.confidence]} />}
        {status && <Badge label={STATUS_LABEL[status] || status} style={STATUS_STYLE[status] || {}} />}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {status === 'unconfirmed' && hasValue && (
            <button type="button" className="btn btn-secondary" disabled={busy} style={{ fontSize: 11, padding: '3px 8px' }}
              onClick={() => callAction({ action: 'confirm', fieldKey, itemIndex })}>
              {busy ? '...' : 'Confirm'}
            </button>
          )}
          {status !== 'stale_recommendation_pending' && (
            <button type="button" className="btn btn-secondary" disabled={busy} style={{ fontSize: 11, padding: '3px 8px' }}
              onClick={() => setEditing(e => !e)}>
              {editing ? 'Cancel' : 'Edit'}
            </button>
          )}
        </div>
      </div>

      {editing && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input
            className="field-input"
            style={{ marginBottom: 0, flex: 1 }}
            value={overrideValue}
            onChange={e => setOverrideValue(e.target.value)}
            placeholder="Enter the correct value"
          />
          <button type="button" className="btn btn-primary" disabled={busy || !overrideValue.trim()} style={{ fontSize: 12 }}
            onClick={async () => { await callAction({ action: 'override', fieldKey, itemIndex, value: overrideValue.trim() }); setEditing(false) }}>
            {busy ? 'Saving...' : 'Save override'}
          </button>
        </div>
      )}

      {recommendation && recommendation.recommended_value === STALE_ITEM_REMOVAL_SENTINEL ? (
        // Phase 1b completion fix -- this item was previously confirmed/
        // overridden but the most recent classification pass no longer
        // detected it. Never rendered as a "new value suggested" -- there
        // is no new value, just an absence. "Remove" clears it (history
        // still keeps the old value); "Keep" dismisses the flag exactly
        // like any other recommendation, leaving this item exactly as-is.
        <div style={{ marginTop: 8, padding: '8px 10px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 'var(--radius-sm)' }}>
          <div className="text-small" style={{ marginBottom: 6, color: '#9a3412' }}>
            Not detected in the most recent classification pass.
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn btn-secondary" disabled={busy} style={{ fontSize: 11, padding: '3px 8px' }}
              onClick={() => callAction({ action: 'remove_stale_item', recommendationId: recommendation.id })}>
              Remove
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} style={{ fontSize: 11, padding: '3px 8px' }}
              onClick={() => callAction({ action: 'dismiss_recommendation', recommendationId: recommendation.id })}>
              Keep it
            </button>
          </div>
        </div>
      ) : recommendation && (
        <div style={{ marginTop: 8, padding: '8px 10px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 'var(--radius-sm)' }}>
          <div className="text-tiny" style={{ fontWeight: 600, color: '#9a3412', marginBottom: 4 }}>
            New evidence suggests a different value:
          </div>
          <div className="text-small" style={{ marginBottom: 6 }}>
            <strong>{recommendation.recommended_value}</strong>{' '}
            <span className="text-tiny text-muted">({CONFIDENCE_LABEL[recommendation.recommended_confidence] || recommendation.recommended_confidence})</span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn btn-primary" disabled={busy} style={{ fontSize: 11, padding: '3px 8px' }}
              onClick={() => callAction({ action: 'accept_recommendation', recommendationId: recommendation.id })}>
              Accept recommendation
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} style={{ fontSize: 11, padding: '3px 8px' }}
              onClick={() => callAction({ action: 'dismiss_recommendation', recommendationId: recommendation.id })}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {hasValue && Array.isArray(field.evidence) && field.evidence.length > 0 && (
        <details style={{ marginTop: 6 }}>
          <summary className="text-tiny text-muted" style={{ cursor: 'pointer' }}>Why this value?</summary>
          <ul className="text-tiny text-muted" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {field.evidence.map((e, i) => <li key={i}>{typeof e === 'string' ? e : (e.text || JSON.stringify(e))}</li>)}
          </ul>
        </details>
      )}
    </div>
  )
}

function recommendationForSlot(recommendations, fieldKey, itemIndex) {
  return (recommendations || []).find(r => r.field_key === fieldKey && r.item_index === itemIndex) || null
}

export default function ClientIntelligenceCard({ clientId, initialProfile }) {
  const router = useRouter()
  const [profile, setProfile] = useState(initialProfile)
  const [expanded, setExpanded] = useState(false)
  const [classifying, setClassifying] = useState(false)
  const [confirmingAll, setConfirmingAll] = useState(false)
  const [error, setError] = useState(null)
  const autoFired = useRef(false)

  function onChanged(newProfile) {
    if (newProfile) setProfile(newProfile)
    router.refresh()
  }

  async function runClassify() {
    setClassifying(true)
    setError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false })
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error?.message || 'Classification could not complete right now.')
      if (data.profile) setProfile(data.profile)
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setClassifying(false)
    }
  }

  // Automatic-first: a client with zero profile data yet and nothing
  // pending gets classified once, with no AM action required to kick it
  // off -- the normal experience is "here's what we detected" from the
  // first page load, not an empty form. Guarded by a ref (not just state)
  // so React 19's dev-mode double-effect invocation can't fire this twice.
  useEffect(() => {
    if (autoFired.current) return
    if (profile && !profile.hasAnyProfileData && (!profile.openRecommendations || profile.openRecommendations.length === 0)) {
      autoFired.current = true
      runClassify()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function confirmAll() {
    setConfirmingAll(true)
    setError(null)
    try {
      const slots = []
      for (const fieldKey of FIELD_ORDER) {
        if (LIST_FIELDS.has(fieldKey)) {
          (profile[camel(fieldKey)] || []).forEach(item => {
            if (item.confirmationStatus === 'unconfirmed' && item.value != null) slots.push({ fieldKey, itemIndex: item.itemIndex })
          })
        } else {
          const field = profile[camel(fieldKey)]
          if (field && field.confirmationStatus === 'unconfirmed' && field.value != null) slots.push({ fieldKey, itemIndex: 0 })
        }
      }
      let latestProfile = profile
      for (const slot of slots) {
        const res = await fetch(`/api/clients/${clientId}/profile-fields`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'confirm', ...slot })
        })
        const data = await res.json()
        if (res.ok && data.profile) latestProfile = data.profile
      }
      setProfile(latestProfile)
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setConfirmingAll(false)
    }
  }

  if (!profile) return null

  const pendingCount = (profile.openRecommendations || []).length
  const anyUnconfirmed = FIELD_ORDER.some(fieldKey => {
    if (LIST_FIELDS.has(fieldKey)) return (profile[camel(fieldKey)] || []).some(i => i.confirmationStatus === 'unconfirmed' && i.value != null)
    const field = profile[camel(fieldKey)]
    return field && field.confirmationStatus === 'unconfirmed' && field.value != null
  })

  return (
    <div className="card" style={{ padding: 18, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Detected Business Context</div>
          <div className="text-small" style={{ marginTop: 2 }}>
            {profile.summary || <span className="text-muted">Not classified yet.</span>}
          </div>
        </div>
        {pendingCount > 0 && <Badge label={`${pendingCount} needs review`} style={STATUS_STYLE.stale_recommendation_pending} />}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {anyUnconfirmed && (
            <button type="button" className="btn btn-secondary" disabled={confirmingAll} style={{ fontSize: 12 }} onClick={confirmAll}>
              {confirmingAll ? 'Confirming...' : 'Confirm all'}
            </button>
          )}
          <button type="button" className="btn btn-secondary" disabled={classifying} style={{ fontSize: 12 }} onClick={runClassify}>
            {classifying ? 'Detecting...' : 'Re-detect'}
          </button>
          <button type="button" className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => setExpanded(e => !e)}>
            {expanded ? 'Hide details' : 'Show details'}
          </button>
        </div>
      </div>

      {error && <p className="field-error" style={{ marginTop: 10 }}>{error}</p>}

      {expanded && (
        <div style={{ marginTop: 14 }}>
          {FIELD_ORDER.map(fieldKey => (
            <div key={fieldKey} style={{ marginBottom: 12 }}>
              <div className="text-tiny text-muted" style={{ fontWeight: 600, letterSpacing: 0.5, marginBottom: 4, textTransform: 'uppercase' }}>
                {FIELD_LABELS[fieldKey]}
              </div>
              {LIST_FIELDS.has(fieldKey) ? (
                (profile[camel(fieldKey)] || []).length > 0
                  ? profile[camel(fieldKey)].map(item => (
                    <FieldSlot
                      key={`${fieldKey}:${item.itemIndex}`}
                      fieldKey={fieldKey}
                      itemIndex={item.itemIndex}
                      field={item}
                      recommendation={recommendationForSlot(profile.openRecommendations, fieldKey, item.itemIndex)}
                      clientId={clientId}
                      onChanged={onChanged}
                      setError={setError}
                    />
                  ))
                  : <FieldSlot fieldKey={fieldKey} itemIndex={0} field={null} recommendation={null} clientId={clientId} onChanged={onChanged} setError={setError} />
              ) : (
                <FieldSlot
                  fieldKey={fieldKey}
                  itemIndex={0}
                  field={profile[camel(fieldKey)]}
                  recommendation={recommendationForSlot(profile.openRecommendations, fieldKey, 0)}
                  clientId={clientId}
                  onChanged={onChanged}
                  setError={setError}
                />
              )}
            </div>
          ))}
          {profile.legacyCategory && profile.industry?.isLegacyCategoryFallback && (
            <p className="text-tiny text-muted" style={{ marginTop: 4 }}>
              "{profile.legacyCategory}" is the client's original category field, shown here only because no real Industry classification exists yet -- not an AM-confirmed value.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function camel(fieldKey) {
  return fieldKey.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}
