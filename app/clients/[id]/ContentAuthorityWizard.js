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

// GAP_RECOMMENDATIONS -- 2026-08-16. Literal copy of
// lib/checkers/content-checker.js's own private GAP_RECOMMENDATIONS map
// (that file's `worst.key`-keyed object, same 3 sentences verbatim). The
// checker only ever folds ONE gap's recommendation (whichever ranks worst
// that run) into the single combined `pillar.recommendation` string -- there
// was no way to show a DIFFERENT gap's real recommendation if a strategist
// clicked a card that wasn't the worst one. Duplicating this static,
// already-real map client-side (same "small pure helper, not worth a
// cross-module dependency for" pattern gradeClass already uses everywhere
// in this project) makes every gap's detail real and correct regardless of
// which card is selected, without inventing new copy.
const GAP_RECOMMENDATIONS = {
  word_count: 'Expand key page content -- word count is meaningfully behind tracked competitors, which likely means less substantive material for Google and AI engines to draw from relative to them.',
  freshness: 'Publish more often -- tracked competitors are updating more recently on average, and content freshness is a real signal of an actively maintained site to both Google and AI systems.',
  referring_domains: 'Prioritize link building (local citations, partnerships, press/guest content) -- referring domains are meaningfully behind tracked competitors, and this is one of the strongest authority signals both Google and AI answer engines weigh.'
}

