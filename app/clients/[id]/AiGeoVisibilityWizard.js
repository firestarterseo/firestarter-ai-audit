'use client'

import { useState } from 'react'
import { CheckRow, IssuesList, pillarHeadline, StepChips } from './PillarsBoard'
import TestPromptsManager from './TestPromptsManager'
import PromptTester from './PromptTester'

// AI & GEO Visibility's wizard-style pillar detail -- same port pattern as
// every other wizard this session, applied to workflow-mockup.html's
// #pane-aigeo. Grounded in lib/checkers/ai-visibility-checker.js's real
// output; nothing invented.
//
// The mockup's "Prompt clusters" step groups tracked prompts by intent (4
// named clusters, e.g. "Core Services"). That requires a real intent/
// cluster field on each test prompt -- this project's test_prompts don't
// have one yet (each prompt is just free text, no cluster/intent tag).
// Rather than fabricate 4 fake cluster names to match the mockup's specific
// example, this step is left out of the step list until that field is real
// -- same "don't fabricate capability that doesn't exist" rule every other
// wizard here follows. What IS real and already built -- the per-engine,
// per-prompt transparency view (AiVisibilityVerify, already used by the old
// generic PillarDetail) -- becomes its own proper step instead of a buried
// <details> disclosure.
//
// TestPromptsManager + PromptTester (managing the actual tracked prompts,
// and running a one-off live test) used to be appended unconditionally
// below this pillar's card via PillarsBoard's `children` slot. Setting
// `customDetail` for this pillar (so it gets the same tab/step chrome as
// every other pillar) means `children` never renders (see PillarsBoard.js's
// tab-switch logic) -- so both are now rendered directly inside this
// wizard instead, always visible below the step content, so no real
// functionality is lost in the switch to the mockup's step-based layout.

const STEP_LABELS = ['Diagnosis', 'Engine breakdown', 'Recommended actions', 'Verify']

function gradeClass(grade) {
  if (!grade) return 'grade-none'
  if (grade.startsWith('A')) return 'grade-a'
  if (grade.startsWith('B')) return 'grade-b'
  if (grade.startsWith('C')) return 'grade-c'
  if (grade.startsWith('D')) return 'grade-d'
  return 'grade-f'
}

// aiGeoStatPills(pillar) -- real mention/citation/engine numbers, parsed
// from evidence strings this checker has always produced (see
// checkAiGeoVisibility's evidence.push calls) -- same "already real,
// already persisted, works on past runs too" approach used for Technical
// Foundation and Content Authority's stat-pills.
function aiGeoStatPills(pillar) {
  const evidence = pillar?.evidence || []

  const mentionLine = evidence.find(e => /AI-engine runs analyzed/i.test(e))
  const mentionMatch = mentionLine && /^(\d+) AI-engine runs analyzed; mentioned in (\d+)/i.exec(mentionLine)
  const totalRuns = mentionMatch ? parseInt(mentionMatch[1], 10) : null
  const mentionedCount = mentionMatch ? parseInt(mentionMatch[2], 10) : null
  const mentionRatio = (totalRuns && mentionedCount !== null) ? mentionedCount / totalRuns : null

  const citedLine = evidence.find(e => /cited\/sourced in/i.test(e))
  const citedMatch = citedLine && /cited\/sourced in (\d+)/i.exec(citedLine)
  const citedCount = citedMatch ? parseInt(citedMatch[1], 10) : null
  const uncitedCount = (mentionedCount !== null && citedCount !== null) ? mentionedCount - citedCount : null

  const engineSummaries = Array.isArray(pillar?.raw?.engineSummaries) ? pillar.raw.engineSummaries : []
  const weakestEngine = engineSummaries.length > 0
    ? engineSummaries.reduce((worst, e) => (worst === null || e.mentionRate < worst.mentionRate) ? e : worst, null)
    : null

  return [
    {
      key: 'strong',
      tone: mentionRatio === null ? null : mentionRatio >= 0.7 ? 'good' : mentionRatio >= 0.4 ? 'caution' : 'gap',
      eyebrow: mentionRatio === null ? '● Not checked' : mentionRatio >= 0.7 ? '▲ Strong' : mentionRatio >= 0.4 ? '● Mixed' : '▼ Weak',
      value: (mentionedCount === null || totalRuns === null) ? '--' : `${mentionedCount} / ${totalRuns}`,
      desc: 'prompt runs mentioned across all engines'
    },
    {
      key: 'watch',
      tone: weakestEngine === null ? null : weakestEngine.mentionRate < 0.4 ? 'caution' : 'good',
      eyebrow: weakestEngine === null ? '● Not checked' : '● Watch',
      value: weakestEngine === null ? '--' : `${weakestEngine.engine} ${Math.round(weakestEngine.mentionRate * 100)}%`,
      desc: 'lowest mention rate by engine'
    },
    {
      key: 'opportunity',
      tone: uncitedCount === null ? null : uncitedCount > 0 ? 'gap' : 'good',
      eyebrow: uncitedCount === null ? '● Not checked' : uncitedCount > 0 ? '▼ Opportunity' : '▲ None',
      value: uncitedCount === null ? '--' : `${uncitedCount} uncited`,
      desc: 'mentioned but no citation credit'
    }
  ]
}

