'use client'

import { useState } from 'react'
import { CheckRow, IssuesList, pillarHeadline, StepChips } from './PillarsBoard'

// Entity & Citation Authority's wizard-style pillar detail -- same port
// pattern SchemaWizard.js / TechnicalFoundationWizard.js / ContentAuthorityWizard.js
// established, applied to workflow-mockup.html's #pane-entity. This pillar
// went from "not yet built" (a proposed concept pane, GBP/Person-schema
// illustrative content only) to a real, wired-in 6th pillar mid-session --
// see lib/checkers/entity-citation-authority-checker.js's own header. That
// checker measures two REAL signals this project already collects/pays
// for: real backlinks from a recognized authority domain (Ahrefs), and
// what share of tracked AI-visibility mentions cite one. It does NOT check
// Google Business Profile claim status, review/directory profile
// completeness, or Person schema/author bylines -- the mockup's specific
// stat-pill labels ("Claimed: GBP", "Partial: 3/7 review & directory
// profiles", "Missing: 0 pages with Person schema") describe that broader,
// still-illustrative vision, not what's actually built. Copying those
// labels verbatim would fabricate capability that doesn't exist, so this
// wizard uses the SAME 3-stat-pill visual pattern every other wizard this
// session uses (checks-passing ratio + the pillar's own 2 specific real
// signals) instead of the mockup's specific fake numbers.
//
// The mockup's "2 action groups" step showed one half ("author-credential")
// as closeable via a one-click publish, the other ("platform-presence") as
// needing new data collection. Neither half is true here: this pillar has
// no publish/task action of its own (no GBP-claiming API, no directory
// automation) -- both real signals it measures are informational, closed
// only by a strategist doing outside work and then a fresh audit run
// re-checking it. So this wizard's "Recommended actions" step is a plain
// issues list (same shape as Content Authority's own gap-detail step), and
// "Verify" says plainly that re-running the audit is what confirms a fix,
// same convention as every other wizard here.

const STEP_LABELS = ['Diagnosis', 'Recommended actions', 'Verify']

function gradeClass(grade) {
  if (!grade) return 'grade-none'
  if (grade.startsWith('A')) return 'grade-a'
  if (grade.startsWith('B')) return 'grade-b'
  if (grade.startsWith('C')) return 'grade-c'
  if (grade.startsWith('D')) return 'grade-d'
  return 'grade-f'
}

// entityStatPills(pillar) -- real backlink-domain count and AI-citation
// share, straight from `_raw` (persisted as `pillar.raw`, same convention
// every other pillar's `_raw` already uses) -- both fields have existed
// since this checker's very first version, so this works on every past
// run, not just future ones.
function entityStatPills(pillar) {
  const checks = pillar?.checks || []
  const realChecks = checks.filter(c => c.status !== 'not_verified')
  const checksTotal = realChecks.length
  const checksPassing = realChecks.filter(c => c.status === 'pass').length
  const passRatio = checksTotal > 0 ? checksPassing / checksTotal : null

  const raw = pillar?.raw || {}
  const authorityDomains = Array.isArray(raw.authorityReferringDomains) ? raw.authorityReferringDomains : []
  const backlinkChecked = checks.some(c => /backlink/i.test(c.label || '') && c.status !== 'not_verified')
  const backlinkCount = backlinkChecked ? authorityDomains.length : null

  const aiShare = typeof raw.aiAuthorityCitationShare === 'number' ? raw.aiAuthorityCitationShare : null

  return [
    {
      key: 'checks',
      tone: passRatio === null ? null : passRatio >= 1 ? 'good' : passRatio > 0 ? 'caution' : 'gap',
      eyebrow: passRatio === null ? '● Not checked' : passRatio >= 1 ? '▲ Passing' : passRatio > 0 ? '● Partial' : '▼ Failing',
      value: checksTotal > 0 ? `${checksPassing} / ${checksTotal}` : '--',
      desc: 'real authority signals checked this run'
    },
    {
      key: 'backlinks',
      tone: backlinkCount === null ? null : backlinkCount >= 3 ? 'good' : backlinkCount > 0 ? 'caution' : 'gap',
      eyebrow: backlinkCount === null ? '● Not checked' : backlinkCount >= 3 ? '▲ Strong' : backlinkCount > 0 ? '● Partial' : '▼ None found',
      value: backlinkCount === null ? '--' : String(backlinkCount),
      desc: 'recognized authority domains linking here (Clutch, G2, BBB, etc.)'
    },
    {
      key: 'aicitation',
      tone: aiShare === null ? null : aiShare >= 0.75 ? 'good' : aiShare > 0 ? 'caution' : 'gap',
      eyebrow: aiShare === null ? '● Not checked' : aiShare >= 0.75 ? '▲ Consistent' : aiShare > 0 ? '● Inconsistent' : '▼ Never',
      value: aiShare === null ? '--' : `${Math.round(aiShare * 100)}%`,
      desc: 'tracked AI mentions citing an authority domain'
    }
  ]
}

