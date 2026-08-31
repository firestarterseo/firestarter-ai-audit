// Phase 3 -- shared Status Track component (2026-08-17).
//
// Renders the lifecycle sequence the spec calls out:
//   IDENTIFIED -> PREPARED -> APPROVED -> EXECUTED/HANDED OFF -> VERIFIED -> RETESTED
//
// Deliberately a pure presentational component: it never fetches, never
// calls an API, never computes lifecycle state itself -- it only renders
// whatever computeStatusTrack(opportunity) (lib/opportunityLifecycle.js)
// already derived from the opportunity row's real columns. This keeps the
// "no LLM/API call merely from rendering the opportunity UI" guarantee
// trivially true for this component, and keeps the single source of
// truth for lifecycle state in the DB columns, never duplicated into a
// separately-maintained UI state field.
//
// Not wired into any existing wizard yet -- Phase 3 is shared
// infrastructure only; a future pillar wizard imports this once that
// pillar's own diagnosis/prepare/approve UI exists.

const STAGE_LABEL = {
  identified: 'Identified',
  prepared: 'Prepared',
  approved: 'Approved',
  executed_or_handed_off: 'Executed / Handed off',
  verified: 'Verified',
  retested: 'Retested'
}

const STATE_STYLE = {
  completed: { bg: 'var(--grade-a)', color: '#fff', label: null },
  current: { bg: 'var(--orange)', color: '#fff', label: null },
  pending: { bg: 'var(--border)', color: 'var(--muted)', label: null },
  skipped: { bg: 'var(--border)', color: 'var(--muted)', label: '(not required)' }
}

export default function StatusTrack({ track }) {
  if (!Array.isArray(track) || track.length === 0) return null

  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4, fontSize: 12 }}>
      {track.map((step, i) => {
        const style = STATE_STYLE[step.state] || STATE_STYLE.pending
        return (
          <div key={step.stage} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span
              style={{
                padding: '3px 9px',
                borderRadius: 999,
                background: style.bg,
                color: style.color,
                fontWeight: 600,
                whiteSpace: 'nowrap'
              }}
              title={step.state}
            >
              {STAGE_LABEL[step.stage] || step.stage}
              {style.label ? ` ${style.label}` : ''}
            </span>
            {i < track.length - 1 && <span style={{ color: 'var(--border-strong)' }}>&rarr;</span>}
          </div>
        )
      })}
    </div>
  )
}
