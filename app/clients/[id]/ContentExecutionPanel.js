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
// below as their instructions.
//
// CLAIM vs. VERIFIED (2026-09-11 correction): a real run showed
// "Mark published in WordPress" sitting on screen as its own finished-
// looking step, with a separate "Re-fetch & verify" button next to it --
// easy to misread the first click alone as success. markLiveAndVerify()
// below is now the ONE action: it records the human's claim
// (lib/opportunityLifecycle.js#recordHumanClaimedComplete -- an additive,
// more honestly-named execution_status, not a replacement for
// recordHumanCompleted, which SourceCitationWizard/SchemaWizard keep using
// unchanged) and immediately re-fetches + compares the live page in the
// same click. A failed check leaves the Opportunity open with the
// approved plan and evidence intact; the SAME button retries verification
// with no re-handoff and no plan regeneration required.

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

  // markLiveAndVerify -- the ONE action for "I made the change, check it."
  // Deliberately a single button/handler, not two: recording
  // "human_claimed_complete" on its own used to sit on screen looking like
  // a finished step with no forced next action -- easy to misread as
  // success. This always immediately re-fetches the live page and records
  // a real verified/failed_verification result right after the claim, and
  // is the SAME action on a retry after a failed verification (the AM
  // fixes the live page, clicks this again -- no need to re-claim, re-
  // approve, or regenerate the plan; lib/opportunityLifecycle.js's verify
  // gate only cares that execution_status is already claimed-complete).
  async function markLiveAndVerify(opportunityId) {
    setBusyId(opportunityId)
    setError(null)
    try {
      const claimRes = await fetch(`/api/clients/${clientId}/opportunities/${opportunityId}/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'record_human_claimed_complete', notes: "AM confirmed: I've made these changes live in WordPress." })
      })
      const claimData = await claimRes.json()
      if (!claimRes.ok) throw new Error(claimData.error || 'Could not record the claimed change.')

      const verifyRes = await fetch(`/api/clients/${clientId}/opportunities/${opportunityId}/execution-verify`, { method: 'POST' })
      const verifyData = await verifyRes.json()
      if (!verifyRes.ok) throw new Error(verifyData.error || 'Verification failed to run.')
      setVerifyResults(prev => ({ ...prev, [opportunityId]: verifyData.result }))
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
        Prepare &rarr; Review &rarr; Approve &rarr; Publish &rarr; Re-fetch &rarr; Verify, for Opportunities generated from Prompt Gap Analysis. Nothing here publishes automatically -- there is no automated WordPress path for page content today (only JSON-LD schema has one), so publishing means an AM applies the approved change in WordPress by hand using the reviewed plan below. Clicking &ldquo;I&rsquo;ve made these changes live&rdquo; only records a CLAIM, never a completion -- it always immediately re-fetches the real live page and checks it against the approved plan, and the Opportunity only ever moves to Verified if that check actually passes. A failed check keeps the Opportunity open with the approved plan and the failed-check evidence intact -- fix the live page and click the same button again to retry, with no need to redo handoff or regenerate anything.
      </p>
      {error && <p className="field-error" style={{ marginBottom: 10 }}>{error}</p>}
      <div style={{ display: 'grid', gap: 12 }}>
        {list.map(o => {
          const review = reviews[o.id]
          const verify = verifyResults[o.id]
          return (
            <div key={o.id}>
              {(() => {
                // The approved version must be the EXACT one just reviewed
                // (or, absent a loaded review, the latest content_brief/
                // content_draft version) -- never approve with no
                // preparedWorkId, or execution-verify has nothing to verify
                // against (it always re-reads approved_prepared_work_id
                // fresh, never "whatever's newest" -- see lib/promptGapExecution.js).
                const latestContentWork = (o.preparedWork || [])
                  .filter(pw => pw.artifact_type === 'content_brief' || pw.artifact_type === 'content_draft')
                  .reduce((latest, pw) => (!latest || pw.version > latest.version) ? pw : latest, null)
                const preparedWorkIdToApprove = review?.preparedWork?.id || latestContentWork?.id || null
                return (
                  <OpportunityCard
                    opportunity={o}
                    priorityDimensions={o.priorityDimensions}
                    statusTrack={o.statusTrack}
                    preparedWork={o.preparedWork}
                    onApprove={(busyId || !preparedWorkIdToApprove) ? undefined : (opp) => runLifecycleAction(opp.id, 'approve', { preparedWorkId: preparedWorkIdToApprove })}
                    onReject={busyId ? undefined : (opp) => runLifecycleAction(opp.id, 'reject', { reason: 'am_do_nothing' })}
                  />
                )
              })()}
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

              {/* CLAIMED_COMPLETE_STATUSES: 'human_completed' (legacy rows,
                  same semantics) and 'human_claimed_complete' (the current,
                  more honestly-named value -- see
                  lib/opportunityLifecycle.js#recordHumanClaimedComplete)
                  are treated identically here -- this is a naming fix, not
                  a new rule, so an opportunity already at the old value
                  keeps working exactly the same. */}
              {o.execution_capability === 'red' && o.approval_status === 'approved' && o.verification_status !== 'verified' && (
                <div className="cta-row" style={{ marginTop: 6 }}>
                  {!['handoff_requested', 'handed_off', 'human_completed', 'human_claimed_complete'].includes(o.execution_status) && (
                    <button className="btn btn-secondary" disabled={busyId === o.id} onClick={() => runLifecycleAction(o.id, 'request_handoff', { instructions: 'Reviewed plan above is ready for manual WordPress publish.' })}>
                      Request handoff (ready to publish)
                    </button>
                  )}
                  {o.execution_status === 'handoff_requested' && (
                    <button className="btn btn-secondary" disabled={busyId === o.id} onClick={() => runLifecycleAction(o.id, 'record_handoff', { method: 'manual', reference: 'AM applying change in WordPress' })}>
                      Record handoff delivered
                    </button>
                  )}
                  {/* ONE button covers both the first claim+verify AND every
                      retry after a failed_verification -- clicking it again
                      never re-does handoff or regenerates the plan, it just
                      claims (idempotently) and immediately re-verifies. The
                      label never claims the work is done; it only ever asks
                      the AM to confirm the live state and check it. */}
                  {(o.execution_status === 'handed_off' || ['human_completed', 'human_claimed_complete'].includes(o.execution_status)) && (
                    <button className="btn btn-secondary" disabled={busyId === o.id} onClick={() => markLiveAndVerify(o.id)}>
                      {busyId === o.id
                        ? 'Verifying...'
                        : (o.verification_status === 'failed_verification' ? "I've corrected it -- verify now" : "I've made these changes live -- verify now")}
                    </button>
                  )}
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
