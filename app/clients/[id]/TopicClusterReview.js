'use client'

// Phase 2 -- Prompt & Topic Intelligence AM review surface.
//
// Interaction philosophy (same as ClientIntelligenceCard.js's Phase 1b
// pattern, and per the approved Phase 2 spec): SYSTEM RECOMMENDS -> AM
// REVIEWS -> AM APPROVES/EDITS/REJECTS. This is deliberately NOT another
// scored audit-pillar wizard -- it's "Recommended Topics to Track" cards,
// collapsed evidence, one clear primary action per card. Nothing here
// auto-promotes a candidate into the benchmark; that is always an explicit
// AM click.

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'

const INTENT_LABELS = {
  recommendation: 'Recommendation',
  comparison: 'Comparison',
  provider_vendor_selection: 'Provider/Vendor Selection',
  product_service_selection: 'Product/Service Selection',
  problem_solution: 'Problem/Solution',
  informational: 'Informational',
  local_near_me: 'Local / Near Me',
  reputation_trust: 'Reputation/Trust',
  cost_pricing: 'Cost/Pricing',
  expertise_qualification: 'Expertise/Qualification',
  other: 'Other'
}
const BUYER_JOURNEY_LABELS = {
  discover: 'Discover',
  evaluate: 'Evaluate',
  validate: 'Validate',
  select: 'Select',
  problem_solution: 'Problem/Solution'
}
const BRAND_MODE_LABELS = {
  unbranded: 'Unbranded',
  brand_aware: 'Brand-aware',
  competitor_comparison: 'Competitor comparison'
}
const STATUS_STYLE = {
  benchmark: { background: '#dcfce7', color: '#166534' },
  candidate: { background: '#fef3c7', color: '#92400e' },
  retired: { background: '#f3f4f6', color: '#4b5563' }
}
const STATUS_LABEL = { benchmark: 'In Benchmark', candidate: 'Needs Review', retired: 'Retired / Rejected' }

function Badge({ label, style }) {
  return <span className="pill" style={{ ...style, textTransform: 'none' }}>{label}</span>
}