// gapEvidenceLine(pillar, key) -- the one real evidence sentence for
// whichever specific gap metric is selected, same regex-parse-real-evidence
// pattern every stat-pill detail in this file already uses.
function gapEvidenceLine(pillar, key) {
  const evidence = pillar?.evidence || []
  if (key === 'word_count') return evidence.find(e => /average \d+ words\/page/i.test(e)) || null
  if (key === 'freshness') return evidence.find(e => /days ago\)/i.test(e)) || null
  if (key === 'referring_domains') return evidence.find(e => /live referring domain/i.test(e)) || null
  return null
}

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
  // selectedGap -- 2026-08-16 fix: workflow-mockup.html's #pane-content step 2
  // has each cluster-card call selectGap(this,'referring'|'freshness'|'thin')
  // to drive what step 3 ("Gap detail") shows next. This wizard had no
  // equivalent state at all -- step 3 rendered the exact same generic
  // "what to do next" text no matter which gap card was clicked in step 2,
  // silently dropping the one interactive part of this workflow. Defaults to
  // the worst-ranked real gap (gaps[0], already the "selected" card below),
  // same default the mockup itself uses.
  const [selectedGap, setSelectedGap] = useState(null)
  const activeGapKey = selectedGap || gaps[0]?.key || null
  const activeGap = gaps.find(g => g.key === activeGapKey) || null
  // assignee/dueDate -- 2026-08-17: restores the mockup's assign-row for
  // this gap's action, same local-only pattern (and same honesty note)
  // TechnicalFoundationWizard.js's due-date field uses -- there's no real
  // task-tracker column for either of these yet.
  const [assignee, setAssignee] = useState('Francine Gautier')
  const [dueDate, setDueDate] = useState('')

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
                  <div
                    key={g.key}
                    className={`cluster-card${activeGapKey === g.key ? ' selected' : ''}`}
                    onClick={() => setSelectedGap(g.key)}
                  >
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
            <button className="btn btn-primary" onClick={() => setStep(3)}>See gap plan &rarr;</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div>
          {activeGap ? (
            <div className="card" style={{ padding: 18 }}>
              <div className="brief-title">{activeGap.label} -- gap plan</div>
              <div className="brief-meta">
                {activeGap.clientValue} {activeGap.unit} vs {activeGap.competitorAvg} {activeGap.unit} average, across {activeGap.comparedCount} tracked competitor{activeGap.comparedCount === 1 ? '' : 's'} with comparable data this run.
              </div>
              <p className="text-small" style={{ margin: '10px 0 0' }}>
                {gapEvidenceLine(pillar, activeGap.key) || 'Not checked on the most recent run.'}
              </p>
              <p className="text-small" style={{ margin: '10px 0 0', color: 'var(--text)' }}>
                <b>Recommendation:</b> {GAP_RECOMMENDATIONS[activeGap.key] || 'Close this gap relative to tracked competitors.'}
              </p>
              <div className="assign-row" style={{ marginTop: 12 }}>
                <div className="assign-field">
                  <label htmlFor="content-assignee">Assign to</label>
                  <select id="content-assignee" value={assignee} onChange={e => setAssignee(e.target.value)}>
                    <option value="Francine Gautier">Francine Gautier (project owner)</option>
                    <option value="Jeff">Jeff</option>
                    <option value="Kyle Carney">Kyle Carney</option>
                    <option value="Leo Resplandor">Leo Resplandor</option>
                    <option value="Skyler Malley">Skyler Malley</option>
                  </select>
                </div>
                <div className="assign-field">
                  <label htmlFor="content-duedate">Due date</label>
                  <input id="content-duedate" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
                </div>
              </div>
              <p className="assign-note">
                There's no real Asana (or other task-tracker) integration wired up in this tool yet -- the assignee list is a small hardcoded roster, not a live team/project lookup. The button below builds a real preview of this task using this gap's actual data, but it doesn't create anything in a live Asana workspace.
              </p>
            </div>
          ) : (
            <div className="card" style={{ padding: 18 }}>
              <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 14 }}>What to do next</div>
              <p className="text-small" style={{ margin: '0 0 0' }}>{pillar?.finding || 'Not yet audited.'}</p>
              {pillar?.recommendation && (
                <p className="text-small" style={{ margin: '10px 0 0', color: 'var(--text)' }}>
                  <b>Recommendation:</b> {pillar.recommendation}
                </p>
              )}
            </div>
          )}
          {Array.isArray(pillar?.issues) && pillar.issues.length > 0 && <IssuesList issues={pillar.issues} />}
          <div className="cta-row">
            <button className="btn btn-secondary" onClick={() => setStep(2)}>&larr; Back</button>
            <button className="btn btn-primary" onClick={() => setStep(4)}>Create Asana task &rarr;</button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div>
          {activeGap && (
            <div className="asana-card">
              <div className="asana-card-top">
                <span className="asana-icon">&#8801;</span>
                <span className="asana-task-name">
                  {activeGap.key === 'referring_domains' && `Link building push: close the ${activeGap.competitorAvg - activeGap.clientValue}-domain referring-domains gap`}
                  {activeGap.key === 'freshness' && `Build a content calendar (${activeGap.clientValue} days since last update, competitors average ${activeGap.competitorAvg})`}
                  {activeGap.key === 'word_count' && `Expand key page content (${activeGap.clientValue} words vs a ${activeGap.competitorAvg}-word competitor average)`}
                </span>
              </div>
              <div className="asana-card-meta">
                <span className="section-badge">{activeGap.key === 'referring_domains' ? 'Link Building' : 'Content'}</span>
                <span className="asana-meta-item">Assigned: {assignee}</span>
                <span className="asana-meta-item">{dueDate ? `Due ${dueDate}` : 'Due --'}</span>
              </div>
            </div>
          )}
          {/* .callout, not .concept-banner -- true, real information about a
              real limitation, not illustrative/proposed content. */}
          <div className="callout">
            <b>This is a preview, not a live Asana task:</b> there's no task tracker wired up here, so nothing above was actually created anywhere -- it's built from this gap's real data so a strategist can see exactly what a real task would say, but clicking &ldquo;Create Asana task&rdquo; doesn&rsquo;t call Asana. These checks (content depth, freshness, referring domains) and the competitor gap ranking above only get re-verified by running another audit for this client -- once new content or links go live, re-run the audit and this pillar's grade and gaps below will reflect it.
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
