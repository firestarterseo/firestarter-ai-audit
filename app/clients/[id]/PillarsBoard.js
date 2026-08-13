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

// A short, scannable line for the collapsed tile -- counts real
// (critical/moderate/minor) issues distinctly from "info" ones, which mean
// a data gap (no API key configured, etc.), not the site actually failing
// something, same distinction the old fully-expanded view already made.
function oneLinerStatus(pillar, notYetBuilt) {
  if (notYetBuilt) return 'Not yet built -- blocked on a vendor decision.'
  if (!pillar) return 'Not yet audited.'
  if (pillar.grade == null) return 'Not yet graded -- excluded from overall score.'
  const issues = Array.isArray(pillar.issues) ? pillar.issues : []
  const real = issues.filter(i => i.severity && i.severity !== 'info')
  if (real.length > 0) {
    const counts = { critical: 0, moderate: 0, minor: 0 }
    real.forEach(i => { counts[i.severity] = (counts[i.severity] || 0) + 1 })
    const parts = ['critical', 'moderate', 'minor'].filter(s => counts[s]).map(s => `${counts[s]} ${s}`)
    return `${parts.join(', ')} issue${real.length === 1 ? '' : 's'}`
  }
  if (issues.length > 0) return `${issues.length} data gap${issues.length === 1 ? '' : 's'} -- not verified.`
  return pillar.finding || 'No issues found.'
}

const CHECK_ICON = { pass: '✓', partial: '✗', fail: '✗', not_verified: '–' }
const CHECK_COLOR = { pass: 'var(--grade-a)', partial: 'var(--grade-d)', fail: 'var(--grade-f)', not_verified: 'var(--grade-none)' }

function CheckRow({ checks }) {
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

function IssuesList({ issues }) {
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

export default function PillarsBoard({ pillars, defaultExpanded = [] }) {
  // Single-open accordion, not independent per-tile toggles: opening a
  // second pillar closes whichever one was open. Per direct feedback --
  // clicking through several tiles was leaving all of them expanded at
  // once, back to the same long-scroll problem this redesign was meant to
  // fix. `expandedKey` is the one open pillar's key, or null.
  const [expandedKey, setExpandedKey] = useState(defaultExpanded[0] ?? null)

  function toggle(key) {
    setExpandedKey(k => (k === key ? null : key))
  }

  return (
    <>
      <div className="pillar-tile-grid">
        {pillars.map(p => (
          <button
            key={p.key}
            type="button"
            className={`pillar-tile${expandedKey === p.key ? ' expanded' : ''}`}
            onClick={() => toggle(p.key)}
            aria-expanded={expandedKey === p.key}
          >
            <div className="pillar-tile-top">
              <div className={`grade-badge ${gradeClass(p.pillar?.grade)}`} style={{ width: 30, height: 30, fontSize: 12 }}>
                {p.notYetBuilt ? '–' : (p.pillar?.grade || '--')}
              </div>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{p.label}</div>
              <svg className="pillar-tile-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </div>
            <div className="pillar-tile-status">{oneLinerStatus(p.pillar, p.notYetBuilt)}</div>
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gap: 12 }}>
        {pillars.filter(p => p.key === expandedKey).map(p => (
          <PillarDetail key={p.key} pillarKey={p.key} label={p.label} pillar={p.pillar} notYetBuilt={p.notYetBuilt}>
            {p.children}
          </PillarDetail>
        ))}
      </div>
    </>
  )
}
