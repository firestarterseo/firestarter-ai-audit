'use client'

// PROMPT GAP EXECUTION PANEL (2026-09-10) -- lets an AM take an already-
// approved-ready Content/Relevance execution plan (see
// lib/promptGapPreparedWork.js) and actually carry it through Prepare ->
// Review -> Approve -> Publish -> Re-fetch -> Verify, reusing the exact
// same primitives app/clients/[id]/SourceCitationWizard.js already
// established for its own RED/manual-execution opportunities: the generic
// app/api/clients/[id]/opportunities/[opportunityId]/lifecycle route for
// approve/reject/handoff. The "current vs proposed" review (a fresh
// live-page fetch, never the stale snapshot from generation time) and the
// "Re-fetch & verify" step really re-fetch the live page and check the
// approved title/H1 are actually present rather than asking the AM to
// self-attest (see lib/promptGapExecution.js).
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
//
// DECISION-DASHBOARD REDESIGN (2026-09-11, presentation-only): the active-
// opportunity card moved into PromptGapOpportunityCard.js -- what to do /
// why / how confident, up front, with raw evidence, full proposed-work
// detail, and prepared-work/verification history behind collapsed
// sections. Nothing about analysis, qualification, prepared-work
// generation, or lifecycle transitions changed; this file still owns all
// the actual data fetching and the callbacks the new card's buttons call.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import OpportunityCard from './OpportunityCard'
import PromptGapOpportunityCard, { ACTION_TYPE_LABEL, ProposedWorkDetail } from './PromptGapOpportunityCard'

// DISPOSITION_REASON_LABEL -- human-readable text for
// lib/opportunityLifecycle.js's DISPOSITION_REASONS enum, only the values
// this panel's own dismissals actually use (reject/duplicate/weak-evidence
// paths) plus a couple of generically-likely ones. Falls back to the raw
// enum value itself for anything not listed here -- never hidden, just
// unformatted.
const DISPOSITION_REASON_LABEL = {
  weak_evidence: 'The evidence that originally supported this no longer holds up',
  duplicate: 'Superseded by a different, correctly-targeted Opportunity',
  issue_no_longer_exists: 'The underlying issue no longer exists',
  am_do_nothing: 'An AM marked this Do Nothing',
  am_rejected: 'An AM rejected this',
  low_commercial_relevance: 'Low commercial relevance',
  already_adequately_represented: 'Already adequately represented',
  no_legitimate_intervention: 'No legitimate intervention available'
}

// DismissedOpportunityNotice -- the MAIN, active-looking summary for a
// dismissed/invalidated Opportunity (2026-09-11 fix). Previously a
// dismissed Opportunity still rendered its full OpportunityCard (Finding &
// evidence, Prepared work) exactly like an active one, with only a small
// "Do Nothing" pill to signal otherwise -- easy to misread the stale
// evidence/plan below it as a live recommendation, especially once the
// gap_diagnosis snapshot on `detail` (frozen at whatever it was on the
// analysis run that qualified the Opportunity) no longer matches a LATER,
// corrected analysis that found no gap and is why this got dismissed in
// the first place -- exactly what happened to the real
// "custom windows denver" / /denver-custom-window-replacement/ Opportunity
// after the prompt-location fix. Rather than trying to keep `detail`
// "live-synced" to the latest prompt_gap_analyses row (a real change to
// gap-analysis/qualification plumbing, out of scope here), this shows the
// disposition reason/detail -- already durably stored on the row via
// rejectOpportunity's disposition_reason/disposition_detail columns --
// as the headline fact, and demotes the stale evidence/plan to a clearly-
// labeled, collapsed history section (see the render loop below).
function DismissedOpportunityNotice({ opportunity }) {
  const o = opportunity
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 16, background: 'var(--bg-alt)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>{o.title}</div>
        <span style={{ padding: '3px 10px', borderRadius: 999, background: 'var(--muted)', color: '#fff', fontSize: 12, fontWeight: 600 }}>Do Nothing</span>
      </div>
      <div style={{ fontSize: 13, marginTop: 8 }}>
        <strong>Why:</strong> {DISPOSITION_REASON_LABEL[o.disposition_reason] || o.disposition_reason || 'No longer supported by the current gap analysis.'}
      </div>
      {o.disposition_detail?.note && (
        <p className="text-small" style={{ marginTop: 6 }}>{o.disposition_detail.note}</p>
      )}
      <p className="text-tiny text-muted" style={{ marginTop: 8 }}>
        This Opportunity is dismissed -- nothing below is an active recommendation. Any prepared work generated before this dismissal is kept for history only (see &ldquo;Previous analysis&rdquo;).
      </p>
    </div>
  )
}

