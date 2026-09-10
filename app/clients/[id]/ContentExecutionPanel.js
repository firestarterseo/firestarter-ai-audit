'use client'

// PROMPT GAP EXECUTION PANEL (2026-09-10) -- lets an AM take an already-
// approved-ready Content/Relevance execution plan (see
// lib/promptGapPreparedWork.js) and actually carry it through Prepare ->
// Review -> Approve -> Publish -> Re-fetch -> Verify, reusing the exact
// same primitives app/clients/[id]/SourceCitationWizard.js already
// established for its own RED/manual-execution opportunities: OpportunityCard
// for FINDING/PREPARED WORK/APPROVE, and the generic
// app/api/clients/[id]/opportunities/[opportunityId]/lifecycle route for
// approve/reject/handoff. The one genuinely new piece is the "current vs
// proposed" review (a fresh live-page fetch, never the stale snapshot from
// generation time) and the "Re-fetch & verify" step, which really re-fetches
// the live page and checks the approved title/H1 are actually present
// rather than asking the AM to self-attest (see lib/promptGapExecution.js).
//
// No automated WordPress publish exists for page content today (only
// JSON-LD schema does, via lib/wpPublish.js) -- so "Publish" here means the
// AM applies the approved change in WordPress by hand, using the review
// below as their instructions, then confirms completion through the same
// handoff controls SourceCitationWizard already uses. This never auto-
// publishes anything.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import OpportunityCard from './OpportunityCard'