async function callAction(clientId, payload) {
  const res = await fetch(`/api/clients/${clientId}/topic-clusters/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  const data = await res.json()
  if (!res.ok || data.error) throw new Error(data.error || 'Action failed')
  return data.clusters
}

function VariationRow({ clientId, variation, onChanged, setError }) {
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [promptText, setPromptText] = useState(variation.prompt_text)

  async function run(payload) {
    setBusy(true)
    setError(null)
    try {
      const clusters = await callAction(clientId, payload)
      onChanged(clusters)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const isRejectable = variation.status === 'candidate' || variation.status === 'active'

  return (
    <div className="text-small" style={{ padding: '8px 10px', background: 'var(--bg-alt)', borderRadius: 'var(--radius-sm)', marginBottom: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Badge label={variation.variation_type === 'core' ? 'CORE' : 'secondary'} style={variation.variation_type === 'core' ? { background: '#dbeafe', color: '#1e40af' } : { background: '#f3f4f6', color: '#4b5563' }} />
        <span style={{ fontWeight: 600 }}>&ldquo;{variation.prompt_text}&rdquo;</span>
        <Badge label={BRAND_MODE_LABELS[variation.brand_mode] || variation.brand_mode} />
        {variation.status !== 'active' && variation.status !== 'candidate' && <Badge label={variation.status} style={{ background: '#f3f4f6', color: '#4b5563' }} />}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button type="button" className="btn btn-secondary" disabled={busy} style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => setEditing(e => !e)}>
            {editing ? 'Cancel' : 'Edit'}
          </button>
          {isRejectable && (
            <button type="button" className="btn btn-secondary" disabled={busy} style={{ fontSize: 11, padding: '3px 8px' }}
              onClick={() => run({ action: 'reject_variation', variationId: variation.id, reason: 'Rejected by AM.' })}>
              Reject
            </button>
          )}
        </div>
      </div>
      <div className="text-tiny text-muted" style={{ marginTop: 4 }}>
        {variation.intent_primary && `Intent: ${INTENT_LABELS[variation.intent_primary] || variation.intent_primary}`}
        {variation.buyer_journey_primary && ` · Journey: ${BUYER_JOURNEY_LABELS[variation.buyer_journey_primary] || variation.buyer_journey_primary}`}
      </div>
      {editing && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input className="field-input" style={{ marginBottom: 0, flex: 1 }} value={promptText} onChange={e => setPromptText(e.target.value)} />
          <button type="button" className="btn btn-primary" disabled={busy || !promptText.trim()} style={{ fontSize: 12 }}
            onClick={async () => { await run({ action: 'edit_variation', variationId: variation.id, promptText: promptText.trim() }); setEditing(false) }}>
            {busy ? 'Saving...' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}

function ClusterCard({ clientId, cluster, onChanged, setError }) {
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [editingHeader, setEditingHeader] = useState(false)
  const [name, setName] = useState(cluster.name)
  const [whyItMatters, setWhyItMatters] = useState(cluster.why_it_matters || '')

  async function run(payload) {
    setBusy(true)
    setError(null)
    try {
      const clusters = await callAction(clientId, payload)
      onChanged(clusters)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const core = cluster.variations.find(v => v.variation_type === 'core')
  const secondaryCount = cluster.variations.filter(v => v.variation_type === 'secondary' && v.status !== 'rejected' && v.status !== 'retired').length
  const isCandidate = cluster.status === 'candidate'
  const isRetired = cluster.status === 'retired'

  return (
    <div className="card" style={{ padding: 16, marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          {editingHeader ? (
            <div style={{ display: 'grid', gap: 6 }}>
              <input className="field-input" style={{ marginBottom: 0 }} value={name} onChange={e => setName(e.target.value)} placeholder="Topic name" />
              <textarea className="field-input" style={{ marginBottom: 0 }} rows={2} value={whyItMatters} onChange={e => setWhyItMatters(e.target.value)} placeholder="Why it matters" />
            </div>
          ) : (
            <>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{cluster.name}</div>
              {cluster.why_it_matters && <div className="text-small text-muted" style={{ marginTop: 2 }}>{cluster.why_it_matters}</div>}
            </>
          )}
          <div className="text-tiny text-muted" style={{ marginTop: 6 }}>
            {cluster.primary_service && <>Service: <b>{cluster.primary_service}</b> · </>}
            {cluster.geography_scope && <>Geography: {cluster.geography_scope}{cluster.geography_values?.length ? ` (${cluster.geography_values.join(', ')})` : ''} · </>}
            {cluster.discovery_method === 'legacy_migrated' ? 'Legacy migrated' : cluster.discovery_method === 'am_manual' ? 'Added by AM' : 'System discovered'}
          </div>
        </div>

        <Badge label={STATUS_LABEL[cluster.status] || cluster.status} style={STATUS_STYLE[cluster.status]} />
        {cluster.business_priority === 'strategic' && <Badge label="Strategic" style={{ background: '#ede9fe', color: '#5b21b6' }} />}
      </div>

      {core && (
        <div className="text-small" style={{ marginTop: 10, padding: '8px 10px', background: 'var(--bg-alt)', borderRadius: 'var(--radius-sm)' }}>
          Core prompt: <b>&ldquo;{core.prompt_text}&rdquo;</b>
          {secondaryCount > 0 && <span className="text-muted"> · {secondaryCount} secondary variation{secondaryCount === 1 ? '' : 's'}</span>}
        </div>
      )}

      {error => null}

      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        {isCandidate && !editingHeader && (
          <button type="button" className="btn btn-primary" disabled={busy} style={{ fontSize: 12 }}
            onClick={() => run({ action: 'approve_cluster', clusterId: cluster.id })}>
            {busy ? '...' : 'Approve'}
          </button>
        )}
        {isCandidate && (
          editingHeader ? (
            <button type="button" className="btn btn-primary" disabled={busy || !name.trim()} style={{ fontSize: 12 }}
              onClick={async () => { await run({ action: 'edit_cluster', clusterId: cluster.id, name: name.trim(), whyItMatters: whyItMatters.trim() || null }); setEditingHeader(false) }}>
              {busy ? 'Saving...' : 'Save edit'}
            </button>
          ) : (
            <button type="button" className="btn btn-secondary" disabled={busy} style={{ fontSize: 12 }} onClick={() => setEditingHeader(true)}>Edit</button>
          )
        )}
        {isCandidate && !editingHeader && (
          <button type="button" className="btn btn-secondary" disabled={busy} style={{ fontSize: 12 }}
            onClick={() => run({ action: 'reject_cluster', clusterId: cluster.id, reason: 'Rejected by AM.' })}>
            Reject
          </button>
        )}
        {!isRetired && cluster.business_priority_status !== 'confirmed' && cluster.business_priority !== 'strategic' && (
          <button type="button" className="btn btn-secondary" disabled={busy} style={{ fontSize: 12 }}
            onClick={() => run({ action: 'mark_strategic', clusterId: cluster.id })}>
            Mark Strategic
          </button>
        )}
        {!isRetired && cluster.business_priority === 'strategic' && cluster.business_priority_status !== 'confirmed' && (
          <button type="button" className="btn btn-secondary" disabled={busy} style={{ fontSize: 12 }}
            onClick={() => run({ action: 'skip_business_priority', clusterId: cluster.id })}>
            Skip
          </button>
        )}
        <button type="button" className="btn btn-secondary" style={{ fontSize: 12, marginLeft: 'auto' }} onClick={() => setExpanded(e => !e)}>
          {expanded ? 'Hide details' : 'View details'}
        </button>
      </div>

      {expanded && (
        <div style={{ marginTop: 12 }}>
          {cluster.evidence?.length > 0 && (
            <details style={{ marginBottom: 10 }}>
              <summary className="text-tiny text-muted" style={{ cursor: 'pointer' }}>Why this topic? ({cluster.evidence.length} evidence item{cluster.evidence.length === 1 ? '' : 's'})</summary>
              <ul className="text-tiny text-muted" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {cluster.evidence.map((e, i) => <li key={i}>{typeof e === 'string' ? e : `${e.type ? e.type + ': ' : ''}${e.detail || JSON.stringify(e)}`}</li>)}
              </ul>
            </details>
          )}
          <div className="text-tiny text-muted" style={{ fontWeight: 600, letterSpacing: 0.5, marginBottom: 4, textTransform: 'uppercase' }}>Prompt Variations</div>
          {cluster.variations.map(v => (
            <VariationRow key={v.id} clientId={clientId} variation={v} onChanged={onChanged} setError={setError} />
          ))}
          {cluster.retired_reason && (
            <div className="text-tiny text-muted" style={{ marginTop: 6 }}>Retired/rejected reason: {cluster.retired_reason}</div>
          )}
        </div>
      )}
    </div>
  )
}

export default function TopicClusterReview({ clientId, initialClusters, hasBusinessProfile }) {
  const router = useRouter()
  const [clusters, setClusters] = useState(initialClusters || [])
  const [discovering, setDiscovering] = useState(false)
  const [migrating, setMigrating] = useState(false)
  const [error, setError] = useState(null)
  const [lastDiscoveryNote, setLastDiscoveryNote] = useState(null)
  const autoFired = useRef(false)

  function onChanged(newClusters) {
    if (newClusters) setClusters(newClusters)
    router.refresh()
  }

  async function runDiscover() {
    setDiscovering(true)
    setError(null)
    setLastDiscoveryNote(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/topic-clusters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'discover', dryRun: false })
      })
      const data = await res.json()
      if (!data.ok) {
        setLastDiscoveryNote(data.reason === 'no_client_industry_profile'
          ? 'No confirmed business profile yet -- classify this client\'s business context above before discovering topics.'
          : data.error?.message || `Discovery could not complete (${data.reason || 'unknown reason'}).`)
      } else {
        if (data.suppressedCandidates?.length) {
          setLastDiscoveryNote(`${data.suppressedCandidates.length} candidate(s) suppressed -- previously rejected with no materially new evidence since.`)
        }
        const list = await fetch(`/api/clients/${clientId}/topic-clusters`).then(r => r.json())
        setClusters(list.clusters || [])
      }
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setDiscovering(false)
    }
  }

  async function runMigrateLegacy() {
    setMigrating(true)
    setError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/topic-clusters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'migrate_legacy' })
      })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || 'Legacy migration failed')
      const list = await fetch(`/api/clients/${clientId}/topic-clusters`).then(r => r.json())
      setClusters(list.clusters || [])
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setMigrating(false)
    }
  }

  // Initial discovery trigger: a client with a real business profile but
  // zero topic clusters yet gets one discovery pass offered automatically
  // on first load -- "system offers/runs discovery automatically." Fired
  // via a real POST (not dryRun) exactly once per page load, guarded the
  // same ref-based way ClientIntelligenceCard guards its own auto-classify
  // effect against React 19's dev-mode double-invocation.
  useEffect(() => {
    if (autoFired.current) return
    if (hasBusinessProfile && (!clusters || clusters.length === 0)) {
      autoFired.current = true
      runDiscover()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const benchmark = clusters.filter(c => c.status === 'benchmark')
  const candidates = clusters.filter(c => c.status === 'candidate')
  const retired = clusters.filter(c => c.status === 'retired')

  return (
    <div className="card" style={{ padding: 18, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Topic & Prompt Intelligence</div>
          <div className="text-small text-muted" style={{ marginTop: 2 }}>
            {clusters.length === 0
              ? 'No topics tracked yet.'
              : `${benchmark.length} in benchmark · ${candidates.length} awaiting review${retired.length ? ` · ${retired.length} retired/rejected` : ''}`}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-secondary" disabled={migrating} style={{ fontSize: 12 }} onClick={runMigrateLegacy}>
            {migrating ? 'Migrating...' : 'Migrate legacy test terms'}
          </button>
          <button type="button" className="btn btn-secondary" disabled={discovering || !hasBusinessProfile} style={{ fontSize: 12 }} onClick={runDiscover} title={!hasBusinessProfile ? 'Classify this client\'s business context first' : undefined}>
            {discovering ? 'Discovering...' : 'Discover recommended topics'}
          </button>
        </div>
      </div>

      {error && <p className="field-error" style={{ marginTop: 10 }}>{error}</p>}
      {lastDiscoveryNote && <p className="text-small text-muted" style={{ marginTop: 10 }}>{lastDiscoveryNote}</p>}

      {candidates.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="section-label">Recommended Topics to Track</div>
          {candidates.map(c => <ClusterCard key={c.id} clientId={clientId} cluster={c} onChanged={onChanged} setError={setError} />)}
        </div>
      )}

      {benchmark.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="section-label">Benchmark</div>
          {benchmark.map(c => <ClusterCard key={c.id} clientId={clientId} cluster={c} onChanged={onChanged} setError={setError} />)}
        </div>
      )}

      {retired.length > 0 && (
        <details style={{ marginTop: 16 }} className="raw-details">
          <summary>Retired / rejected ({retired.length})</summary>
          <div style={{ marginTop: 8 }}>
            {retired.map(c => <ClusterCard key={c.id} clientId={clientId} cluster={c} onChanged={onChanged} setError={setError} />)}
          </div>
        </details>
      )}
    </div>
  )
}
