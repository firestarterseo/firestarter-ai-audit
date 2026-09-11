'use client'

// PROMPT GAP OPPORTUNITY CARD (2026-09-11) -- presentation-only redesign
// of the ACTIVE-opportunity card in ContentExecutionPanel.js. Goal: the
// card answers three questions immediately -- what should we do, why, how
// confident are we -- with everything else (raw evidence, full proposed-
// work detail, prepared-work/verification history) behind collapsed
// sections. An agency decision dashboard, not a debugging console.
//
// This changes NOTHING about analysis, qualification, prepared-work
// generation, or lifecycle transitions -- every field read here already
// exists on the opportunity row / review payload computed by
// lib/promptGapAnalysis.js, lib/promptGapOpportunities.js,
// lib/opportunityLifecycle.js, and lib/promptGapExecution.js. The action
// buttons this card renders call the exact same callbacks
// ContentExecutionPanel.js already wired to those unchanged API routes;
// this file only decides how to LAY OUT what's already there.
//
// Dismissed/invalidated Opportunities are NOT rendered by this component --
// see ContentExecutionPanel.js's DismissedOpportunityNotice (built the
// pass before this one), unchanged here.

import { useState, useEffect } from 'react'

export const ACTION_TYPE_LABEL = {
  create_dedicated_new_page: 'Create a dedicated new page',
  improve_existing_page: 'Improve the existing page',
  expand_existing_page: 'Expand the existing page',
  fix_technical_schema: 'Fix via Schema Wizard'
}

const RECOMMENDATION_LABEL = {
  create_dedicated_new_page: 'Create new page',
  improve_existing_page: 'Improve existing page',
  expand_existing_page: 'Improve existing page',
  fix_technical_schema: 'Fix via Schema Wizard'
}

const GAP_CATEGORY_LABEL = {
  content: 'content depth',
  relevance: 'relevance',
  authority: 'authority',
  third_party: 'third-party presence',
  technical: 'technical/schema signals'
}

// DEFICIT_FOCUS_PHRASE -- maps a computeRelevanceGap deficit `type` (see
// lib/promptGapAnalysis.js) to a short, plain-English phrase naming WHERE
// the gap is, for the one-line "Why" summary below. Purely a label lookup
// over an already-computed, already-typed value -- no new inference.
const DEFICIT_FOCUS_PHRASE = {
  title_h1_terms: 'in its title and headings',
  heading_terms: 'in its title and headings',
  body_topic_coverage: 'in page content depth',
  page_intent_mismatch: 'in how well the page matches searcher intent',
  location_not_structural: 'in location-specific signals',
  location_absent: 'in location-specific signals',
  internal_link_support: 'in internal linking'
}

// formatTimestamp -- an EXPLICIT locale + UTC timeZone (never the ambient
// server/browser default) so the rendered string is byte-identical on the
// server-rendered HTML and the client hydration pass. A bare
// `new Date(x).toLocaleString()` -- used elsewhere in this codebase, e.g.
// PromptGapAnalysisPanel.js -- depends on the runtime's local timezone,
// which differs between Vercel's server (UTC) and a browser (whatever the
// viewer is in); inside a `<details>` that can render while closed (this
// one's default state), that mismatch still hydrates and throws a real
// React error (#418) even though nothing is visibly wrong -- confirmed
// live while building this card. Scoped to this new file only; not a
// claim that the pre-existing pattern elsewhere is broken today.
function formatTimestamp(iso) {
  try {
    return new Date(iso).toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC'
  } catch (e) {
    return iso
  }
}

function domainLabel(domain) {
  if (!domain) return null
  const base = String(domain).replace(/\.[a-z.]+$/i, '').split('.').pop()
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : domain
}

