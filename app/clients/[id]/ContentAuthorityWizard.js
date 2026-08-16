'use client'

import { useState } from 'react'
import { CheckRow, IssuesList, pillarHeadline, StepChips } from './PillarsBoard'

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
//
// 2026-08-16: step-nav/cluster-card classes swapped from bespoke wizard-*
// classes to workflow-mockup.html's real .steps/.step-chip/.cluster-grid/
// .cluster-card/.tag/.callout -- see globals.css's header comments on that
// port and TechnicalFoundationWizard.js's identical pass for the reasoning.

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
  if (ratio >= 1) return 'good'
  if (ratio >= 0.9) return 'watch'
  return 'gap'
}

const GAP_TAG_LABEL = { good: 'At or ahead', watch: 'Close', gap: 'Biggest gap' }

// contentStatPills(pillar) -- 2026-08-16, same fix as
// TechnicalFoundationWizard.js's technicalStatPills: Diagnosis step 1 was
// rendering the generic CheckRow/IssuesList "AI slop" list instead of the
// mockup's own SOLID/WATCH/biggest-gap stat-pill-row. Every number here was
// already being computed and persisted by content-checker.js on every past
// run -- parsed from its real evidence strings and `_raw.contentGaps`
// (already used by the Recommended-gaps step below), not a new capability,
// so this works immediately on existing runs, not just future ones.
function contentStatPills(pillar) {
  const evidence = pillar?.evidence || []

  const wordMatch = evidence.map(e => /average (\d+) words\/page/i.exec(e)).find(Boolean)
  const avgWords = wordMatch ? parseInt(wordMatch[1], 10) : null

  const freshMatch = evidence.map(e => /\((\d+) days ago\)/i.exec(e)).find(Boolean)
  const daysSince = freshMatch ? parseInt(freshMatch[1], 10) : null

  const gaps = Array.isArray(pillar?.raw?.contentGaps) ? pillar.raw.contentGaps : []
  const worstGap = gaps[0] || null
  const refDomainsMatch = evidence.map(e => /^(\d+) live referring domain/i.exec(e)).find(Boolean)
  const liveRefDomains = refDomainsMatch ? parseInt(refDomainsMatch[1], 10) : null

  return [
    {
      key: 'words',
      tone: avgWords === null ? null : avgWords >= 300 ? 'good' : avgWords >= 150 ? 'caution' : 'gap',
      eyebrow: avgWords === null ? '● Not checked' : avgWords >= 300 ? '▲ Solid' : '● Watch',
      value: avgWords === null ? '--' : `${avgWords}w`,
      desc: 'homepage word count, sampled this run'
    },
    {
      key: 'freshness',
      tone: daysSince === null ? null : daysSince <= 90 ? 'good' : daysSince <= 180 ? 'caution' : 'gap',
      eyebrow: daysSince === null ? '● Not checked' : daysSince <= 90 ? '▲ Fresh' : '● Watch',
      value: daysSince === null ? '--' : `${daysSince} days`,
      desc: 'since last dated content update'
    },
    {
      key: 'gap',
      tone: worstGap
        ? (worstGap.ratio >= 1 ? 'good' : worstGap.ratio >= 0.9 ? 'caution' : 'gap')
        : (liveRefDomains === null ? null : liveRefDomains >= 20 ? 'good' : 'gap'),
      eyebrow: worstGap
        ? (worstGap.ratio >= 1 ? '▲ Ahead' : '▼ Biggest gap')
        : (liveRefDomains === null ? '● Not checked' : liveRefDomains >= 20 ? '▲ Solid' : '▼ Gap'),
      value: worstGap ? `${worstGap.clientValue} vs ${worstGap.competitorAvg}` : (liveRefDomains === null ? '--' : String(liveRefDomains)),
      desc: worstGap ? `${worstGap.label.toLowerCase()} vs. tracked competitor avg` : 'referring domains (needs 2+ tracked competitors to rank)'
    }
  ]
}

