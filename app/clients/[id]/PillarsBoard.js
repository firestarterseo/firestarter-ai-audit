'use client'

import { useState } from 'react'

// Dashboard view for a client's 5 pillars -- replaces what used to be one
// long scroll of fully-expanded cards. Per direct feedback: as more pillars
// get real content (checks, issues, evidence) and embedded tools (Schema
// Generator + WordPress publish, AI-visibility test-prompt tools), that
// all-expanded-all-the-time layout stopped being scannable. This shows a
// compact tile per pillar (grade + one-line status) and expands the full
// detail in place on click -- no navigation, no page reload. Only one
// pillar is expanded at a time (a single-open accordion): opening a
// second tile closes whichever one was already open, so clicking
// through several pillars doesn't just rebuild the same long scroll
// this redesign replaced.
//
// `pillars` is plain data prepared server-side in page.js:
//   [{ key, label, pillar, notYetBuilt, children }]
// `children` (e.g. <SchemaGenerator/>, the AI-visibility test-prompt
// tools) is JSX already resolved server-side and passed straight through --
// this Client Component never needs to know what's inside it.

function gradeClass(grade) {
  if (!grade) return 'grade-none'
  if (grade.startsWith('A')) return 'grade-a'
  if (grade.startsWith('B')) return 'grade-b'
  if (grade.startsWith('C')) return 'grade-c'
  if (grade.startsWith('D')) return 'grade-d'
  return 'grade-f'
}

const CHECK_ICON = { pass: '✓', partial: '✗', fail: '✗', not_verified: '–' }
const CHECK_COLOR = { pass: 'var(--grade-a)', partial: 'var(--grade-d)', fail: 'var(--grade-f)', not_verified: 'var(--grade-none)' }

// Exported (Phase 3) so SchemaWizard.js can reuse the exact same check/
// issue rendering for its Diagnosis step instead of re-implementing it --
// same real pillar.checks/pillar.issues shape either way.
export function CheckRow({ checks }) {
  if (!Array.isArray(checks) || checks.length === 0) return null
  return (
    <div style={{ display: 'grid', gap: 5, margin: '10px 0' }}>
      {checks.map((c, i) => (
        <div key={i} className="text-small" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 16, height: 16, borderRadius: '50%', fontSize: 10, fontWeight: 700, flexShrink: 0,
            background: CHECK_COLOR[c.status] || 'var(--grade-none)', color: '#fff', lineHeight: 1
          }}>
            {CHECK_ICON[c.status] || '–'}
          </span>
          <span className={c.status === 'not_verified' ? 'text-muted' : undefined}>
            {c.label}{c.status === 'not_verified' ? ' -- not verified' : ''}
          </span>
        </div>
      ))}
    </div>
  )
}

const ISSUE_SEVERITY_RANK = { critical: 0, moderate: 1, minor: 2, info: 3 }
const ISSUE_SEVERITY_LABEL = { critical: 'Critical', moderate: 'Moderate', minor: 'Minor', info: 'Not verified' }

export function IssuesList({ issues }) {
  if (!Array.isArray(issues) || issues.length === 0) return null
  const sorted = [...issues].sort((a, b) => (ISSUE_SEVERITY_RANK[a.severity] ?? 4) - (ISSUE_SEVERITY_RANK[b.severity] ?? 4))
  return (
    <div style={{ display: 'grid', gap: 8, margin: '10px 0' }}>
      {sorted.map((issue, i) => (
        <div key={i} className="issue-item">
          <span className={`issue-badge issue-${issue.severity || 'info'}`}>
            {ISSUE_SEVERITY_LABEL[issue.severity] || issue.severity}
          </span>
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>{issue.message}</div>
          {issue.why && <p className="text-small issue-why">{issue.why}</p>}
          {issue.recommendation && (
            <p className="text-small" style={{ margin: '4px 0 0', color: 'var(--text)' }}>
              <b>Fix:</b> {issue.recommendation}
            </p>
          )}
        </div>
      ))}
    </div>
  )
}