// buildWhySummary(clientName, opportunity) -> a 1-2 sentence plain-English
// explanation, templated ONLY from fields already stored on the
// opportunity (detail.supporting_prompts, detail.winning_competitors,
// detail.gap_diagnosis.deficits) -- no new analysis, just phrasing of
// existing facts. Falls back to the existing recommended_action prose
// (already real, human-composed text from lib/promptGapAnalysis.js's
// buildRecommendedActions) when there isn't enough structured data to
// template a sentence from (e.g. non-relevance dimensions, which don't
// carry gap_diagnosis).
function buildWhySummary(clientName, opportunity) {
  const detail = opportunity.detail || {}
  const prompts = detail.supporting_prompts || []
  const examplePrompt = prompts[0]?.prompt_text
  if (!examplePrompt) return detail.recommended_action || 'Needs review -- see evidence below.'

  const otherCount = Math.max(0, prompts.length - 1)
  const allEngines = [...new Set(prompts.flatMap(p => p.losing_engines || []))]
  const competitor = (detail.winning_competitors || [])[0]
  const competitorLabel = competitor ? domainLabel(competitor) : 'A tracked competitor'
  const deficitTypes = (detail.gap_diagnosis?.deficits || []).map(d => d.type)
  const focusPhrase = deficitTypes.map(t => DEFICIT_FOCUS_PHRASE[t]).find(Boolean)
  const gapLabel = GAP_CATEGORY_LABEL[detail.gap_category] || 'relevance'

  const engineClause = allEngines.length > 1 ? ` on ${allEngines.length} AI engines` : (allEngines.length === 1 ? ` on ${allEngines[0]}` : '')
  const otherPromptsClause = otherCount > 0 ? ` (and ${otherCount} similar prompt${otherCount > 1 ? 's' : ''})` : ''
  const who = clientName || 'This client'

  return `${who} is losing "${examplePrompt}"${otherPromptsClause}${engineClause}. ${competitorLabel} has stronger ${gapLabel}${focusPhrase ? ` ${focusPhrase}` : ''}, while ${who}'s page does not.`
}

// deriveStatus -- the 5 states requested: Ready for review / Approved /
// Waiting for implementation / Verification failed / Verified. Purely a
// read of existing approval_status/execution_status/verification_status
// columns, same priority order StatusTrack.js's computeStatusTrack already
// implies (verify > execute/handoff > approve > prepared).
function deriveStatus(o) {
  if (o.verification_status === 'verified') return { label: 'Verified', tone: 'good' }
  if (o.verification_status === 'failed_verification') return { label: 'Verification failed', tone: 'gap' }
  if (['handoff_requested', 'handed_off', 'human_completed', 'human_claimed_complete'].includes(o.execution_status)) {
    return { label: 'Waiting for implementation', tone: 'watch' }
  }
  if (o.approval_status === 'approved') return { label: 'Approved', tone: 'watch' }
  return { label: 'Ready for review', tone: 'watch' }
}

const METRIC_DEFS = [
  { key: 'impact', label: 'Impact' },
  { key: 'effort', label: 'Effort' },
  { key: 'evidence_strength', label: 'Evidence' },
  { key: 'commercial_relevance', label: 'Commercial' },
  { key: 'automation_capability', label: 'Automation' }
]

function DecisionMetrics({ priorityDimensions }) {
  if (!priorityDimensions) return null
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {METRIC_DEFS.map(({ key, label }) => {
        const dim = priorityDimensions[key]
        const level = dim?.level
        const known = level && level !== 'unknown'
        return (
          <span
            key={key}
            title={dim?.reasoning || (known ? undefined : 'Not yet scored for this Opportunity.')}
            style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 999,
              border: `1px solid ${known ? 'var(--border-strong)' : 'var(--border)'}`,
              color: known ? 'var(--text)' : 'var(--muted-2)',
              background: known ? 'var(--bg-alt)' : 'transparent'
            }}
          >
            {label}: {known ? String(level).toUpperCase() : 'not yet assessed'}
          </span>
        )
      })}
    </div>
  )
}