// contentDiagnosisText(pillar, pills) -- 2026-08-16: workflow-mockup.html's
// #pane-content Diagnosis step has a real .diagnosis-text paragraph between
// .grade-row and .stat-pill-row (line 831) that this wizard was missing --
// same omission found and fixed in TechnicalFoundationWizard.js. Built from
// the exact same already-computed contentStatPills() values (words/
// freshness/gap), not new data or the mockup's own illustrative numbers.
function contentDiagnosisText(pillar, pills) {
  const words = pills.find(p => p.key === 'words')
  const freshness = pills.find(p => p.key === 'freshness')
  const gap = pills.find(p => p.key === 'gap')
  const parts = []
  if (words && words.value !== '--') parts.push(`homepage content runs ${words.value} this run`)
  if (freshness && freshness.value !== '--') parts.push(`the most recent dated content update was ${freshness.value} ago`)
  if (gap && gap.value !== '--') parts.push(`the biggest competitive gap is ${gap.desc} (${gap.value})`)
  if (parts.length === 0) return null
  return parts.join(', ') + '.'
}

export default function ContentAuthorityWizard({ pillar }) {
  const [step, setStep] = useState(1)
  const [selectedPill, setSelectedPill] = useState(null)
  const gaps = Array.isArray(pillar?.raw?.contentGaps) ? pillar.raw.contentGaps : []
  const pills = pillar ? contentStatPills(pillar) : []

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
                  <div className="grade-title">{pillarHeadline('Content Authority', pillar)}</div>
                  {pillar.finding && <div className="grade-sub">{pillar.finding}</div>}
                </div>
              </div>
              {contentDiagnosisText(pillar, pills) && (
                <p className="diagnosis-text">{contentDiagnosisText(pillar, pills)}</p>
              )}
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
                  {selectedPill === 'words' && (
                    <p className="pd-lead" style={{ margin: 0 }}>
                      {(pillar.evidence || []).find(e => /average \d+ words\/page/i.test(e)) || 'Not checked on the most recent run.'}
                    </p>
                  )}
                  {selectedPill === 'freshness' && (
                    <p className="pd-lead" style={{ margin: 0 }}>
                      {(pillar.evidence || []).find(e => /days ago\)/i.test(e)) || 'Not checked on the most recent run.'}
                    </p>
                  )}
                  {selectedPill === 'gap' && (
                    <p className="pd-lead" style={{ margin: 0 }}>
                      {gaps.length > 0
                        ? `Ranked worst-first vs tracked competitors: ${gaps.map(g => `${g.label} (${g.clientValue} ${g.unit} vs ${g.competitorAvg} ${g.unit})`).join('; ')}.`
                        : (pillar.evidence || []).find(e => /live referring domain/i.test(e)) || 'Needs 2+ active tracked competitors with comparable data to rank a gap.'}
                    </p>
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
            <button className="btn btn-primary" onClick={() => setStep(2)}>See recommended gaps &rarr;</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          {gaps.length > 0 ? (
            <div className="cluster-grid">
              {gaps.map(g => {
                const tag = gapStatusTag(g.ratio)
                return (
                  <div key={g.key} className="cluster-card">
                    <div className="name">{g.label}</div>
                    <div className="meta">
                      {g.clientValue} {g.unit} vs. {g.competitorAvg} {g.unit} avg
                    </div>
                    <span className={`tag ${tag}`}>{GAP_TAG_LABEL[tag]}</span>
                    <div className="kws">
                      Across {g.comparedCount} tracked competitor{g.comparedCount === 1 ? '' : 's'} with comparable data this run.
                    </div>
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
          <div className="cta-row">
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
          <div className="cta-row">
            <button className="btn btn-secondary" onClick={() => setStep(2)}>&larr; Back</button>
            <button className="btn btn-primary" onClick={() => setStep(4)}>Verify &rarr;</button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div>
          {/* .callout, not .concept-banner -- true, real information about a
              real limitation, not illustrative/proposed content. */}
          <div className="callout">
            <b>How this actually gets verified:</b> there's no task tracker wired up here, so nothing "completes" on its own. These checks (content depth, freshness, referring domains) and the competitor gap ranking above only get re-verified by running another audit for this client -- once new content or links go live, re-run the audit and this pillar's grade and gaps below will reflect it.
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