// AI & GEO Visibility-specific transparency view -- shows exactly what each
// engine said for each prompt so a strategist can manually re-run the same
// prompt and compare, not just trust a grade.
function AiVisibilityVerify({ raw, snapshot }) {
  if (!raw) return null
  const rows = snapshot
    ? (Array.isArray(raw.engineResults) ? raw.engineResults : [])
    : (Array.isArray(raw.latestBreakdown) ? raw.latestBreakdown : [])
  if (rows.length === 0) return null

  return (
    <details className="raw-details">
      <summary>Verify these results -- engine by engine ({rows.length})</summary>
      <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
        {rows.map((r, i) => (
          <div key={i} className="issue-item">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="issue-badge" style={{ background: r.weight >= 2 ? 'var(--orange)' : 'var(--muted-2)' }}>
                {r.engine}{r.weight >= 2 ? ' -- high priority' : ''}
              </span>
              <span className="text-small text-muted">&ldquo;{r.prompt}&rdquo;</span>
            </div>
            {r.ok === false ? (
              <p className="text-small" style={{ margin: '6px 0 0', color: 'var(--grade-f)' }}>Call failed: {r.error || 'unknown error'}</p>
            ) : (
              <>
                <p className="text-small" style={{ margin: '6px 0 0' }}>
                  {r.mentioned ? '✓ Mentioned' : '✗ Not mentioned'}
                  {r.mentioned ? (r.cited ? ' · ✓ cited own domain' : ' · not cited from own domain') : ''}
                  {r.sentiment ? ` · sentiment: ${r.sentiment}` : ''}
                </p>
                {r.responseSnippet && (
                  <p className="text-small text-muted" style={{ margin: '4px 0 0', fontStyle: 'italic' }}>
                    &ldquo;{r.responseSnippet}{r.responseSnippet.length >= 400 ? '…' : ''}&rdquo;
                  </p>
                )}
                {Array.isArray(r.ownDomainSourceUrls) && r.ownDomainSourceUrls.length > 0 && (
                  <p className="text-tiny" style={{ margin: '4px 0 0', color: 'var(--grade-a)', wordBreak: 'break-all' }}>
                    ✓ Cited from your own domain: {r.ownDomainSourceUrls.join(', ')}
                  </p>
                )}
                {(() => {
                  const own = Array.isArray(r.ownDomainSourceUrls) ? r.ownDomainSourceUrls : []
                  const otherSources = (Array.isArray(r.sourceUrls) ? r.sourceUrls : []).filter(u => !own.includes(u))
                  if (otherSources.length === 0) return null
                  return (
                    <p className="text-tiny text-muted" style={{ margin: '4px 0 0', wordBreak: 'break-all' }}>
                      {r.mentioned
                        ? 'Other sources in this answer (not your domain, for context only): '
                        : 'Not your domain -- this is who/what the engine cited instead: '}
                      {otherSources.join(', ')}
                    </p>
                  )
                })()}
              </>
            )}
          </div>
        ))}
      </div>
    </details>
  )
}

