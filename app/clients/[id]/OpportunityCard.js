// Phase 3 -- shared Opportunity Card component (2026-08-17).
//
// A reusable presentational component future pillar wizards can render
// one qualified opportunity through, following the spec's visual
// sequence: FINDING -> RECOMMENDED ACTION -> PREPARED WORK -> APPROVE ->
// EXECUTE/HANDOFF -> VERIFY. Deliberately NOT a giant generic
// project-management table -- one card, one opportunity, the same
// "mockup philosophy" the rest of this app's wizards already use.
//
// Pure/presentational: takes the already-fetched opportunity row (plus
// its priority dimensions and prepared-work versions) as props and
// renders them. It never calls fetch()/an API/an LLM itself -- every
// action (approve/reject/etc.) is a caller-supplied callback, so
// rendering this card triggers zero network or LLM calls on its own
// (same guarantee StatusTrack.js documents). Wiring it up to a real
// approve/reject API route is future pillar-implementation work, not
// part of Phase 3's shared infrastructure.
//
// Not wired into any existing wizard yet -- see this directory's other
// wizards for the existing per-pillar UI; a future pillar adds its own
// diagnosis view and then renders qualified opportunities through this
// card rather than reinventing card layout per pillar.

import StatusTrack from './StatusTrack'

const TREATMENT_LABEL = {
  highest_impact: 'Highest Impact',
  easy_win: 'Easy Win',
  do_nothing: 'Do Nothing',
  strength_protect: 'Strength / Protect'
}
const TREATMENT_COLOR = {
  highest_impact: 'var(--red)',
  easy_win: 'var(--grade-a)',
  do_nothing: 'var(--muted)',
  strength_protect: '#6d28d9'
}
const CAPABILITY_COLOR = { green: 'var(--grade-a)', yellow: 'var(--grade-c)', red: 'var(--red)' }
const CAPABILITY_LABEL = {
  green: 'GREEN -- system may execute automatically',
  yellow: 'YELLOW -- system can execute, approval required first',
  red: 'RED -- human execution / handoff required'
}

function Dimension({ label, dim }) {
  if (!dim) return null
  return (
    <div style={{ fontSize: 12 }}>
      <strong style={{ textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--muted)' }}>{label}:</strong>{' '}
      <span>{dim.level}</span>
      {dim.reasoning && <span style={{ color: 'var(--muted)' }}> -- {dim.reasoning}</span>}
    </div>
  )
}

export default function OpportunityCard({
  opportunity, priorityDimensions, statusTrack, preparedWork = [],
  onApprove, onEditThenApprove, onReject, onRequestVerification
}) {
  if (!opportunity) return null
  const o = opportunity
  const latestByType = {}
  for (const pw of preparedWork) {
    if (!latestByType[pw.artifact_type] || pw.version > latestByType[pw.artifact_type].version) latestByType[pw.artifact_type] = pw
  }
  const latestVersions = Object.values(latestByType)

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 16, boxShadow: 'var(--shadow-sm)', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Header: treatment + execution capability, never conflated -- see module header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{o.title}</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{o.pillar}{o.originating_pillar && o.originating_pillar !== o.pillar ? ` (routed from ${o.originating_pillar})` : ''}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {o.priority_treatment && (
            <span style={{ padding: '3px 10px', borderRadius: 999, background: TREATMENT_COLOR[o.priority_treatment] || 'var(--muted)', color: '#fff', fontSize: 12, fontWeight: 600 }}>
              {TREATMENT_LABEL[o.priority_treatment] || o.priority_treatment}
            </span>
          )}
          {o.execution_capability && (
            <span title={CAPABILITY_LABEL[o.execution_capability]} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--muted)' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: CAPABILITY_COLOR[o.execution_capability], display: 'inline-block' }} />
              {o.execution_capability.toUpperCase()}
            </span>
          )}
        </div>
      </div>

      {/* FINDING -- evidence summary */}
      {Array.isArray(o.evidence) && o.evidence.length > 0 && (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Finding &amp; evidence ({o.evidence.length})</summary>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13 }}>
            {o.evidence.map((e, i) => <li key={i} style={{ marginBottom: 4 }}>{e.text}{e.source ? <span style={{ color: 'var(--muted)' }}> ({e.source})</span> : null}</li>)}
          </ul>
        </details>
      )}

      {/* RECOMMENDED ACTION -- why it received its treatment, dimensions kept separate */}
      {priorityDimensions && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, background: 'var(--bg-alt)', borderRadius: 'var(--radius-sm)', padding: 10 }}>
          <Dimension label="Impact" dim={priorityDimensions.impact} />
          <Dimension label="Effort" dim={priorityDimensions.effort} />
          <Dimension label="Automation capability" dim={priorityDimensions.automation_capability} />
          <Dimension label="Evidence strength" dim={priorityDimensions.evidence_strength} />
          <Dimension label="Commercial relevance" dim={priorityDimensions.commercial_relevance} />
          {o.priority_assessment?.treatment_reasoning && (
            <div style={{ fontSize: 13, marginTop: 4 }}><strong>Why:</strong> {o.priority_assessment.treatment_reasoning}</div>
          )}
        </div>
      )}

      {/* PREPARED WORK */}
      {latestVersions.length > 0 && (
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Prepared work</div>
          {latestVersions.map(pw => (
            <div key={pw.id} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 8, marginBottom: 6, fontSize: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span><strong>{pw.artifact_type}</strong> v{pw.version}</span>
                <span style={{ color: pw.status === 'preparation_failed' ? 'var(--red)' : 'var(--muted)' }}>
                  {pw.status === 'preparation_failed' ? 'PREPARATION FAILED / NEEDS ATTENTION' : pw.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* APPROVE */}
      {o.approval_status && o.approval_status !== 'not_required' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>Approval: <strong>{o.approval_status}</strong></span>
          {o.approval_status === 'pending' && (
            <>
              <button onClick={() => onApprove && onApprove(o)} style={{ fontSize: 12 }}>Approve</button>
              <button onClick={() => onEditThenApprove && onEditThenApprove(o)} style={{ fontSize: 12 }}>Edit then approve</button>
              <button onClick={() => onReject && onReject(o)} style={{ fontSize: 12 }}>Reject / Do nothing</button>
            </>
          )}
        </div>
      )}

      {/* VERIFY */}
      {o.verification_status && o.verification_status !== 'not_ready' && (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
          Verification: <strong>{o.verification_status}</strong>
          {o.verification_status === 'ready_to_verify' && onRequestVerification && (
            <button onClick={() => onRequestVerification(o)} style={{ marginLeft: 8, fontSize: 12 }}>Verify now</button>
          )}
        </div>
      )}

      {/* Status Track */}
      {statusTrack && <StatusTrack track={statusTrack} />}
    </div>
  )
}
