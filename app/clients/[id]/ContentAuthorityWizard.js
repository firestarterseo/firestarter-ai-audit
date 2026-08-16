'use client'

import { useState } from 'react'
import { CheckRow, IssuesList } from './PillarsBoard'

// Content Authority's wizard-style pillar detail -- same port pattern
// SchemaWizard.js / TechnicalFoundationWizard.js established, applied to
// workflow-mockup.html's #pane-content. Every step here is grounded in real
// data from lib/checkers/content-checker.js.
//
// The mockup's "Recommended gaps" step showed exactly 3 named gaps (Referring
// Domains / Content Freshness / Thin Pages), ranked worst-first -- this maps
// almost exactly onto content-checker.js's real, already-computed
// `_raw.contentGaps` (persisted as `pillar.raw.contentGaps`, confirmed via
// runAudit.js's `raw: result._raw`): a ranked array of up to 3 real
// competitor-relative gaps (word_count, freshness, referring_domains), each
// with this client's real value, the real tracked-competitor average, and
// how many competitors had comparable data. It only populates when this
// client has 2+ active tracked competitors with comparable data this run
// (see content-checker.js's MIN_COMPETITORS_FOR_GAP_ANALYSIS) -- when it
// doesn't, this step says so honestly instead of showing empty/fake cards.
//
// The mockup's "Verify" step showed a fake Asana task-status card, same as
// every other pillar this session -- cut for the same reason (no real
// task-tracker integration exists); this step instead says plainly that
// re-running the audit is what actually re-verifies these checks.

const STEP_LABELS = ['Diagnosis', 'Recommended gaps', 'Gap detail', 'Verify']

function gradeClass(grade) {
  if (!grade) return 'grade-none'
  if (grade.startsWith('A')) return 'grade-a'
  if (grade.startsWith('B')) return 'grade-b'
  if (grade.startsWith('C')) return 'grade-c'
  if (grade.startsWith('D')) return 'grade-d'
  return 'grade-f'
}

// gap.ratio is clientValue/competitorAvg (already inverted for
// lowerIsBetter metrics like freshness by content-checker.js's own
// buildContentGaps) -- >= 1 means at/ahead of the tracked-competitor
// average, < 1 means behind. Kept as a tiny local helper rather than
// reused from the checker since it's just a display label, not scoring.
function gapStatusTag(ratio) {
  if (ratio >= 1) return { label: 'At or ahead', color: 'var(--grade-a)' }
  if (ratio >= 0.9) return { label: 'Close', color: 'var(--grade-c)' }
  return { label: 'Biggest gap', color: 'var(--grade-f)' }
}

export default function ContentAuthorityWizard({ pillar }) {
  const [step, setStep] = useState(1)
  const gaps = Array.isArray(pillar?.raw?.contentGaps) ? pillar.raw.contentGaps : []

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
                <div style={{ fontWeight: 600, fontSize: 14 }}>Content Authority</div>
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
            <button className="btn btn-primary" onClick={() => setStep(2)}>See recommended gaps &rarr;</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          {gaps.length > 0 ? (
            <div style={{ display: 'grid', gap: 10 }}>
              {gaps.map(g => {
                const tag = gapStatusTag(g.ratio)
                return (
                  <div key={g.key} className="card" style={{ padding: 14 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{g.label}</div>
                      <span className="pill pill-lead" style={{ marginLeft: 'auto', color: tag.color }}>{tag.label}</span>
                    </div>
                    <p className="text-small text-muted" style={{ margin: '4px 0 0' }}>
                      {g.clientValue} {g.unit} vs. {g.competitorAvg} {g.unit} average across {g.comparedCount} tracked competitor{g.comparedCount === 1 ? '' : 's'}
                    </p>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="card-empty" style={{ padding: 18 }}>
              <div className="text-small text-muted">
                Gap ranking not available -- this needs at least 2 tracked competitors with comparable data (homepage word count, dated content, and/or Ahrefs referring-domain counts) this run. Add or confirm tracked competitors on the Competitive Position pillar, then re-run the audit.
              </div>
            </div>
          )}
          <div className="wizard-cta-row">
            <button className="btn btn-secondary" onClick={() => setStep(1)}>&larr; Back</button>
            <button className="btn btn-primary" onClick={() => setStep(3)}>See gap detail &rarr;</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div>
          <div className="card" style={{ padding: 18 }}>
            <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 14 }}>What to do next</div>
            <p className="text-small" style={{ margin: '0 0 0' }}>{pillar?.finding || 'Not yet audited.'}</p>
            {pillar?.recommendation && (
              <p className="text-small" style={{ margin: '10px 0 0', color: 'var(--text)' }}>
                <b>Recommendation:</b> {pillar.recommendation}
              </p>
            )}
          </div>
          {Array.isArray(pillar?.issues) && pillar.issues.length > 0 && <IssuesList issues={pillar.issues} />}
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
              There's no task tracker wired up here, so nothing "completes" on its own. These checks (content depth, freshness, referring domains) and the competitor gap ranking above only get re-verified by running another audit for this client -- once new content or links go live, re-run the audit and this pillar's grade and gaps below will reflect it.
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