// aiGeoDiagnosisText(pillar, pills) -- 2026-08-16: workflow-mockup.html's
// #pane-aigeo Diagnosis step has a real .diagnosis-text paragraph (line
// 692) between .grade-row and .stat-pill-row that this wizard was missing
// -- same omission found and fixed across every other wizard this session.
// Built from the exact same already-computed aiGeoStatPills() values
// (strong/watch/opportunity), not new data or the mockup's own numbers.
function aiGeoDiagnosisText(pillar, pills) {
  const strong = pills.find(p => p.key === 'strong')
  const watch = pills.find(p => p.key === 'watch')
  const opportunity = pills.find(p => p.key === 'opportunity')
  const parts = []
  if (strong && strong.value !== '--') parts.push(`mentioned in ${strong.value} tracked runs across all engines`)
  if (watch && watch.value !== '--') parts.push(`the weakest engine is ${watch.value}`)
  if (opportunity && opportunity.value !== '--' && opportunity.value !== '0 uncited') parts.push(`${opportunity.value} despite being mentioned`)
  if (parts.length === 0) return null
  return parts.join(', ') + '.'
}

// EngineBreakdownRows(pillar) -- 2026-08-17: workflow-mockup.html's step 3
// ("Core Services — engine by engine", line 744) shows each engine's row
// (mentioned/not, snippet quoted, who's cited) directly, no extra click --
// this used to be buried one layer deeper, inside AiVisibilityVerify's own
// <details>/<summary> accordion (built for the old bunched-together card,
// before this pillar had its own step-based layout). Since "Engine
// breakdown" is now already its own dedicated step, that inner accordion
// was redundant chrome the mockup itself doesn't have -- this renders the
// exact same real per-engine/per-prompt rows (pillar.raw.latestBreakdown for
// tracked clients, pillar.raw.engineResults for a one-off snapshot) directly
// with the mockup's own .engine-row/.et/.name/.badge/.snip/.who markup
// (already in globals.css, unused until now) instead. No cluster grouping --
// same reasoning as the file header comment: there's no real intent/cluster
// field on prompts, so this lists every row from the most recent run rather
// than inventing the mockup's specific "Core Services" grouping.
function EngineBreakdownRows({ pillar }) {
  const raw = pillar?.raw || {}
  const rows = pillar?.snapshot
    ? (Array.isArray(raw.engineResults) ? raw.engineResults : [])
    : (Array.isArray(raw.latestBreakdown) ? raw.latestBreakdown : [])
  if (rows.length === 0) {
    return <p className="text-small text-muted" style={{ margin: 0 }}>No per-engine breakdown available for this run yet.</p>
  }
  return (
    <div>
      {rows.map((r, i) => {
        const own = Array.isArray(r.ownDomainSourceUrls) ? r.ownDomainSourceUrls : []
        const otherSources = (Array.isArray(r.sourceUrls) ? r.sourceUrls : []).filter(u => !own.includes(u))
        return (
          <div key={i} className="engine-row">
            <div className="et">
              <span className="name">{r.engine}{r.weight >= 2 ? ' (high priority)' : ''}</span>
              {r.ok === false ? (
                <span className="badge no">Call failed</span>
              ) : (
                <span className={`badge ${r.mentioned ? 'yes' : 'no'}`}>{r.mentioned ? 'Mentioned' : 'Not mentioned'}</span>
              )}
            </div>
            {r.prompt && <p className="text-tiny text-muted" style={{ margin: '0 0 4px' }}>&ldquo;{r.prompt}&rdquo;</p>}
            {r.ok === false ? (
              <p className="who">Call failed: {r.error || 'unknown error'}</p>
            ) : (
              <>
                {r.responseSnippet && (
                  <p className="snip">&ldquo;{r.responseSnippet}{r.responseSnippet.length >= 400 ? '…' : ''}&rdquo;</p>
                )}
                {r.mentioned ? (
                  own.length > 0
                    ? <p className="who">✓ Cited: {own.join(', ')}</p>
                    : <p className="who">Not cited from your own domain — no link back{r.sentiment ? ` · sentiment: ${r.sentiment}` : ''}</p>
                ) : (
                  <p className="who">{otherSources.length > 0 ? `Not your domain — cited instead: ${otherSources.join(', ')}` : 'No citation captured this run.'}</p>
                )}
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function AiGeoVisibilityWizard({ pillar, clientId, savedPrompts }) {
  const [step, setStep] = useState(1)
  const [selectedPill, setSelectedPill] = useState(null)
  const pills = pillar && !pillar.noData ? aiGeoStatPills(pillar) : []

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
                  <div className="grade-title">{pillarHeadline('AI & GEO Visibility', pillar)}</div>
                  {pillar.finding && <div className="grade-sub">{pillar.finding}</div>}
                </div>
              </div>
              {aiGeoDiagnosisText(pillar, pills) && (
                <p className="diagnosis-text">{aiGeoDiagnosisText(pillar, pills)}</p>
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
                  {selectedPill === 'strong' && (
                    <p className="pd-lead" style={{ margin: 0 }}>
                      {(pillar.evidence || []).find(e => /AI-engine runs analyzed/i.test(e)) || 'Not checked on the most recent run.'}
                    </p>
                  )}
                  {selectedPill === 'watch' && (
                    <CheckRow checks={(pillar.raw?.engineSummaries || []).map(e => ({
                      label: `${e.engine}: mentioned in ${Math.round(e.mentionRate * 100)}% of ${e.count} run(s)`,
                      status: e.mentionRate >= 0.4 ? 'pass' : 'fail'
                    }))} />
                  )}
                  {selectedPill === 'opportunity' && (
                    <p className="pd-lead" style={{ margin: 0 }}>
                      {(pillar.evidence || []).find(e => /Citation mix among mentions/i.test(e)) || 'Not checked on the most recent run.'}
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
            <button className="btn btn-primary" onClick={() => setStep(2)}>See engine breakdown &rarr;</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          <div className="card" style={{ padding: 18 }}>
            <div style={{ fontWeight: 600, marginBottom: 2, fontSize: 14 }}>Engine by engine, real evidence</div>
            <div className="text-tiny text-muted" style={{ marginBottom: 10 }}>Same real per-engine evidence already collected today, surfaced directly instead of behind an extra expand click.</div>
            {pillar && !pillar.noData ? (
              <EngineBreakdownRows pillar={pillar} />
            ) : (
              <div className="text-small text-muted">Not yet audited.</div>
            )}
          </div>
          <div className="cta-row">
            <button className="btn btn-secondary" onClick={() => setStep(1)}>&larr; Back</button>
            <button className="btn btn-primary" onClick={() => setStep(3)}>See recommended actions &rarr;</button>
          </div>
        </div>
      )}

      {step === 3 && (
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
            <b>How this actually gets verified:</b> there's no task tracker wired up here -- these numbers only update when the recurring AI-visibility tracking job runs again (or a one-off prompt test is run below). Re-run this client's audit after that to see this pillar's grade and evidence reflect it.
          </div>
          {pillar && !pillar.noData ? (
            <div className="card" style={{ padding: 18 }}>
              <div className="text-tiny text-muted" style={{ fontWeight: 600, letterSpacing: 0.5, marginBottom: 8 }}>LAST VERIFIED (most recent run)</div>
              <CheckRow checks={(pillar.raw?.engineSummaries || []).map(e => ({
                label: `${e.engine}: mentioned in ${Math.round(e.mentionRate * 100)}% of ${e.count} run(s)`,
                status: e.mentionRate >= 0.4 ? 'pass' : 'fail'
              }))} />
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

      <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)', display: 'grid', gap: 14 }}>
        <TestPromptsManager clientId={clientId} savedPrompts={savedPrompts} bare />
        <PromptTester clientId={clientId} bare />
      </div>
    </div>
  )
}
