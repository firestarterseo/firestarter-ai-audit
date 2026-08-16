'use client'

import { useState } from 'react'
import { CheckRow, IssuesList } from './PillarsBoard'
import TechnicalDevAssignee from './TechnicalDevAssignee'

// Technical Foundation's wizard-style pillar detail -- same port pattern
// SchemaWizard.js established for Schema & Structure (see that file's own
// header comment), applied to workflow-mockup.html's #pane-technical.
// Every step here is grounded in lib/checkers/technical-checker.js's real
// output; nothing is invented.
//
// The mockup's "Recommended fixes" step showed 3 fixed cluster-cards
// (Performance / Crawlability & Links / SEO & Accessibility) as if the
// checker itself grouped issues that way. It doesn't -- technical-checker.js
// only ever returns a flat pillar.issues[] array, and for the Lighthouse-
// category issues (SEO/Accessibility/Best Practices) the category is baked
// into the issue's `message` string (e.g. "SEO: <title>."), not a separate
// field (confirmed by reading the checker source directly). clusterIssues()
// below derives the same 3 groups from real message patterns instead of
// fabricating a grouping the backend doesn't actually produce:
//   - Performance: Lighthouse "opportunity" audits -- message always
//     contains "(potential savings: ...)" (see collectPerformanceOpportunities).
//   - SEO & Accessibility: message starts with "SEO:", "Accessibility:", or
//     "Best Practices:" (see collectFailingAudits).
//   - Crawlability & Links: everything else -- HTTPS, robots.txt/sitemap,
//     and broken-internal-link issues, none of which fit the other two.
//
// The mockup's "Fix detail" step also had a due-date field and a
// "Create Asana task" button; those are cut, same reasoning as
// TechnicalDevAssignee.js's own header comment -- no real task-tracker
// integration exists in this repo. This step reuses that same real
// default-dev field instead of re-inventing a second assign control.
//
// The mockup's "Verify" step showed a fake "Task created in Asana" status
// track. The real, true story is simpler and needs no new capability: this
// pillar's checks (HTTPS, robots/sitemap, broken links, Core Web Vitals,
// Lighthouse categories) only ever get re-verified by running another
// audit -- so this step says that plainly and shows the same real
// checks/issues from the most recent run as "last verified," rather than
// simulating a task status that doesn't exist.

const STEP_LABELS = ['Diagnosis', 'Recommended fixes', 'Fix detail', 'Verify']

const CLUSTERS = [
  { key: 'performance', label: 'Performance', hint: 'Lighthouse opportunities with measurable estimated load-time savings.' },
  { key: 'crawlability', label: 'Crawlability & Links', hint: 'HTTPS, robots.txt/sitemap, and broken internal links.' },
  { key: 'seoAccessibility', label: 'SEO & Accessibility', hint: 'Failing Lighthouse SEO, Accessibility, and Best Practices audits.' }
]

function clusterIssues(issues) {
  const buckets = { performance: [], crawlability: [], seoAccessibility: [] }
  ;(Array.isArray(issues) ? issues : []).forEach(issue => {
    const msg = issue.message || ''
    if (msg.includes('potential savings:')) buckets.performance.push(issue)
    else if (/^(SEO|Accessibility|Best Practices):/.test(msg)) buckets.seoAccessibility.push(issue)
    else buckets.crawlability.push(issue)
  })
  return buckets
}

// Literal duplicate of PillarsBoard.js's/SchemaWizard.js's own gradeClass --
// same "small pure helper, not worth a cross-module dependency for"
// reasoning already established across this project's checker files.
function gradeClass(grade) {
  if (!grade) return 'grade-none'
  if (grade.startsWith('A')) return 'grade-a'
  if (grade.startsWith('B')) return 'grade-b'
  if (grade.startsWith('C')) return 'grade-c'
  if (grade.startsWith('D')) return 'grade-d'
  return 'grade-f'
}