const ACTION_TYPE_LABEL = {
  create_dedicated_new_page: 'Create a dedicated new page',
  improve_existing_page: 'Improve the existing page',
  expand_existing_page: 'Expand the existing page',
  fix_technical_schema: 'Fix via Schema Wizard'
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

function ReviewDetail({ review }) {
  if (!review) return null
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
        <div><strong>Meta description:</strong> {s.newPage.metaDescription}</div>
        <div><strong>Angle:</strong> {s.newPage.angle}</div>
        {s.newPage.sections?.length > 0 && (
          <details>
            <summary style={{ cursor: 'pointer' }}>Body sections ({s.newPage.sections.length})</summary>
            {s.newPage.sections.map((sec, i) => (
              <div key={i} style={{ marginTop: 8 }}>
                <div className="text-tiny text-muted" style={{ fontWeight: 700, textTransform: 'uppercase' }}>{sec.heading_level}</div>
                <div style={{ fontWeight: 600 }}>{sec.heading}</div>
                <div dangerouslySetInnerHTML={{ __html: sec.content_html }} />
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
      {s.contentAdditions?.length > 0 && (
        <details>
          <summary style={{ cursor: 'pointer' }}>Content additions ({s.contentAdditions.length})</summary>
          {s.contentAdditions.map((c, i) => (
            <div key={i} style={{ marginTop: 8 }}>
              <div style={{ fontWeight: 600 }}>{c.heading}</div>
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
      {s.siteQualityIssues?.length > 0 && (
        <div style={{ color: 'var(--grade-c)' }}><strong>Separate site-quality issue(s) noticed, not part of this plan:</strong> {s.siteQualityIssues.map((iss, i) => <div key={i}>{iss.evidence}</div>)}</div>
      )}
    </div>
  )
}

function VerifyResult({ verify }) {
  if (!verify) return null
  return (
    <div style={{ fontSize: 12, marginTop: 6, color: verify.result === 'verified' ? 'var(--grade-a)' : 'var(--red)' }}>
      <strong>{verify.result === 'verified' ? 'Verified live' : 'Not verified'}</strong>
      {verify.checks?.map((c, i) => (
        <div key={i} className="text-tiny" style={{ color: c.matches ? 'var(--grade-a)' : 'var(--red)' }}>
          {c.field}: expected &ldquo;{c.expected}&rdquo;, live page has &ldquo;{c.actual || '(nothing found)'}&rdquo; {c.matches ? '✓' : '✗'}
        </div>
      ))}
    </div>
  )
}

export default function ContentExecutionPanel({ clientId, opportunities }) {
  const router = useRouter()
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)
  const [reviews, setReviews] = useState({})
  const [verifyResults, setVerifyResults] = useState({})

  const list = opportunities || []
  if (list.length === 0) return null

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

  async function loadReview(opportunityId) {
    setBusyId(opportunityId)
    setError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/opportunities/${opportunityId}/execution-review`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Review failed.')
      setReviews(prev => ({ ...prev, [opportunityId]: data.review }))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  async function runVerify(opportunityId) {
    setBusyId(opportunityId)
    setError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/opportunities/${opportunityId}/execution-verify`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Verification failed.')
      setVerifyResults(prev => ({ ...prev, [opportunityId]: data.result }))
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="card" style={{ padding: 18, marginTop: 14 }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Content &amp; Relevance execution</div>
      <p className="text-small text-muted" style={{ margin: '0 0 12px' }}>
        Prepare &rarr; Review &rarr; Approve &rarr; Publish &rarr; Re-fetch &rarr; Verify, for Opportunities generated from Prompt Gap Analysis. Nothing here publishes automatically -- there is no automated WordPress path for page content today (only JSON-LD schema has one), so publishing means an AM applies the approved change in WordPress by hand using the reviewed plan below, then confirms completion; the verify step then really re-fetches the live page rather than asking for a self-attestation.
      </p>
      {error && <p className="field-error" style={{ marginBottom: 10 }}>{error}</p>}
      <div style={{ display: 'grid', gap: 12 }}>
        {list.map(o => {
          const review = reviews[o.id]
          const verify = verifyResults[o.id]
          return (
            <div key={o.id}>
              <OpportunityCard
                opportunity={o}
                priorityDimensions={o.priorityDimensions}
                statusTrack={o.statusTrack}
                preparedWork={o.preparedWork}
                onApprove={busyId ? undefined : (opp) => runLifecycleAction(opp.id, 'approve')}
                onReject={busyId ? undefined : (opp) => runLifecycleAction(opp.id, 'reject', { reason: 'am_do_nothing' })}
              />
              <div className="cta-row" style={{ marginTop: 6 }}>
                <button className="btn btn-secondary" disabled={busyId === o.id} onClick={() => loadReview(o.id)}>
                  {busyId === o.id ? 'Loading...' : review ? 'Refresh current vs. proposed' : 'Show current vs. proposed'}
                </button>
              </div>
              {review && (
                <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 10, marginTop: 6, background: 'var(--bg-alt)' }}>
                  <div className="text-tiny text-muted" style={{ fontWeight: 700, textTransform: 'uppercase', marginBottom: 6 }}>
                    {ACTION_TYPE_LABEL[review.actionType] || review.actionType}
                  </div>
                  <ReviewDetail review={review} />
                </div>
              )}

              {o.execution_capability === 'red' && o.approval_status === 'approved' && o.execution_status !== 'human_completed' && (
                <div className="cta-row" style={{ marginTop: 6 }}>
                  {o.execution_status !== 'handoff_requested' && o.execution_status !== 'handed_off' && (
                    <button className="btn btn-secondary" disabled={busyId === o.id} onClick={() => runLifecycleAction(o.id, 'request_handoff', { instructions: 'Reviewed plan above is ready for manual WordPress publish.' })}>
                      Request handoff (ready to publish)
                    </button>
                  )}
                  {o.execution_status === 'handoff_requested' && (
                    <button className="btn btn-secondary" disabled={busyId === o.id} onClick={() => runLifecycleAction(o.id, 'record_handoff', { method: 'manual', reference: 'AM applying change in WordPress' })}>
                      Record handoff delivered
                    </button>
                  )}
                  {o.execution_status === 'handed_off' && (
                    <button className="btn btn-secondary" disabled={busyId === o.id} onClick={() => runLifecycleAction(o.id, 'record_human_completed', { notes: 'AM confirmed the change was published in WordPress.' })}>
                      Mark published in WordPress
                    </button>
                  )}
                </div>
              )}

              {['executed', 'human_completed'].includes(o.execution_status) && (
                <div className="cta-row" style={{ marginTop: 6 }}>
                  <button className="btn btn-secondary" disabled={busyId === o.id} onClick={() => runVerify(o.id)}>
                    {busyId === o.id ? 'Re-fetching live page...' : 'Re-fetch & verify live page'}
                  </button>
                </div>
              )}
              <VerifyResult verify={verify} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
