'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { StepChips } from './PillarsBoard'
import OpportunityCard from './OpportunityCard'

// AI SOURCE & CITATION PRESENCE -- five-step wizard (added 2026-08-18).
//
// Follows the approved spec's exact five-step conceptual sequence
// (Diagnosis / Source Landscape / Own-Site Citations / Opportunities /
// Execute & Verify) and the same StepChips/mockup-philosophy every other
// wizard in this directory already uses -- NOT a giant generic audit-issue
// table. No score anywhere: Diagnosis is descriptive counts only.
//
// Data model: `landscape` is the already-fetched, already-computed prop
// from lib/sourceCitation.js#getSourceLandscape (a Server Component read --
// client_sources/opportunities rows plus own-site-citation analysis;
// see app/clients/[id]/page.js's ENABLE_SOURCE_CITATION_PILLAR wiring for
// the call site). NOTE (2026-09-01, Phase 1 trace): getSourceLandscape's
// returned opportunities do NOT currently have priorityDimensions/
// statusTrack/preparedWork attached the way this comment previously
// claimed -- see the Phase 1 report's "remaining workflow gaps" for this
// known, not-yet-fixed gap. Rendering this component still makes ZERO
// LLM/API calls on its own; every fetch() below only fires in response to
// an explicit AM click (approve/reject/handoff/verify), never on render or
// step navigation.
//
// Raw evidence stays behind <details> drill-downs throughout, per the
// spec's "keep raw evidence behind drill-down" instruction -- the inline
// view only ever shows source/importance/presence/relationship/
// actionability/provenance.

const STEP_LABELS = ['Diagnosis', 'Source landscape', 'Own-site citations', 'Opportunities', 'Execute & verify']

// EVIDENCE-STRENGTH CORRECTION (2026-08-17): 'appears_in_cited_content' is
// no longer a real status -- it's split into the weaker
// 'ai_response_co_occurrence' (client mentioned in a response that also
// cites this source, but the cited page itself was never confirmed to
// contain the client) and the strong, page-level-verified
// 'appears_in_cited_content_verified' (the actual cited URL was fetched
// and the client was found on it). Never render these as equivalent.
const PRESENCE_LABEL = {
  absent: 'Absent -- no presence observed',
  source_presence_only: 'Source presence only -- AI cites other content',
  ai_response_co_occurrence: 'AI response co-occurrence -- cited page not verified',
  appears_in_cited_content_verified: 'Verified in cited content (page fetched & confirmed)',
  client_owned_page_cited: 'Client-owned page cited',
  unknown: 'Unknown -- no confirmed evidence either way'
}
const PRESENCE_TONE = {
  absent: 'gap', source_presence_only: 'watch', ai_response_co_occurrence: 'watch',
  appears_in_cited_content_verified: 'good',
  client_owned_page_cited: 'good', unknown: 'watch'
}
const IMPORTANCE_TONE = { high: 'good', medium: 'watch', low: null }

function StatPill({ eyebrow, value, desc, tone }) {
  return (
    <div className={`stat-pill${tone ? ` ${tone}` : ''}`}>
      <div className="eyebrow">{eyebrow}</div>
      <div className="v">{value}</div>
      <div className="d">{desc}</div>
    </div>
  )
}

function SourceCard({ source, selected, onSelect }) {
  const importance = source.observed_importance || {}
  const relationshipType = Array.isArray(source.relationship_types) ? source.relationship_types[0] : source.source_type
  const competitorCount = source.competitor_presence_evidence?.competitorDomainsCoCited?.length || 0
  const capability = source.actionability?.executionCapability?.capability

  return (
    <div
      className={`cluster-card${selected ? ' selected' : ''}`}
      onClick={onSelect}
    >
      <div className="name">{source.source_name || source.domain}</div>
      <div className="meta">{source.domain} &middot; {relationshipType}</div>
      <span className={`tag ${PRESENCE_TONE[source.client_presence_status] === 'good' ? 'good' : PRESENCE_TONE[source.client_presence_status] === 'gap' ? 'gap' : 'watch'}`}>
        {PRESENCE_LABEL[source.client_presence_status] || source.client_presence_status}
      </span>
      <div className="kws">
        Observed importance: <b>{importance.level || 'unknown'}</b> &middot; {source.client_specific_observation_count || 0} citation(s)
        {competitorCount > 0 ? ` · ${competitorCount} competitor(s) also cited` : ' · 0 competitors cited (first-mover territory)'}
        {capability && ` · execution: ${capability.toUpperCase()}`}
      </div>
    </div>
  )
}