export default function ContentExecutionPanel({ clientId, clientName, opportunities }) {
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
          const isDismissed = o.status === 'dismissed'
          const hasHistoryToShow = (o.preparedWork?.length > 0) || (o.evidence?.length > 0)

          if (isDismissed) {
            return (
              <div key={o.id}>
                <DismissedOpportunityNotice opportunity={o} />
                {hasHistoryToShow && (
                  <details style={{ marginTop: 6 }}>
                    <summary className="text-tiny text-muted" style={{ cursor: 'pointer' }}>
                      Previous analysis (superseded -- {o.preparedWork?.length || 0} prepared-work version{o.preparedWork?.length === 1 ? '' : 's'})
                    </summary>
                    <div style={{ marginTop: 8, opacity: 0.65 }}>
                      <p className="text-tiny text-muted" style={{ margin: '0 0 8px' }}>
                        Kept for audit purposes only -- generated before this Opportunity was dismissed, no longer an active recommendation. No approve/execute/verify actions are available here.
                      </p>
                      <OpportunityCard
                        opportunity={o}
                        priorityDimensions={o.priorityDimensions}
                        statusTrack={o.statusTrack}
                        preparedWork={o.preparedWork}
                      />
                      <div className="cta-row" style={{ marginTop: 6 }}>
                        <button className="btn btn-secondary" disabled={busyId === o.id} onClick={() => loadReview(o.id)}>
                          {busyId === o.id ? 'Loading...' : review ? 'Refresh historical plan' : 'Show historical plan (superseded)'}
                        </button>
                      </div>
                      {review && (
                        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 10, marginTop: 6, background: 'var(--bg-alt)' }}>
                          <div className="text-tiny text-muted" style={{ fontWeight: 700, textTransform: 'uppercase', marginBottom: 6 }}>
                            SUPERSEDED -- {ACTION_TYPE_LABEL[review.actionType] || review.actionType}
                          </div>
                          <ProposedWorkDetail review={review} />
                        </div>
                      )}
                    </div>
                  </details>
                )}
              </div>
            )
          }

          return (
            <PromptGapOpportunityCard
              key={o.id}
              clientName={clientName}
              opportunity={o}
              review={review}
              verify={verify}
              busy={busyId === o.id}
              onLoadReview={() => loadReview(o.id)}
              onApprove={() => {
                const latestContentWork = (o.preparedWork || [])
                  .filter(pw => pw.artifact_type === 'content_brief' || pw.artifact_type === 'content_draft')
                  .reduce((latest, pw) => (!latest || pw.version > latest.version) ? pw : latest, null)
                // The approved version must be the EXACT one just reviewed
                // (or, absent that, the latest content_brief/content_draft
                // version) -- never approve with no preparedWorkId, or
                // execution-verify has nothing to verify against (it
                // always re-reads approved_prepared_work_id fresh, never
                // "whatever's newest" -- see lib/promptGapExecution.js).
                const preparedWorkIdToApprove = review?.preparedWork?.id || latestContentWork?.id || null
                if (!preparedWorkIdToApprove) { setError('No prepared-work version available to approve.'); return }
                runLifecycleAction(o.id, 'approve', { preparedWorkId: preparedWorkIdToApprove })
              }}
              onReject={() => runLifecycleAction(o.id, 'reject', { reason: 'am_do_nothing' })}
              onRequestHandoff={() => runLifecycleAction(o.id, 'request_handoff', { instructions: 'Reviewed plan above is ready for manual WordPress publish.' })}
              onRecordHandoff={() => runLifecycleAction(o.id, 'record_handoff', { method: 'manual', reference: 'AM applying change in WordPress' })}
              onMarkLiveAndVerify={() => markLiveAndVerify(o.id)}
            />
          )
        })}
      </div>
    </div>
  )
}
