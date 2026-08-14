'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// Renders the durable `opportunities` rows (see lib/opportunities.js) --
// v1 only ever contains content_brief rows sourced from Competitive
// Position's missing-keyword opportunities, synced on every audit run.
// This is the first concrete piece of the "audit -> execution"
// architecture in ROADMAP.md: these used to be a single sentence buried
// inside a collapsed "Raw technical details" panel; now each one is a
// trackable row a strategist can move through Open -> In progress -> Done,
// or dismiss, and status persists across future audit runs instead of
// being silently recomputed every time.

const STATUS_LABEL = { open: 'Open', in_progress: 'In progress', done: 'Done', dismissed: 'Dismissed' }
const STATUS_ORDER = ['open', 'in_progress', 'done', 'dismissed']
const FUNNEL_LABEL = { informational: 'Informational', commercial: 'Commercial', transactional: 'Transactional' }
// realistic_tier now has a third value, 'citation_target' (added
// 2026-08-15 alongside serp_landscape -- see lib/keywordRelevance.js):
// this term's real Google-SERP top results are large media/reference
// publishers, not peer businesses, so the realistic play is earning a
// citation/mention inside that publisher's content, not writing a page
// to out-rank it. Distinct color from "aspirational" -- it isn't a
// harder version of the same content play, it's a different play
// entirely.
const TIER_LABEL = { near_term: 'Realistic near-term', aspirational: 'Aspirational', citation_target: 'Citation target, not a ranking play' }
const TIER_COLOR = { near_term: 'var(--grade-a)', aspirational: 'var(--grade-d)', citation_target: 'var(--grade-c)' }
const SERP_LANDSCAPE_LABEL = { peer_agency_competitive: 'SERP: peer agencies', publisher_dominated: 'SERP: publisher-dominated', mixed: 'SERP: mixed' }

function formatVolume(v) {
  if (typeof v !== 'number') return null
  return v >= 1000 ? `~${Math.round(v / 100) / 10}k/mo` : `~${v}/mo`
}