function SourceDetail({ source }) {
  if (!source) return null
  const importance = source.observed_importance || {}
  return (
    <div className="card" style={{ padding: 18, marginTop: 12 }}>
      <div className="brief-title">{source.source_name || source.domain} ({source.domain})</div>
      <div className="brief-meta">{Array.isArray(source.relationship_types) ? source.relationship_types.join(', ') : source.source_type}</div>
      <p className="text-small" style={{ margin: '10px 0 0' }}><b>Observed importance:</b> {importance.level} -- {importance.reasoning}</p>
      <p className="text-small" style={{ margin: '8px 0 0' }}>
        <b>Client status:</b> {PRESENCE_LABEL[source.client_presence_status] || source.client_presence_status} (confidence: {source.client_presence_confidence})
      </p>
      {source.domain_presence_note && (
        <p className="text-small text-muted" style={{ margin: '6px 0 0' }}>{source.domain_presence_note}</p>
      )}
      {source.page_inspection_summary && source.page_inspection_summary.urlsInspected > 0 && (
        <p className="text-tiny text-muted" style={{ margin: '6px 0 0' }}>
          Cited-page inspection: {source.page_inspection_summary.urlsInspected} URL(s) checked -- {source.page_inspection_summary.verifiedPresentCount} confirmed present, {source.page_inspection_summary.verifiedAbsentCount} confirmed absent, {source.page_inspection_summary.unverifiableCount} unverifiable.
        </p>
      )}
      {source.industry_evidence ? (
        <p className="text-small" style={{ margin: '8px 0 0' }}><b>Industry evidence:</b> {source.industry_evidence.note}</p>
      ) : (
        <p className="text-tiny text-muted" style={{ margin: '8px 0 0' }}>No industry-level evidence available for this source (requires other tracked clients in the same category).</p>
      )}
      <p className="text-small" style={{ margin: '8px 0 0' }}>
        <b>Competitor context (supporting evidence only):</b> {(source.competitor_presence_evidence?.competitorDomainsCoCited || []).join(', ') || 'none observed -- not a qualification requirement'}
      </p>
      <p className="text-tiny text-muted" style={{ margin: '8px 0 0' }}>
        Provenance: {source.provenance?.evidenceProvenance || 'unknown'} evidence, first observed {source.first_observed_at ? new Date(source.first_observed_at).toLocaleDateString() : '--'}, last observed {source.last_observed_at ? new Date(source.last_observed_at).toLocaleDateString() : '--'}.
      </p>

      {Array.isArray(source.client_presence_evidence) && source.client_presence_evidence.length > 0 && (
        <details className="raw-details">
          <summary>Raw AI observation evidence ({source.client_presence_evidence.length} shown, most recent first -- capped per source){source.client_specific_observation_count > source.client_presence_evidence.length ? `; ${source.client_specific_observation_count} total citation(s) recorded` : ''}</summary>
          <ul className="evidence-list">
            {source.client_presence_evidence.map((e, i) => (
              <li key={i}>
                {e.engine && <span><b>{e.engine}</b>{e.runAt ? ` (${new Date(e.runAt).toLocaleDateString()})` : ''}: </span>}
                {e.prompt && <span>&ldquo;{e.prompt}&rdquo; &mdash; </span>}
                {e.responseSnippet || e.note}
              </li>
            ))}
          </ul>
        </details>
      )}
      {Array.isArray(source.raw_citation_urls) && source.raw_citation_urls.length > 0 && (
        <details className="raw-details">
          <summary>Raw cited URLs ({source.raw_citation_urls.length})</summary>
          <ul className="evidence-list">
            {source.raw_citation_urls.map((u, i) => <li key={i} style={{ wordBreak: 'break-all' }}>{u}</li>)}
          </ul>
        </details>
      )}
    </div>
  )
}

