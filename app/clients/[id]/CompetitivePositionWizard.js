'use client'

import { useState } from 'react'
import { CheckRow, IssuesList, pillarHeadline, StepChips } from './PillarsBoard'
import CompetitorsManager from './CompetitorsManager'
import OpportunitiesManager from './OpportunitiesManager'

// Competitive Position's wizard-style pillar detail -- same port pattern as
// every other wizard this session, applied to workflow-mockup.html's
// #pane-comp. Grounded in lib/checkers/competitive-position-checker.js's
// real output; nothing invented.
//
// The mockup's "4 topic clusters to close the gap" step groups keyword
// opportunities by topic (e.g. "Local SEO Services"). The real checker's
// `_raw.keywordOpportunities` is a flat, ranked-by-volume list -- no real
// topic clustering exists (confirmed by reading the checker directly
// earlier this session). Rather than invent 4 fake topic names, this
// wizard keeps the real, ALREADY-BUILT OpportunitiesManager (a fuller,
// DB-backed status-tracked opportunity workflow -- open/in_progress/done,
// realistic-tier tags, SERP evidence, AI-generated content briefs) as its
// "Recommended actions" step instead of wrapping a redundant illustrative
// grid around it. It's a genuinely better real UI than the mockup's
// proposed wizard steps for this part, just given the same tab/step chrome
// every other pillar now has so it doesn't look inconsistent sitting next
// to them.
//
// CompetitorsManager + OpportunitiesManager used to be appended
// unconditionally below this pillar's card via PillarsBoard's `children`
// slot. Setting `customDetail` for this pillar means `children` never
// renders (see PillarsBoard.js's tab-switch logic) -- so both are now
// rendered directly inside this wizard's step 2 instead, so no real
// functionality is lost in the switch to the mockup's step-based layout.

const STEP_LABELS = ['Diagnosis', 'Competitors & opportunities', 'Verify']

function gradeClass(grade) {
  if (!grade) return 'grade-none'
  if (grade.startsWith('A')) return 'grade-a'
  if (grade.startsWith('B')) return 'grade-b'
  if (grade.startsWith('C')) return 'grade-c'
  if (grade.startsWith('D')) return 'grade-d'
  return 'grade-f'
}

// competitiveStatPills(pillar) -- real head-to-head and keyword-count
// numbers, parsed from evidence strings this checker has always produced
// (see checkCompetitivePosition's evidence.push calls) -- same
// already-real, already-persisted approach used for every other wizard's
// stat-pills this session.
function competitiveStatPills(pillar) {
  const evidence = pillar?.evidence || []

  const h2hLine = evidence.find(e => /AI-citation head-to-head/i.test(e))
  const h2hMatch = h2hLine && /(\d+) win\(s\), (\d+) tie\(s\), (\d+) loss\(es\)/i.exec(h2hLine)
  const wins = h2hMatch ? parseInt(h2hMatch[1], 10) : null
  const ties = h2hMatch ? parseInt(h2hMatch[2], 10) : null
  const losses = h2hMatch ? parseInt(h2hMatch[3], 10) : null

  const kwLine = evidence.find(e => /^Ranking for \d+ total organic keyword/i.test(e))
  const kwMatch = kwLine && /^Ranking for (\d+) total organic keyword\(s\).*?average of (\d+)/i.exec(kwLine)
  const clientKw = kwMatch ? parseInt(kwMatch[1], 10) : null
  const avgCompetitorKw = kwMatch ? parseInt(kwMatch[2], 10) : null

  return [
    {
      key: 'headtohead',
      tone: wins === null ? null : wins > losses ? 'good' : wins === losses ? 'caution' : 'gap',
      eyebrow: wins === null ? '● Not checked' : wins > losses ? '▲ Ahead' : wins === losses ? '● Even' : '▼ Behind',
      value: wins === null ? '--' : `${wins}W / ${ties}T / ${losses}L`,
      desc: 'AI-citation head-to-head vs tracked competitors'
    },
    {
      key: 'missed',
      tone: losses === null ? null : losses > 0 ? 'caution' : 'good',
      eyebrow: losses === null ? '● Not checked' : losses > 0 ? '● Watch' : '▲ None',
      value: losses === null ? '--' : `${losses} missed`,
      desc: 'runs where a competitor was cited and you weren’t'
    },
    {
      key: 'keywords',
      tone: (clientKw === null || avgCompetitorKw === null) ? null : clientKw >= avgCompetitorKw ? 'good' : 'gap',
      eyebrow: clientKw === null ? '● Not checked' : clientKw >= avgCompetitorKw ? '▲ Ahead' : '▼ Real gap',
      value: clientKw === null ? '--' : `${clientKw} vs ~${avgCompetitorKw}`,
      desc: 'organic keywords vs. competitor avg'
    }
  ]
}

export default function CompetitivePositionWizard({ pillar, clientId, competitors, opportunities, clientDomain }) {
  const [step, setStep] = useState(1)
  const [selectedPill, setSelectedPill] = useState(null)
  const pills = pillar && !pillar.noData ? competitiveStatPills(pillar) : []

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
                  <div className="grade-title">{pillarHeadline('Competitive Position', pillar)}</div>
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
                  {(selectedPill === 'headtohead' || selectedPill === 'missed') && (
                    <p className="pd-lead" style={{ margin: 0 }}>
                      {(pillar.evidence || []).find(e => /AI-citation head-to-head/i.test(e)) || 'Not checked -- no AI-visibility tracked runs yet mention either the client or a tracked competitor.'}
                    </p>
                  )}
                  {selectedPill === 'keywords' && (
                    <p className="pd-lead" style={{ margin: 0 }}>
                      {(pillar.evidence || []).find(e => /^Ranking for \d+ total organic keyword/i.test(e)) || (pillar.evidence || []).find(e => /organic keyword/i.test(e)) || 'Not checked this run.'}
                    </p>
                  )}
                </div>
              )}
              {Array.isArray(pillar.issues) && pillar.issues.length > 0 && !selectedPill && <IssuesList issues={pillar.issues} />}
            </div>
          ) : (
            <div className="card-empty" style={{ padding: 18 }}>
              <div className="text-small text-muted">
                {pillar?.noData ? pillar.finding : 'Not yet audited -- run an audit to see this pillar\'s real checks.'}
              </div>
            </div>
          )}
          <div className="cta-row">
            <button className="btn btn-primary" onClick={() => setStep(2)}>See competitors &amp; opportunities &rarr;</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          <CompetitorsManager clientId={clientId} competitors={competitors} clientDomain={clientDomain} bare />
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            <OpportunitiesManager clientId={clientId} opportunities={opportunities} bare />
          </div>
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
            <b>How this actually gets verified:</b> there's no task tracker wired up here beyond each opportunity's own status field (see the list above) -- the head-to-head and keyword-count numbers only get re-verified by running another audit for this client.
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