function EvidenceDetail({ opportunity }) {
  const detail = opportunity.detail || {}
  const prompts = detail.supporting_prompts || []
  const diag = detail.gap_diagnosis

  return (
    <div style={{ fontSize: 13, display: 'grid', gap: 10 }}>
      {prompts.length > 0 && (
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Supporting prompts ({prompts.length})</div>
          {prompts.map((p, i) => (
            <div key={i} style={{ marginBottom: 4 }}>
              &ldquo;{p.prompt_text}&rdquo; -- losing on {(p.losing_engines || []).join(', ') || 'n/a'}; winning: {(p.winning_competitors || []).join(', ') || 'n/a'}
            </div>
          ))}
        </div>
      )}
      {detail.winning_competitors?.length > 0 && (
        <div><strong>Winning competitor(s):</strong> {detail.winning_competitors.join(', ')}</div>
      )}
      {diag && (
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Client vs. competitor comparison</div>
          <div style={{ display: 'grid', gap: 3 }}>
            {diag.headingMatches && (
              <div>Heading terms -- client: {diag.headingMatches.client?.join(', ') || '(none)'}; competitor: {diag.headingMatches.competitor?.join(', ') || '(none)'}</div>
            )}
            {diag.bodyCoverage && (
              <div>Body-content coverage -- client: {diag.bodyCoverage.client?.length ?? 0}/{diag.bodyCoverage.totalDistinctiveTerms}; competitor: {diag.bodyCoverage.competitor?.length ?? 0}/{diag.bodyCoverage.totalDistinctiveTerms}</div>
            )}
            {diag.pageIntent && (
              <div>Page intent -- client: &ldquo;{diag.pageIntent.clientPageType || 'unknown'}&rdquo; ({diag.pageIntent.clientMatchConfidence || 'unknown'} confidence); competitor: &ldquo;{diag.pageIntent.competitorPageType || 'unknown'}&rdquo; (satisfies intent: {diag.pageIntent.competitorSatisfiesIntent ? 'yes' : 'no'})</div>
            )}
            {diag.locationSpecificity && (
              <div>Location ({diag.locationSpecificity.targetLocation || diag.locationSpecificity.supportingContext || 'n/a'}) -- in headings: {diag.locationSpecificity.clientLocationInHeadings?.join(', ') || '(not at all)'}; body only: {diag.locationSpecificity.clientLocationInBodyOnly?.join(', ') || 'none'}</div>
            )}
            {diag.internalLinkSupport && (
              <div>Internal links reinforcing this prompt -- client: {diag.internalLinkSupport.clientRelevantLinkCount}; competitor: {diag.internalLinkSupport.competitorRelevantLinkCount}</div>
            )}
          </div>
        </div>
      )}
      {Array.isArray(detail.gap_evidence) && detail.gap_evidence.length > 0 && (
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Raw gap evidence</div>
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--muted-2)' }}>
            {detail.gap_evidence.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}
      {!diag && (!detail.gap_evidence || detail.gap_evidence.length === 0) && prompts.length === 0 && (
        <div className="text-tiny text-muted">No structured evidence recorded for this Opportunity.</div>
      )}
    </div>
  )
}

function FieldChange({ label, current, proposed }) {
  if (!proposed) return null
  return (
    <div style={{ fontSize: 13, marginBottom: 6 }}>
      <strong>{label}:</strong>{' '}
      <span style={{ color: 'var(--muted)', textDecoration: current ? 'line-through' : 'none' }}>{current || '(none currently)'}</span>
      {' '}&rarr;{' '}
      <span style={{ fontWeight: 600 }}>{proposed}</span>
    </div>
  )
}

// Exported so ContentExecutionPanel.js's dismissed-Opportunity "Previous
// analysis (superseded)" section can render a historical review payload
// with the exact same rendering as an active card's "View proposed work"
// -- one source of truth for "how do we display a review payload," not a
// duplicated copy.
export function ProposedWorkDetail({ review, onLoadReview, busy }) {
  if (!review) {
    // No primary CTA left to load this once the Opportunity has moved past
    // the review stage (approved / handed off / verifying) -- a small,
    // secondary control here, not competing with the card's ONE prominent
    // action, is the only way to still pull it up on demand.
    return onLoadReview ? (
      <button className="btn btn-secondary" style={{ fontSize: 12 }} disabled={busy} onClick={onLoadReview}>
        {busy ? 'Loading...' : 'Load proposed work'}
      </button>
    ) : (
      <div className="text-tiny text-muted">No proposed-work detail loaded yet.</div>
    )
  }
  const s = review.changeSummary
  if (!s) return null

  if (s.actionType === 'create_dedicated_new_page') {
    return (
      <div style={{ fontSize: 13, display: 'grid', gap: 6 }}>
        {review.existingPageAtTargetUrl && (
          <div style={{ color: 'var(--red)', fontWeight: 600 }}>
            Warning: a page already exists live at {s.newPage.url} (title: &ldquo;{review.existingPageAtTargetUrl.title}&rdquo;) -- re-check before creating.
          </div>
        )}
        {s.protectedPage && (
          <div className="text-tiny text-muted">Protecting existing page {s.protectedPage} -- not modified by this plan.</div>
        )}
        <div><strong>New URL:</strong> {s.newPage.url}</div>
        <div><strong>Title:</strong> {s.newPage.title}</div>
        <div><strong>H1:</strong> {s.newPage.h1}</div>
        {s.newPage.titleH1Reason && <div className="text-tiny text-muted">Addresses: {s.newPage.titleH1Reason}</div>}
        <div><strong>Meta description:</strong> {s.newPage.metaDescription}</div>
        <div><strong>Angle:</strong> {s.newPage.angle}</div>
        {s.newPage.sections?.length > 0 && (
          <details open>
            <summary style={{ cursor: 'pointer' }}>Body sections ({s.newPage.sections.length})</summary>
            {s.newPage.sections.map((sec, i) => (
              <div key={i} style={{ marginTop: 8 }}>
                <div className="text-tiny text-muted" style={{ fontWeight: 700, textTransform: 'uppercase' }}>{sec.heading_level}</div>
                <div style={{ fontWeight: 600 }}>{sec.heading}</div>
                <div dangerouslySetInnerHTML={{ __html: sec.content_html }} />
                {sec.addresses_gap && <div className="text-tiny text-muted">Addresses: {sec.addresses_gap}</div>}
              </div>
            ))}
          </details>
        )}
        {s.internalLinks?.length > 0 && (
          <div><strong>Internal linking:</strong> {s.internalLinks.map((l, i) => <div key={i}>&ldquo;{l.anchor_text}&rdquo; &rarr; {l.link_target_hint} -- {l.reason}</div>)}</div>
        )}
        {s.proofRequirements?.length > 0 && (
          <div><strong>Proof required before publishing:</strong> {s.proofRequirements.map((p, i) => <div key={i}>{p.requirement} -- {p.reason}</div>)}</div>
        )}
        {s.schemaRecommendations?.length > 0 && (
          <div><strong>Schema recommendations (for Schema Wizard):</strong> {s.schemaRecommendations.map((r, i) => <span key={i} style={{ marginRight: 8 }}>{r.schema_type}</span>)}</div>
        )}
        {s.siteQualityIssues?.length > 0 && (
          <div style={{ color: 'var(--grade-c)' }}><strong>Separate site-quality issue(s) noticed, not part of this plan:</strong> {s.siteQualityIssues.map((iss, i) => <div key={i}>{iss.evidence}</div>)}</div>
        )}
      </div>
    )
  }

  return (
    <div style={{ fontSize: 13, display: 'grid', gap: 6 }}>
      <div className="text-tiny text-muted">Page: {s.pageUrl}{typeof s.currentWordCount === 'number' ? ` (${s.currentWordCount} words currently)` : ''}</div>
      <FieldChange label="Title" current={s.title.current} proposed={s.title.proposed} />
      <FieldChange label="H1" current={s.h1.current} proposed={s.h1.proposed} />
      {s.headingsToChange?.length > 0 && (
        <details open>
          <summary style={{ cursor: 'pointer' }}>H2/H3 changes ({s.headingsToChange.length})</summary>
          {s.headingsToChange.map((h, i) => (
            <div key={i} style={{ marginTop: 6 }}>
              <div><strong>{h.heading_level}:</strong> {h.current_heading ? <><span style={{ textDecoration: 'line-through', color: 'var(--muted)' }}>{h.current_heading}</span> &rarr; </> : null}<span style={{ fontWeight: 600 }}>{h.new_heading}</span></div>
              <div className="text-tiny text-muted">Placement: {h.placement}</div>
            </div>
          ))}
        </details>
      )}
      {s.contentAdditions?.length > 0 && (
        <details open>
          <summary style={{ cursor: 'pointer' }}>Content additions/rewrites ({s.contentAdditions.length})</summary>
          {s.contentAdditions.map((c, i) => (
            <div key={i} style={{ marginTop: 8 }}>
              <div style={{ fontWeight: 600 }}>{c.heading}</div>
              {c.placement && <div className="text-tiny text-muted">Placement: {c.placement}</div>}
              <div className="text-tiny text-muted">{c.reason}</div>
              <div dangerouslySetInnerHTML={{ __html: c.content_html }} />
            </div>
          ))}
        </details>
      )}
      {s.internalLinks?.length > 0 && (
        <div><strong>Internal linking:</strong> {s.internalLinks.map((l, i) => <div key={i}>&ldquo;{l.anchor_text}&rdquo; &rarr; {l.link_target_hint} -- {l.reason}</div>)}</div>
      )}
      {s.entityLocationSignals?.length > 0 && (
        <div><strong>Entity/location signals:</strong> {s.entityLocationSignals.map((e, i) => <div key={i}>{e.signal} -- {e.reason}</div>)}</div>
      )}
      {s.summaryOfChanges && <div className="text-tiny text-muted">{s.summaryOfChanges}</div>}
      {s.completenessCheck && (
        <div style={{ fontSize: 12 }}>
          {s.completenessCheck.unaddressed?.length > 0 ? (
            <div style={{ color: 'var(--red)' }}><strong>Not yet addressed by this plan:</strong> {s.completenessCheck.unaddressed.join(', ')}</div>
          ) : (
            <div style={{ color: 'var(--grade-a)' }}>Every diagnosed deficit is addressed by this plan.</div>
          )}
          {s.completenessCheck.note && <div className="text-tiny text-muted">{s.completenessCheck.note}</div>}
        </div>
      )}
      {s.siteQualityIssues?.length > 0 && (
        <div style={{ color: 'var(--grade-c)' }}><strong>Separate site-quality issue(s) noticed, not part of this plan:</strong> {s.siteQualityIssues.map((iss, i) => <div key={i}>{iss.evidence}</div>)}</div>
      )}
    </div>
  )
}

function HistoryDetail({ opportunity, verify }) {
  const o = opportunity
  const versions = [...(o.preparedWork || [])].sort((a, b) => b.version - a.version)
  return (
    <div style={{ fontSize: 13, display: 'grid', gap: 10 }}>
      {versions.length > 0 && (
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Prepared-work versions</div>
          {versions.map(pw => (
            <div key={pw.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
              <span>{pw.artifact_type} v{pw.version}</span>
              <span style={{ color: 'var(--muted)' }}>
                {pw.status}
                {pw.id === o.approved_prepared_work_id ? ' -- approved version' : ''}
              </span>
            </div>
          ))}
        </div>
      )}
      {(verify || o.verification_state?.checked_at) && (
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Latest verification attempt</div>
          <div className="text-tiny text-muted" style={{ marginBottom: 4 }}>
            {o.verification_state?.checked_at ? formatTimestamp(o.verification_state.checked_at) : 'Just now'} -- {o.verification_status}
          </div>
          {((verify?.checks) || o.verification_state?.evidence || []).map((c, i) => (
            <div key={i} className="text-tiny" style={{ color: c.matches ? 'var(--grade-a)' : 'var(--red)' }}>
              {c.field}: expected &ldquo;{c.expected}&rdquo;, found &ldquo;{c.actual || '(nothing found)'}&rdquo; {c.matches ? '✓' : '✗'}
            </div>
          ))}
        </div>
      )}
      {versions.length === 0 && !verify && !o.verification_state?.checked_at && (
        <div className="text-tiny text-muted">No prepared-work or verification history yet.</div>
      )}
    </div>
  )
}

export default function PromptGapOpportunityCard({
  clientName, opportunity, review, verify, busy,
  onLoadReview, onApprove, onReject, onRequestHandoff, onRecordHandoff, onMarkLiveAndVerify
}) {
  const o = opportunity
  const [openSection, setOpenSection] = useState(null)

  // Auto-expand "View proposed work" the moment a review actually loads --
  // clicking the single primary CTA ("Review proposed changes") should
  // immediately show what it fetched, not require a second click.
  useEffect(() => {
    if (review) setOpenSection('work')
  }, [review])

  const latestContentWork = (o.preparedWork || [])
    .filter(pw => pw.artifact_type === 'content_brief' || pw.artifact_type === 'content_draft')
    .reduce((latest, pw) => (!latest || pw.version > latest.version) ? pw : latest, null)
  const actionType = review?.actionType || latestContentWork?.payload?.action_type || null
  const status = deriveStatus(o)
  const why = buildWhySummary(clientName, o)

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 16, boxShadow: 'var(--shadow-sm)', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Which Opportunity this card even is -- omitted from the first cut
          of this redesign and only caught once multiple active cards were
          visible side by side with no way to tell them apart at a glance. */}
      <div className="text-small" style={{ fontWeight: 600 }}>{o.title}</div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
        <div>
          <div className="text-tiny text-muted" style={{ textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 }}>Recommendation</div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{RECOMMENDATION_LABEL[actionType] || 'Needs review'}</div>
        </div>
        <span className={`tag ${status.tone}`}>{status.label}</span>
      </div>

      <p style={{ fontSize: 13.5, margin: 0, lineHeight: 1.5 }}>{why}</p>

      <DecisionMetrics priorityDimensions={o.priorityDimensions} />

      {/* EXACTLY ONE prominent CTA per state (2026-09-11 fix) -- the first
          version of this card could show "Review proposed changes" AND the
          verify button at once, because "has a review been loaded THIS
          BROWSER SESSION" and "how far along is the actual lifecycle" are
          two different questions: an Opportunity already past approval
          still showed the review button on a fresh page load, before
          anyone clicked anything, simply because `review` state hadn't
          been fetched yet. The chain below is ordered by lifecycle state
          alone (approval_status/execution_status/verification_status),
          never by whether review happens to be loaded in memory -- once an
          Opportunity is approved, "Review proposed changes" is no longer
          the decision point regardless of local state. (The plan itself is
          still reachable via a small secondary control inside "View
          proposed work" -- see ProposedWorkDetail's onLoadReview fallback.) */}
      <div className="cta-row" style={{ marginTop: 2, alignItems: 'center', gap: 10 }}>
        {o.verification_status === 'verified' ? (
          <span style={{ color: 'var(--grade-a)', fontWeight: 600, fontSize: 13 }}>&#10003; Verified live</span>
        ) : ['handed_off', 'human_completed', 'human_claimed_complete'].includes(o.execution_status) ? (
          <button className="btn btn-primary" disabled={busy} onClick={onMarkLiveAndVerify}>
            {busy ? 'Verifying...' : (o.verification_status === 'failed_verification' ? "I've corrected it -- verify now" : "I've made these changes live -- verify now")}
          </button>
        ) : o.execution_status === 'handoff_requested' ? (
          <button className="btn btn-primary" disabled={busy} onClick={onRecordHandoff}>Record handoff delivered</button>
        ) : o.approval_status === 'approved' ? (
          <button className="btn btn-primary" disabled={busy} onClick={onRequestHandoff}>Request handoff (ready to publish)</button>
        ) : review ? (
          <>
            <button className="btn btn-primary" disabled={busy} onClick={onApprove}>Approve</button>
            <button className="text-tiny text-muted" style={{ background: 'none', border: 'none', textDecoration: 'underline', cursor: 'pointer', padding: 0 }} disabled={busy} onClick={onReject}>
              Do nothing (reject)
            </button>
          </>
        ) : (
          <button className="btn btn-primary" disabled={busy} onClick={onLoadReview}>
            {busy ? 'Loading...' : 'Review proposed changes'}
          </button>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 2 }}>
        {[
          { key: 'evidence', label: 'View evidence' },
          { key: 'work', label: 'View proposed work' },
          { key: 'history', label: 'History' }
        ].map(({ key, label }) => (
          <details key={key} open={openSection === key} onToggle={e => setOpenSection(e.target.open ? key : null)}>
            <summary className="text-small" style={{ cursor: 'pointer', fontWeight: 600 }}>{label}</summary>
            <div style={{ marginTop: 8, paddingLeft: 4 }}>
              {key === 'evidence' && <EvidenceDetail opportunity={o} />}
              {key === 'work' && <ProposedWorkDetail review={review} onLoadReview={onLoadReview} busy={busy} />}
              {key === 'history' && <HistoryDetail opportunity={o} verify={verify} />}
            </div>
          </details>
        ))}
      </div>
    </div>
  )
}