const TREATMENT_GROUP_LABEL = {
  highest_impact: 'Highest Impact',
  easy_win: 'Easy Win',
  strength_protect: 'Strength / Protect',
  do_nothing: 'Do Nothing',
  ordinary: 'Other qualified opportunities'
}

export default function SourceCitationWizard({ clientId, landscape }) {
  const router = useRouter()
  const [step, setStep] = useState(1)
  const [selectedDomain, setSelectedDomain] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)
  const [rechecking, setRechecking] = useState(false)

  const sources = landscape?.sources || []
  const opportunities = landscape?.opportunities || []
  const diagnosis = landscape?.diagnosis || {}
  const ownSite = landscape?.ownSiteCitations

  // Explicit, AM-triggered re-check -- the ONLY other place cited-page
  // inspection runs besides a scheduled audit (see the correction's
  // architecture constraint: never fetch on render). Only ever fires on
  // this button click.
  async function runRecheck() {
    setRechecking(true)
    setError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/sources/recheck`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Re-check failed.')
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setRechecking(false)
    }
  }

  const selectedSource = sources.find(s => s.domain === selectedDomain) || sources[0] || null

  async function runLifecycleAction(opportunityId, action, body = {}) {
    setBusyId(opportunityId)
    setError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/opportunities/${opportunityId}/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...body })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Action "${action}" failed.`)
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  const groups = {
    highest_impact: opportunities.filter(o => o.priority_treatment === 'highest_impact' && o.status === 'open'),
    easy_win: opportunities.filter(o => o.priority_treatment === 'easy_win' && o.status === 'open'),
    strength_protect: opportunities.filter(o => o.priority_treatment === 'strength_protect'),
    do_nothing: opportunities.filter(o => o.status === 'dismissed' && o.priority_treatment === 'do_nothing'),
    ordinary: opportunities.filter(o => o.status === 'open' && !['highest_impact', 'easy_win', 'strength_protect'].includes(o.priority_treatment))
  }
  const actionable = opportunities.filter(o => o.status === 'open' && o.priority_treatment !== 'strength_protect')

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
      <StepChips labels={STEP_LABELS} step={step} onStep={setStep} />
      {error && <div className="callout" style={{ marginTop: 10, borderColor: 'var(--red)' }}>{error}</div>}

      {step === 1 && (
        <div>
          <div className="card" style={{ padding: 20 }}>
            <div className="grade-title">AI Source &amp; Citation Presence</div>
            <p className="diagnosis-text">
              {diagnosis.totalSourcesObserved || 0} distinct third-party source(s) observed across tracked AI responses
              {diagnosis.highImportanceCount ? `, ${diagnosis.highImportanceCount} of high observed importance` : ''}.
              {diagnosis.strengthProtectCount ? ` ${diagnosis.strengthProtectCount} already show strong, durable client presence.` : ''}
              {diagnosis.highestImpactCount || diagnosis.easyWinCount
                ? ` ${diagnosis.highestImpactCount || 0} Highest Impact and ${diagnosis.easyWinCount || 0} Easy Win opportunit(y/ies) identified.`
                : ' No Highest Impact or Easy Win opportunities identified from current evidence.'}
            </p>
            <div className="stat-pill-row">
              <StatPill eyebrow="SOURCES OBSERVED" value={diagnosis.totalSourcesObserved || 0} desc="distinct third-party domains cited by AI" />
              <StatPill eyebrow="HIGH IMPORTANCE" value={diagnosis.highImportanceCount || 0} tone={diagnosis.highImportanceCount ? 'good' : null} desc="sources with repeated, cross-engine evidence" />
              <StatPill eyebrow="STRENGTH / PROTECT" value={diagnosis.strengthProtectCount || 0} tone={diagnosis.strengthProtectCount ? 'good' : null} desc="sources where the client is already well represented" />
              <StatPill eyebrow="OWN-DOMAIN PAGES CITED" value={diagnosis.ownDomainCitedPageCount ?? '--'} desc="client-owned pages AI is actually citing" />
            </div>
            <div className="stat-pill-row" style={{ marginTop: 10 }}>
              <StatPill eyebrow="ABSENT" value={diagnosis.presenceCounts?.absent || 0} desc="sources with no client presence observed" />
              <StatPill eyebrow="SOURCE PRESENCE ONLY" value={diagnosis.presenceCounts?.source_presence_only || 0} desc="present, but AI cites other content" />
              <StatPill eyebrow="AI RESPONSE CO-OCCURRENCE" value={diagnosis.presenceCounts?.ai_response_co_occurrence || 0} desc="mentioned alongside this source -- cited page not verified" />
              <StatPill eyebrow="VERIFIED IN CITED CONTENT" value={diagnosis.presenceCounts?.appears_in_cited_content_verified || 0} tone="good" desc="cited page fetched & confirmed to contain the client" />
              <StatPill eyebrow="UNKNOWN" value={diagnosis.presenceCounts?.unknown || 0} desc="no confirmed evidence either way yet" />
            </div>
            {diagnosis.observationalCount > 0 && (
              <p className="text-tiny text-muted" style={{ marginTop: 10 }}>
                {diagnosis.observationalCount} source(s) have insufficient evidence to establish a real client gap yet (unverified presence) -- left observational, not forced into an opportunity or a rejection.
              </p>
            )}
            {!diagnosis.industryEvidenceAvailableCount && (
              <p className="text-tiny text-muted" style={{ marginTop: 10 }}>
                No industry-level evidence is available yet -- this requires other tracked clients in the same category, and none currently exist. Every number above is client-specific, real AI observation evidence.
              </p>
            )}
          </div>
          <div className="cta-row">
            <button className="btn btn-primary" onClick={() => setStep(2)}>See source landscape &rarr;</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          {sources.length > 0 ? (
            <>
              <p className="text-small text-muted">
                Ranked by observed AI importance for this client&rsquo;s tracked prompts -- not by competitor presence. A source can rank highly with zero competitors present.
              </p>
              <div className="cta-row" style={{ marginBottom: 10 }}>
                <button className="btn btn-secondary" disabled={rechecking} onClick={runRecheck}>
                  {rechecking ? 'Re-checking cited pages...' : 'Re-check cited pages now'}
                </button>
                <span className="text-tiny text-muted">Fetches the actual cited URLs (bounded, deduped, cached) to verify client presence -- only runs on this click or during a scheduled audit, never on page load.</span>
              </div>
              <div className="cluster-grid">
                {sources.map(s => (
                  <SourceCard key={s.domain} source={s} selected={selectedSource?.domain === s.domain} onSelect={() => setSelectedDomain(s.domain)} />
                ))}
              </div>
              <SourceDetail source={selectedSource} />
            </>
          ) : (
            <div className="card-empty" style={{ padding: 18 }}>
              <div className="text-small text-muted">No third-party sources have been observed yet -- run an audit with AI-visibility tracking enabled first.</div>
            </div>
          )}
          <div className="cta-row">
            <button className="btn btn-secondary" onClick={() => setStep(1)}>&larr; Back</button>
            <button className="btn btn-primary" onClick={() => setStep(3)}>See own-site citations &rarr;</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div>
          {ownSite ? (
            <div className="card" style={{ padding: 18 }}>
              <div className="brief-title">Client-owned pages AI is citing</div>
              {ownSite.citedOwnPages.length > 0 ? (
                <ul className="text-small" style={{ margin: '10px 0', paddingLeft: 18 }}>
                  {ownSite.citedOwnPages.map(p => <li key={p.path}>{p.path} -- cited {p.count} time(s)</li>)}
                </ul>
              ) : (
                <p className="text-small text-muted">No client-owned pages have been cited by AI in tracked responses yet.</p>
              )}

              <div className="brief-title" style={{ marginTop: 16 }}>Strategic topics with no cited-page evidence</div>
              {ownSite.topicsWithoutCitedEvidence.length > 0 ? (
                <ul className="text-small" style={{ margin: '10px 0', paddingLeft: 18 }}>
                  {ownSite.topicsWithoutCitedEvidence.map(t => <li key={t.topicClusterId}>{t.name}</li>)}
                </ul>
              ) : (
                <p className="text-small text-muted">Every strategic/benchmark topic has at least one cited-page match.</p>
              )}

              {ownSite.competitorCitedInstead.length > 0 && (
                <>
                  <div className="brief-title" style={{ marginTop: 16 }}>Rows where a competitor&rsquo;s page was cited instead</div>
                  <p className="text-tiny text-muted" style={{ margin: '4px 0 10px' }}>
                    OBSERVED DIFFERENCE only -- this pillar does not diagnose the site-side cause (schema, content depth, freshness, etc.). Route to Content &amp; Topical Relevance, Schema &amp; Structure, Entity &amp; Brand Authority, or Technical Foundation for a real cause diagnosis -- no duplicate opportunity is created here.
                  </p>
                  <details className="raw-details">
                    <summary>Show {ownSite.competitorCitedInstead.length} instance(s)</summary>
                    <ul className="evidence-list">
                      {ownSite.competitorCitedInstead.slice(0, 20).map((c, i) => (
                        <li key={i}>&ldquo;{c.prompt}&rdquo; ({c.engine}) -- cited: {c.competitorDomains.join(', ')}. {c.evidenceStatus}</li>
                      ))}
                    </ul>
                  </details>
                </>
              )}
            </div>
          ) : (
            <div className="card-empty" style={{ padding: 18 }}>
              <div className="text-small text-muted">Own-site citation data is not available yet.</div>
            </div>
          )}
          <div className="cta-row">
            <button className="btn btn-secondary" onClick={() => setStep(2)}>&larr; Back</button>
            <button className="btn btn-primary" onClick={() => setStep(4)}>See opportunities &rarr;</button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div>
          {Object.entries(groups).map(([key, list]) => list.length > 0 && (
            <div key={key} style={{ marginBottom: 18 }}>
              <div className="section-label" style={{ marginBottom: 8 }}>{TREATMENT_GROUP_LABEL[key]} ({list.length})</div>
              <div style={{ display: 'grid', gap: 10 }}>
                {list.map(o => (
                  <OpportunityCard
                    key={o.id}
                    opportunity={o}
                    priorityDimensions={o.priorityDimensions}
                    statusTrack={o.statusTrack}
                    preparedWork={o.preparedWork}
                    onApprove={busyId ? undefined : (opp) => runLifecycleAction(opp.id, 'approve')}
                    onReject={busyId ? undefined : (opp) => runLifecycleAction(opp.id, 'reject', { reason: 'am_do_nothing' })}
                    // No onRequestVerification here (Phase 1.1, 2026-09-01):
                    // this is the review/browse step, before execution has
                    // even happened -- lib/opportunityLifecycle.js's
                    // requestVerification() now REJECTS a request until
                    // execution_status is "executed"/"human_completed" (see
                    // validateExecutionGate's 'verify' case), so a "Verify
                    // now" button here would almost always just error. The
                    // real, correctly-gated "Mark ready for verification"
                    // control lives in the Execute & verify step (5) below,
                    // once there's actually something to verify.
                    // No onEditThenApprove either: OpportunityCard's "Edit
                    // then approve" button has no real edited content to
                    // approve without a prepared-work editing UI, which
                    // this pass deliberately does not invent (see the
                    // lifecycle route's edit_then_approve comment) -- wiring
                    // it would fabricate an "edited" history event for
                    // content nobody actually edited.
                  />
                ))}
              </div>
            </div>
          ))}
          {opportunities.length === 0 && (
            <div className="card-empty" style={{ padding: 18 }}>
              <div className="text-small text-muted">No opportunities have been generated yet -- run an audit to populate the source landscape first.</div>
            </div>
          )}
          <div className="cta-row">
            <button className="btn btn-secondary" onClick={() => setStep(3)}>&larr; Back</button>
            <button className="btn btn-primary" onClick={() => setStep(5)}>Execute &amp; verify &rarr;</button>
          </div>
        </div>
      )}

      {step === 5 && (
        <div>
          {actionable.length > 0 ? (
            <div style={{ display: 'grid', gap: 10 }}>
              {actionable.map(o => (
                <div key={o.id}>
                  <OpportunityCard
                    opportunity={o}
                    priorityDimensions={o.priorityDimensions}
                    statusTrack={o.statusTrack}
                    preparedWork={o.preparedWork}
                    onApprove={busyId ? undefined : (opp) => runLifecycleAction(opp.id, 'approve')}
                    onReject={busyId ? undefined : (opp) => runLifecycleAction(opp.id, 'reject', { reason: 'am_do_nothing' })}
                    // onRequestVerification intentionally omitted here too
                    // (see step 4's comment) -- OpportunityCard's own
                    // "Verify now" button only ever renders once
                    // verification_status is ALREADY 'ready_to_verify', at
                    // which point it would just needlessly re-request the
                    // same state. The real transition INTO ready_to_verify
                    // is the "Mark ready for verification" button below,
                    // shown only once execution/handoff genuinely completed.
                  />
                  {o.execution_capability === 'red' && o.approval_status === 'approved' && o.execution_status !== 'human_completed' && (
                    <div className="cta-row" style={{ marginTop: 6 }}>
                      {o.execution_status !== 'handoff_requested' && o.execution_status !== 'handed_off' && (
                        <button className="btn btn-secondary" disabled={busyId === o.id} onClick={() => runLifecycleAction(o.id, 'request_handoff', { instructions: 'Prepared work is ready for manual submission -- see prepared work above.' })}>
                          Request handoff
                        </button>
                      )}
                      {o.execution_status === 'handoff_requested' && (
                        <button className="btn btn-secondary" disabled={busyId === o.id} onClick={() => runLifecycleAction(o.id, 'record_handoff', { method: 'manual', reference: 'AM confirmed handoff' })}>
                          Record handoff delivered
                        </button>
                      )}
                      {o.execution_status === 'handed_off' && (
                        <button className="btn btn-secondary" disabled={busyId === o.id} onClick={() => runLifecycleAction(o.id, 'record_human_completed', { notes: 'AM confirmed this was completed.' })}>
                          Mark human-completed
                        </button>
                      )}
                    </div>
                  )}
                  {/* PHASE 1.1 (2026-09-01) -- the closed gap: this is the ONLY
                      control that moves an opportunity from verification_status
                      'not_ready' into 'ready_to_verify'. Shown only once
                      execution genuinely completed (GREEN/YELLOW: 'executed'
                      via executeOpportunity; RED: 'human_completed' via
                      recordHumanCompleted above) -- lib/opportunityLifecycle.js's
                      requestVerification() independently re-enforces this via
                      validateExecutionGate(row, 'verify'), so even a stale/buggy
                      UI state can't fire this before real work is done. Hidden
                      once verification_status has already moved past 'not_ready'
                      (ready_to_verify/verified/etc.), so it never re-appears
                      after the AM has already requested it once. */}
                  {['executed', 'human_completed'].includes(o.execution_status) && o.verification_status === 'not_ready' && (
                    <div className="cta-row" style={{ marginTop: 6 }}>
                      <button className="btn btn-secondary" disabled={busyId === o.id} onClick={() => runLifecycleAction(o.id, 'request_verification')}>
                        Mark ready for verification
                      </button>
                    </div>
                  )}
                  {o.verification_status === 'ready_to_verify' && (
                    <div className="cta-row" style={{ marginTop: 6 }}>
                      <button className="btn btn-secondary" disabled={busyId === o.id} onClick={() => runLifecycleAction(o.id, 'record_verification', { result: 'verified', evidence: [{ note: 'AM re-checked the source/profile URL and confirmed client presence.' }] })}>
                        Record: Verified
                      </button>
                      <button className="btn btn-secondary" disabled={busyId === o.id} onClick={() => runLifecycleAction(o.id, 'record_verification', { result: 'inconclusive', evidence: [] })}>
                        Record: Inconclusive
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="card-empty" style={{ padding: 18 }}>
              <div className="text-small text-muted">No actionable opportunities to execute or verify right now -- see the Opportunities step for Strength/Protect and Do Nothing dispositions.</div>
            </div>
          )}
          <p className="text-tiny text-muted" style={{ marginTop: 12 }}>
            Task completion, verification, and AI-visibility outcome are tracked independently: submitting a directory profile is task completion, confirming the listing exists is verification, and AI later citing it is a separate, later outcome -- a still-unfulfilled AI outcome never invalidates a verified listing.
          </p>
          <div className="cta-row">
            <button className="btn btn-secondary" onClick={() => setStep(4)}>&larr; Back</button>
          </div>
        </div>
      )}
    </div>
  )
}