export default function EntityAuthorityWizard({ pillar }) {
  const [step, setStep] = useState(1)
  const [selectedPill, setSelectedPill] = useState(null)
  const pills = pillar ? entityStatPills(pillar) : []

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
      <StepChips labels={STEP_LABELS} step={step} onStep={setStep} />

      {step === 1 && (
        <div>
          {pillar && !pillar.noData ? (
            <div className="card" style={{ padding: 20 }}>
              <div className="grade-row">
                <div className={`grade-badge ${gradeClass(pillar.grade)}`}>
                  {pillar.grade || '--'}
                </div>
                <div>
                  <div className="grade-title">{pillarHeadline('Entity & Citation Authority', pillar)}</div>
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
                  {selectedPill === 'checks' && <CheckRow checks={pillar.checks} />}
                  {selectedPill === 'backlinks' && (
                    <p className="pd-lead" style={{ margin: 0 }}>
                      {(pillar.evidence || []).find(e => /authority domain/i.test(e)) || 'Not checked -- AHREFS_API_KEY may not be configured for this run.'}
                    </p>
                  )}
                  {selectedPill === 'aicitation' && (
                    <p className="pd-lead" style={{ margin: 0 }}>
                      {(pillar.evidence || []).find(e => /AI engines cited/i.test(e)) || (pillar.evidence || []).find(e => /AI-visibility/i.test(e)) || 'Not checked -- no AI-visibility tracking data available yet for this client.'}
                    </p>
                  )}
                </div>
              )}
              {Array.isArray(pillar.issues) && pillar.issues.length > 0 && !selectedPill && <IssuesList issues={pillar.issues} />}
            </div>
          ) : (
            <div className="card-empty" style={{ padding: 18 }}>
              <div className="text-small text-muted">
                {pillar?.noData
                  ? pillar.finding
                  : 'Not yet audited -- run an audit to see this pillar\'s real checks.'}
              </div>
            </div>
          )}
          <div className="cta-row">
            <button className="btn btn-primary" onClick={() => setStep(2)}>See recommended actions &rarr;</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          <div className="card" style={{ padding: 18 }}>
            <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 14 }}>What to do next</div>
            <p className="text-small" style={{ margin: 0 }}>{pillar?.finding || 'Not yet audited.'}</p>
            {pillar?.recommendation && (
              <p className="text-small" style={{ margin: '10px 0 0', color: 'var(--text)' }}>
                <b>Recommendation:</b> {pillar.recommendation}
              </p>
            )}
          </div>
          {Array.isArray(pillar?.issues) && pillar.issues.length > 0 && <IssuesList issues={pillar.issues} />}
          <div className="cta-row">
            <button className="btn btn-secondary" onClick={() => setStep(1)}>&larr; Back</button>
            <button className="btn btn-primary" onClick={() => setStep(3)}>Verify &rarr;</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div>
          {/* .callout, not .concept-banner -- true, real information about a
              real limitation, not illustrative/proposed content. */}
          <div className="callout">
            <b>How this actually gets verified:</b> there's no task tracker or auto-claim action wired up here -- closing a real backlink or AI-citation gap is work a strategist does outside this tool (building a review-platform profile, earning press, etc.). Once that happens, re-run the audit for this client and this pillar's grade and checks below will reflect it.
          </div>
          {pillar && !pillar.noData ? (
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
            <button className="btn btn-secondary" onClick={() => setStep(2)}>&larr; Back</button>
          </div>
        </div>
      )}
    </div>
  )
}