export default function OpportunitiesManager({ clientId, opportunities, bare = false }) {
  const router = useRouter()
  const [showClosed, setShowClosed] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)

  const all = opportunities || []
  const open = all.filter(o => o.status === 'open' || o.status === 'in_progress')
  const closed = all.filter(o => o.status === 'done' || o.status === 'dismissed')
  const visible = showClosed ? all : open

  async function setStatus(opportunity, status) {
    setBusyId(opportunity.id)
    setError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/opportunities`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opportunityId: opportunity.id, status })
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

  // Nothing to show yet -- e.g. the first audit hasn't run, or this
  // client currently has zero detected keyword gaps -- render nothing
  // rather than an empty card competing for attention with
  // CompetitorsManager above it.
  if (all.length === 0) return null

  return (
    <div className={bare ? undefined : 'card'} style={bare ? undefined : { padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>Keyword opportunities to close</div>
        <span className="pill pill-tracked" style={{ marginLeft: 'auto' }}>{open.length} open</span>
      </div>
      <p className="text-small text-muted" style={{ margin: '0 0 12px' }}>
        Specific, real keyword gaps a tracked competitor already ranks well for, ranked by search volume -- diffed from the Competitive Position pillar above and checked against live Google results for who's actually holding the top spots. A &ldquo;citation target&rdquo; tag means the real SERP is dominated by large media/reference publishers, not a peer competitor -- the realistic move there is earning a mention inside that publisher's content, not writing a page to out-rank it. Move each through Open &rarr; In progress &rarr; Done as you brief/pursue it, or dismiss one that isn't worth pursuing. A gap the tool no longer detects (the client starts ranking, or the competitor drops off) closes itself automatically on the next audit -- you'll never need to clean these up by hand.
      </p>

      <div style={{ display: 'grid', gap: 6, marginBottom: 14 }}>
        {visible.map(o => (
          <div key={o.id} className="text-small" style={{
            padding: '8px 10px', background: 'var(--bg-alt)', borderRadius: 'var(--radius-sm)',
            opacity: (o.status === 'done' || o.status === 'dismissed') ? 0.55 : 1
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600 }}>&ldquo;{o.title}&rdquo;</span>
              {formatVolume(o.detail?.volume) && <span className="text-muted">{formatVolume(o.detail.volume)}</span>}
              {o.detail?.competitorDomain && (
                <span className="text-tiny text-muted">{o.detail.competitorDomain} ranks #{o.detail.competitorPosition}</span>
              )}
              <span className="pill pill-lead" style={{ textTransform: 'none', marginLeft: 'auto' }}>{STATUS_LABEL[o.status] || o.status}</span>
            </div>
            {/* Only present once lib/keywordRelevance.js's Anthropic
                refinement has actually run for this row (o.detail.realisticTier
                is undefined otherwise -- rows synced before that was wired
                in, or a run where the call failed, degrade gracefully to
                just the raw keyword/volume/competitor line above). */}
            {(o.detail?.funnelStage || o.detail?.realisticTier) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                {o.detail?.realisticTier && (
                  <span className="text-tiny" style={{ fontWeight: 600, color: TIER_COLOR[o.detail.realisticTier] || 'var(--text)' }}>
                    {TIER_LABEL[o.detail.realisticTier] || o.detail.realisticTier}
                  </span>
                )}
                {o.detail?.funnelStage && (
                  <span className="text-tiny text-muted">{FUNNEL_LABEL[o.detail.funnelStage] || o.detail.funnelStage}</span>
                )}
                {/* Only rendered for peer_agency_competitive/publisher_dominated/
                    mixed -- 'unknown' (the Cloro SERP check wasn't available
                    for this keyword) intentionally shows no badge rather than
                    a confusing "SERP: unknown" pill. */}
                {SERP_LANDSCAPE_LABEL[o.detail?.serpLandscape] && (
                  <span className="text-tiny text-muted">{SERP_LANDSCAPE_LABEL[o.detail.serpLandscape]}</span>
                )}
                {o.detail?.suggestedLocalVariant && (
                  <span className="text-tiny text-muted">try instead: &ldquo;{o.detail.suggestedLocalVariant}&rdquo;</span>
                )}
              </div>
            )}
            {(o.detail?.tierReason || o.detail?.relevanceReason) && (
              <p className="text-tiny text-muted" style={{ margin: '4px 0 0' }}>
                {o.detail.relevanceReason || o.detail.tierReason}
              </p>
            )}
            {/* Real evidence backing the serpLandscape judgment above --
                the actual live top-5 Google-SERP domains for this exact
                keyword (lib/serpLandscape.js), so a strategist can verify
                the "publisher-dominated" call rather than take it on
                faith. */}
            {Array.isArray(o.detail?.serpTopDomains) && o.detail.serpTopDomains.length > 0 && (
              <p className="text-tiny text-muted" style={{ margin: '4px 0 0' }}>
                Currently ranking: {o.detail.serpTopDomains.join(', ')}
              </p>
            )}
            {o.detail?.resolved_reason && (
              <p className="text-tiny text-muted" style={{ margin: '6px 0 0' }}>
                Auto-closed -- no longer detected as a gap on the most recent audit.
              </p>
            )}
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              {STATUS_ORDER.filter(s => s !== o.status).map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(o, s)}
                  disabled={busyId === o.id}
                  className="btn btn-secondary"
                  style={{ padding: '4px 10px', fontSize: 12 }}
                >
                  {busyId === o.id ? '...' : `Mark ${STATUS_LABEL[s].toLowerCase()}`}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {visible.length === 0 && (
        <p className="text-small text-muted" style={{ margin: '0 0 14px' }}>Nothing open right now -- everything's either done, dismissed, or no gaps have been detected yet.</p>
      )}

      {closed.length > 0 && (
        <button
          type="button"
          onClick={() => setShowClosed(s => !s)}
          className="btn btn-secondary"
          style={{ fontSize: 12, padding: '4px 10px' }}
        >
          {showClosed ? 'Hide done/dismissed' : `Show ${closed.length} done/dismissed`}
        </button>
      )}

      {error && <p className="field-error" style={{ marginTop: 12 }}>{error}</p>}
    </div>
  )
}