// The full detail panel -- exactly what used to always be visible in the
// old PillarCard, now only rendered when a tile is expanded.
function PillarDetail({ pillarKey, label, pillar, notYetBuilt, children }) {
  if (!pillar) {
    if (notYetBuilt) {
      return (
        <div className="card-empty" style={{ padding: 18 }}>
          <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 14 }}>{label}</div>
          <div className="text-small text-muted">Not yet built -- blocked on a backlink/rank-tracking vendor decision.</div>
        </div>
      )
    }
    return (
      <div className="card" style={{ padding: 18 }}>
        <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 14 }}>{label}</div>
        <div className="text-small text-muted" style={{ marginBottom: children ? 14 : 0 }}>Not yet audited.</div>
        {children}
      </div>
    )
  }

  return (
    <div className="card" style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div className={`grade-badge ${gradeClass(pillar.grade)}`} style={{ width: 34, height: 34, fontSize: 14 }}>
          {pillar.grade || '--'}
        </div>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{label}</div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {pillar.grade == null && (
            <span className="pill pill-lead">not yet graded -- excluded from overall score</span>
          )}
          {pillar.partial && (
            <span className="pill pill-lead" title={pillar.possible_points != null ? `Only ${pillar.possible_points}/100 possible points could be verified this run` : undefined}>
              partial -- {pillar.possible_points ?? '?'}/100 checked
            </span>
          )}
          {pillar.snapshot && (
            <span
              className="pill pill-snapshot"
              title="A one-off live check run right now, not a recurring measurement. Only 'tracked' clients build up real history over time via the weekly cron job -- a 'lead' always gets a fresh snapshot instead, each audit."
            >
              snapshot, not tracked
            </span>
          )}
        </div>
      </div>
      <CheckRow checks={pillar.checks} />
      {Array.isArray(pillar.issues) && pillar.issues.length > 0 ? (
        <IssuesList issues={pillar.issues} />
      ) : (
        <>
          {pillar.finding && <p style={{ fontSize: 14, margin: '6px 0' }}>{pillar.finding}</p>}
          {pillar.recommendation && (
            <p className="text-small" style={{ margin: '6px 0', color: 'var(--text)' }}>
              <b>Recommendation:</b> {pillar.recommendation}
            </p>
          )}
        </>
      )}
      {Array.isArray(pillar.evidence) && pillar.evidence.length > 0 && (
        <details className="raw-details">
          <summary>Raw technical details ({pillar.evidence.length})</summary>
          <ul className="evidence-list">
            {pillar.evidence.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </details>
      )}
      {pillarKey === 'ai_geo_visibility' && <AiVisibilityVerify raw={pillar.raw} snapshot={pillar.snapshot} />}
      {children}
    </div>
  )
}

// 2026-08-16: replaced the tile-grid + expand-in-place accordion with the
// prototype's actual top-level tab bar (workflow-mockup.html's
// .toplevel-tabs -- one pane visible at a time, switched by clicking a
// tab), per direct instruction to standardize on the prototype's real
// shell rather than a similar-but-different bespoke layout. This also
// retires the tile-grid's own real layout bug (a fixed 3-column grid was
// a stopgap fix for 6 tiles wrapping 5-then-1; a tab bar has no such
// wrapping problem at all, at any pillar count).
//
// Trade-off worth knowing about: the tile grid showed every pillar's grade
// at a glance without clicking into each one; the prototype's tabs don't
// (its tabs are plain index + label, no grade badge -- confirmed directly
// against the mockup's own CSS/markup, not assumed). This port matches
// that exactly rather than inventing a hybrid. The "Overall Score" tile
// above the tabs (unchanged, not part of the prototype, kept because it
// predates this redesign and doesn't conflict with it) still gives an
// at-a-glance read on the client overall; if losing per-pillar at-a-glance
// grades turns out to matter in practice, a small grade indicator could be
// added back onto each tab without touching this structure.
export default function PillarsBoard({ pillars, defaultActive }) {
  const [activeKey, setActiveKey] = useState(defaultActive ?? pillars[0]?.key ?? null)
  const active = pillars.find(p => p.key === activeKey) || pillars[0]

  return (
    <>
      <div className="toplevel-tabs">
        {pillars.map((p, i) => (
          <button
            key={p.key}
            type="button"
            className={`${p.notYetBuilt ? 'proposed' : ''}${activeKey === p.key ? ' active' : ''}`.trim() || undefined}
            onClick={() => setActiveKey(p.key)}
          >
            <span className="idx">{i + 1}</span> {p.label}
            {p.notYetBuilt && <span className="concept-badge">concept</span>}
          </button>
        ))}
      </div>

      {active && (
        // customDetail (Phase 3) lets a specific pillar (e.g. Schema &
        // Structure's step-by-step wizard) fully replace the generic
        // grade-badge/checks/issues rendering below, instead of just
        // appending extra content via `children` on top of it. Built in
        // page.js (a Server Component, same place `children` is already
        // resolved) so this Client Component still never needs to know
        // what SchemaWizard/etc. actually are -- same "just some JSX"
        // contract `children` already established.
        active.customDetail
          ? <div key={active.key}>{active.customDetail}</div>
          : (
            <PillarDetail key={active.key} pillarKey={active.key} label={active.label} pillar={active.pillar} notYetBuilt={active.notYetBuilt}>
              {active.children}
            </PillarDetail>
          )
      )}
    </>
  )
}