export default function TechnicalFoundationWizard({ pillar, clientId, defaultDev }) {
  const [step, setStep] = useState(1)
  const clusters = clusterIssues(pillar?.issues)
  const realIssueCount = (pillar?.issues || []).filter(i => i.severity && i.severity !== 'info').length

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
      <div className="wizard-steps">
        {STEP_LABELS.map((label, i) => {
          const n = i + 1
          return (
            <button
              key={n}
              type="button"
              className={`wizard-step-chip${step === n ? ' active' : ''}`}
              onClick={() => setStep(n)}
            >
              <span className="wizard-step-num">{n}</span> {label}
            </button>
          )
        })}
      </div>

      {step === 1 && (
        <div>
          {pillar ? (
            <div className="card" style={{ padding: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <div className={`grade-badge ${gradeClass(pillar.grade)}`} style={{ width: 34, height: 34, fontSize: 14 }}>
                  {pillar.grade || '--'}
                </div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Technical Foundation</div>
              </div>
              <CheckRow checks={pillar.checks} />
              {Array.isArray(pillar.issues) && pillar.issues.length > 0 ? (
                <IssuesList issues={pillar.issues} />
              ) : (
                pillar.finding && <p style={{ fontSize: 14, margin: '6px 0' }}>{pillar.finding}</p>
              )}
            </div>
          ) : (
            <div className="card-empty" style={{ padding: 18 }}>
              <div className="text-small text-muted">Not yet audited -- run an audit to see this pillar's real checks.</div>
            </div>
          )}
          <div className="wizard-cta-row">
            <button className="btn btn-primary" onClick={() => setStep(2)}>See recommended fixes &rarr;</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          <div style={{ display: 'grid', gap: 10 }}>
            {CLUSTERS.map(c => {
              const items = clusters[c.key]
              const real = items.filter(i => i.severity && i.severity !== 'info')
              return (
                <div key={c.key} className="card" style={{ padding: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{c.label}</div>
                    <span className="pill pill-lead" style={{ marginLeft: 'auto' }}>
                      {real.length} issue{real.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <p className="text-tiny text-muted" style={{ margin: '4px 0 8px' }}>{c.hint}</p>
                  {real.length > 0 ? (
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {real.slice(0, 3).map((issue, i) => (
                        <li key={i} className="text-small" style={{ marginBottom: 2 }}>{issue.message}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-small text-muted" style={{ margin: 0 }}>No issues found in this group.</p>
                  )}
                </div>
              )
            })}
          </div>
          <div className="wizard-cta-row">
            <button className="btn btn-secondary" onClick={() => setStep(1)}>&larr; Back</button>
            <button className="btn btn-primary" onClick={() => setStep(3)}>See fix detail &rarr;</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div>
          {realIssueCount > 0 ? (
            <IssuesList issues={pillar.issues} />
          ) : (
            <div className="card-empty" style={{ padding: 18 }}>
              <div className="text-small text-muted">No open issues to fix right now.</div>
            </div>
          )}
          <TechnicalDevAssignee clientId={clientId} defaultDev={defaultDev} />
          <p className="text-tiny text-muted" style={{ margin: '10px 0 0' }}>
            There's no per-fix status tracking yet -- this sets one default developer for this client's Technical Foundation work overall, not a per-issue assignment.
          </p>
          <div className="wizard-cta-row">
            <button className="btn btn-secondary" onClick={() => setStep(2)}>&larr; Back</button>
            <button className="btn btn-primary" onClick={() => setStep(4)}>Verify &rarr;</button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div>
          <div className="card-empty" style={{ padding: 18, marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 14 }}>How this actually gets verified</div>
            <p className="text-small text-muted" style={{ margin: 0 }}>
              There's no task tracker wired up here, so nothing "completes" on its own. These checks (HTTPS, robots.txt/sitemap, broken links, Core Web Vitals, Lighthouse SEO/Accessibility/Best Practices) only get re-verified by running another audit for this client -- once a fix ships, re-run the audit and this pillar's grade and issues below will reflect it.
            </p>
          </div>
          {pillar ? (
            <div className="card" style={{ padding: 18 }}>
              <div className="text-tiny text-muted" style={{ fontWeight: 600, letterSpacing: 0.5, marginBottom: 8 }}>LAST VERIFIED (most recent audit)</div>
              <CheckRow checks={pillar.checks} />
            </div>
          ) : (
            <div className="card-empty" style={{ padding: 18 }}>
              <div className="text-small text-muted">Not yet audited.</div>
            </div>
          )}
          <div className="wizard-cta-row">
            <button className="btn btn-secondary" onClick={() => setStep(3)}>&larr; Back</button>
          </div>
        </div>
      )}
    </div>
  )
}
