'use client'

import { useState } from 'react'
import { CheckRow, IssuesList, pillarHeadline, StepChips } from './PillarsBoard'
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

// technicalStatPills(pillar) -- 2026-08-16. Diagnosis step 1 was rendering
// the generic CheckRow (checkmark/X bullet list) + IssuesList (red
// "CRITICAL" cards) here instead of the mockup's own SOLID/WATCH/OPPORTUNITY
// stat-pill-row -- the exact same gap Schema & Structure's Diagnosis step
// had before it got the same treatment. Fixed the same way: real numbers,
// not the mockup's illustrative "6 broken" / "~2.1s".
//
// None of these needed a new checker capability or a fresh audit run --
// unlike Schema's sitemapPageCount, every number here was ALREADY being
// computed and persisted by technical-checker.js on every run to date, just
// folded into plain-English evidence/issue strings instead of a structured
// _raw field. Parsing those strings (rather than requiring a backend change
// + a fresh audit before this could ever render for real) means this works
// immediately, on runs that already exist:
//   - broken-link count: checkBrokenLinks always pushes an evidence line
//     "Checked N internal links; M broken." when the check actually ran,
//     whether or not any were broken -- unlike its issue (only pushed when
//     M > 0), so evidence is the reliable source for "0 broken" too.
//   - load-time savings: each Lighthouse "opportunity" audit becomes its
//     own issue with "(potential savings: ~Xms)" in its message (see
//     collectPerformanceOpportunities) -- summed across all of them for one
//     real aggregate number, same "~2.1s" framing the mockup uses, just
//     computed instead of invented.
function technicalStatPills(pillar) {
  const checks = pillar?.checks || []
  const checksTotal = checks.length || 5
  const checksPassing = checks.filter(c => c.status === 'pass').length
  const passRatio = checksTotal > 0 ? checksPassing / checksTotal : 0

  const evidence = pillar?.evidence || []
  const brokenMatch = evidence.map(e => /Checked \d+ internal links?; (\d+) broken/i.exec(e)).find(Boolean)
  const brokenCount = brokenMatch ? parseInt(brokenMatch[1], 10) : null

  const savingsMatches = (pillar?.issues || [])
    .map(i => /potential savings: ~(\d+)ms/i.exec(i.message || ''))
    .filter(Boolean)
    .map(m => parseInt(m[1], 10))
  const totalSavingsMs = savingsMatches.length > 0 ? savingsMatches.reduce((a, b) => a + b, 0) : null

  return [
    {
      key: 'solid',
      tone: passRatio >= 0.85 ? 'good' : passRatio >= 0.5 ? 'caution' : 'bad',
      eyebrow: passRatio >= 0.85 ? '▲ Solid' : '▼ Gaps',
      value: `${checksPassing} / ${checksTotal}`,
      desc: 'foundational checks passing'
    },
    {
      key: 'watch',
      tone: brokenCount === null ? null : brokenCount === 0 ? 'good' : 'caution',
      eyebrow: brokenCount === null ? '● Not checked' : brokenCount === 0 ? '▲ None found' : '● Watch',
      value: brokenCount === null ? '--' : brokenCount === 0 ? '0' : `${brokenCount} broken`,
      desc: 'internal links (4xx/5xx)'
    },
    {
      key: 'opportunity',
      tone: totalSavingsMs === null ? null : totalSavingsMs >= 1000 ? 'gap' : 'caution',
      eyebrow: totalSavingsMs === null ? '● Not checked' : '▼ Opportunity',
      value: totalSavingsMs === null ? '--' : `~${(totalSavingsMs / 1000).toFixed(1)}s`,
      desc: 'Lighthouse load-time savings'
    }
  ]
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
  const [selectedPill, setSelectedPill] = useState(null)
  const clusters = clusterIssues(pillar?.issues)
  const realIssueCount = (pillar?.issues || []).filter(i => i.severity && i.severity !== 'info').length
  const pills = pillar ? technicalStatPills(pillar) : []

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
      <StepChips labels={STEP_LABELS} step={step} onStep={setStep} />

      {step === 1 && (
        <div>
          {pillar ? (
            <div className="card" style={{ padding: 20 }}>
              <div className="grade-row">
                <div className={`grade-badge ${gradeClass(pillar.grade)}`} style={{ width: 34, height: 34, fontSize: 17 }}>
                  {pillar.grade || '--'}
                </div>
                <div>
                  <div className="grade-title">{pillarHeadline('Technical Foundation', pillar)}</div>
                  {pillar.finding && <div className="grade-sub">{pillar.finding}</div>}
                </div>
              </div>
              <div className="stat-pill-row">
                {pills.map(p => (
                  <div
                    key={p.key}
                    className={`stat-pill clickable${p.tone ? ` ${p.tone}` : ''}${selectedPill === p.key ? ' active' : ''}`}
                    onClick={() => setSelectedPill(k => k === p.key ? null : p.key)}
                  >
                    <div className="eyebrow">{p.eyebrow}</div>
                    <div className="v">{p.value}</div>
                    <div className="d">{p.desc}</div>
                  </div>
                ))}
              </div>
              {selectedPill && (
                <div className="pill-detail show">
                  {selectedPill === 'solid' && <CheckRow checks={pillar.checks} />}
                  {selectedPill === 'watch' && (
                    <p className="pd-lead" style={{ margin: 0 }}>
                      {(() => {
                        const brokenIssues = (pillar.issues || []).filter(i => /broken internal link/i.test(i.message || ''))
                        if (brokenIssues.length > 0) return brokenIssues[0].message
                        const evidenceLine = (pillar.evidence || []).find(e => /Checked \d+ internal links?/i.test(e))
                        return evidenceLine || 'Not checked on the most recent run.'
                      })()}
                    </p>
                  )}
                  {selectedPill === 'opportunity' && (
                    (() => {
                      const opportunityIssues = (pillar.issues || []).filter(i => /potential savings:/i.test(i.message || ''))
                      if (opportunityIssues.length === 0) {
                        return <p className="pd-lead" style={{ margin: 0 }}>No Lighthouse performance opportunities with measurable savings on the most recent run.</p>
                      }
                      return <CheckRow checks={opportunityIssues.map(i => ({ label: i.message, status: 'fail' }))} />
                    })()
                  )}
                </div>
              )}
              {Array.isArray(pillar.issues) && pillar.issues.length > 0 && !selectedPill && <IssuesList issues={pillar.issues} />}
            </div>
          ) : (
            <div className="card-empty" style={{ padding: 18 }}>
              <div className="text-small text-muted">Not yet audited -- run an audit to see this pillar's real checks.</div>
            </div>
          )}
          <div className="cta-row">
            <button className="btn btn-primary" onClick={() => setStep(2)}>See recommended fixes &rarr;</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          <div className="cluster-grid">
            {CLUSTERS.map(c => {
              const items = clusters[c.key]
              const real = items.filter(i => i.severity && i.severity !== 'info')
              const hasCritical = real.some(i => i.severity === 'critical')
              return (
                <div key={c.key} className="cluster-card">
                  <div className="name">{c.label}</div>
                  <div className="meta">{real.length} issue{real.length === 1 ? '' : 's'} found</div>
                  <span className={`tag ${real.length === 0 ? 'good' : hasCritical ? 'critical' : 'gap'}`}>
                    {real.length === 0 ? 'Clear' : hasCritical ? 'Critical' : 'Needs attention'}
                  </span>
                  <div className="kws">
                    {real.length > 0
                      ? real.slice(0, 3).map(i => i.message).join(' ')
                      : c.hint}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="cta-row">
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
          <div className="cta-row">
            <button className="btn btn-secondary" onClick={() => setStep(2)}>&larr; Back</button>
            <button className="btn btn-primary" onClick={() => setStep(4)}>Verify &rarr;</button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div>
          {/* .callout, not .concept-banner -- this is true, real information
              (an honest limitation), not illustrative/proposed content, so
              it shouldn't borrow the "not real yet" visual language. */}
          <div className="callout">
            <b>How this actually gets verified:</b> there's no task tracker wired up here, so nothing "completes" on its own. These checks (HTTPS, robots.txt/sitemap, broken links, Core Web Vitals, Lighthouse SEO/Accessibility/Best Practices) only get re-verified by running another audit for this client -- once a fix ships, re-run the audit and this pillar's grade and issues below will reflect it.
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
          <div className="cta-row">
            <button className="btn btn-secondary" onClick={() => setStep(3)}>&larr; Back</button>
          </div>
        </div>
      )}
    </div>
  )
}
