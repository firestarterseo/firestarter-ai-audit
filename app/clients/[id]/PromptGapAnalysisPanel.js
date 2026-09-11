'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// PROMPT-LEVEL GAP ANALYSIS -- v1 rebuild (2026-09-10). See
// lib/promptGapAnalysis.js's header for the full rationale. Deliberately a
// standalone panel, NOT one of the graded pillar tiles in PillarsBoard.js --
// this is diagnostic infrastructure, one prompt at a time.
//
// PROMPT -> WINNING COMPETITOR -> GAP -> CAUSE -> RECOMMENDED ACTION.
// Every dimension can independently be 'gap' / 'no_gap' / 'insufficient_data'
// -- insufficient_data is rendered plainly, never hidden or guessed past.
//
// OPPORTUNITY OUTCOME (2026-09-11): a validated finding (primary_gap/
// secondary_gap) can now create or attach to a real row in the EXISTING
// Opportunities system (see lib/promptGapOpportunities.js) -- this panel
// only ever shows the RESULT of that (created / attached to an existing
// opportunity / did not qualify, and why), never a task-management UI of
// its own. `opportunityResults` only exists on an analysis just run in
// THIS session (it's computed fresh per POST, not persisted on the row),
// so it's simply absent -- and rendered as nothing -- on historical rows
// loaded from GET.

const DIMENSION_LABELS = {
  content: 'Content',
  relevance: 'Relevance / Entity',
  authority: 'Authority',
  third_party: 'Third-Party Proof',
  technical: 'Technical'
}

// Corrected 2026-09-11 to match the multi-engine outcome vocabulary in
// lib/promptGapAnalysis.js (LOSS/MIXED/etc. now reflect ALL engines in the
// latest run, not one arbitrarily-picked engine's row).
const STATUS_LABEL = { LOSS: 'Losing', MIXED: 'Mixed across engines', TIE: 'Tied', WIN: 'Winning', NO_DATA: 'No data yet', NO_SIGNAL: 'No signal' }
const STATUS_TONE = { LOSS: 'gap', MIXED: 'gap', TIE: 'watch', WIN: 'good', NO_DATA: 'watch', NO_SIGNAL: 'watch' }

function GapDimension({ dimKey, dim, isPrimary, isSecondary }) {
  if (!dim) return null
  const tone = dim.status === 'gap' ? 'gap' : dim.status === 'no_gap' ? 'good' : 'watch'
  const roleLabel = isPrimary ? 'PRIMARY GAP' : isSecondary ? 'SECONDARY GAP' : null
  return (
    <div style={{ borderBottom: '1px solid var(--border)', padding: '10px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span className={`tag ${tone}`}>{dim.status === 'gap' ? 'GAP' : dim.status === 'no_gap' ? 'NO GAP' : 'INSUFFICIENT DATA'}</span>
        <b style={{ fontSize: 13 }}>{DIMENSION_LABELS[dimKey] || dimKey}</b>
        {roleLabel && <span className="text-tiny text-muted">({roleLabel})</span>}
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--muted-2)', lineHeight: 1.6 }}>
        {(dim.evidence || []).map((e, i) => <li key={i}>{e}</li>)}
      </ul>
    </div>
  )
}

const OPPORTUNITY_OUTCOME_LABEL = {
  created: 'Created a new Opportunity',
  attached_existing: 'Attached to an existing Opportunity',
  preserved_dismissed: 'Matched an existing Opportunity an AM already dismissed -- left as-is',
  not_qualified: 'Did not qualify for an Opportunity'
}
const OPPORTUNITY_OUTCOME_TONE = { created: 'gap', attached_existing: 'watch', preserved_dismissed: 'watch', not_qualified: 'good' }

// OpportunityOutcome -- shows the RESULT of connecting this analysis's
// primary_gap/secondary_gap into the existing Opportunities system, never
// a management UI of its own (no status changes, no approve/reject --
// that's OpportunitiesManager.js's job, unchanged). One line per
// dimension that was actually evaluated (only ever primary_gap/
// secondary_gap -- see lib/promptGapOpportunities.js).
function OpportunityOutcome({ opportunityResults }) {
  const entries = Object.entries(opportunityResults || {}).filter(([k]) => k !== '_error')
  if (opportunityResults._error) {
    return <div className="text-tiny" style={{ color: 'var(--grade-f)', marginTop: 10 }}>Opportunity linking failed: {opportunityResults._error}</div>
  }
  if (entries.length === 0) return null
  return (
    <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
      <div className="text-small" style={{ fontWeight: 600, marginBottom: 6 }}>Opportunities</div>
      {entries.map(([gapKey, result]) => (
        <div key={gapKey} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
          <span className={`tag ${OPPORTUNITY_OUTCOME_TONE[result.status] || 'watch'}`}>{DIMENSION_LABELS[gapKey] || gapKey}</span>
          <span className="text-small">{OPPORTUNITY_OUTCOME_LABEL[result.status] || result.status}</span>
          {result.title && <span className="text-tiny text-muted">-- {result.title}</span>}
          {result.reason && <span className="text-tiny text-muted">({result.reason})</span>}
          {result.opportunityId && <span className="text-tiny text-muted">(see Opportunities under Competitive Position)</span>}
        </div>
      ))}
    </div>
  )
}

function AnalysisResult({ analysis }) {
  const dims = {
    content: analysis.content_gap,
    relevance: analysis.relevance_gap,
    authority: analysis.authority_gap,
    third_party: analysis.third_party_gap,
    technical: analysis.technical_gap
  }
  const winningCompetitors = Array.isArray(analysis.winning_competitors) ? analysis.winning_competitors : []

  return (
    <div className="card" style={{ padding: 18, marginTop: 12 }}>
      <div className="text-small text-muted" style={{ marginBottom: 4 }}>Prompt</div>
      <div style={{ fontWeight: 600, marginBottom: 10 }}>&ldquo;{analysis.prompt_text}&rdquo;</div>

      <div style={{ display: 'flex', gap: 24, marginBottom: 10, flexWrap: 'wrap' }}>
        <div>
          <div className="text-tiny text-muted">Client</div>
          <div style={{ fontSize: 13 }}>{winningCompetitors.length > 0 ? 'Not present' : '—'}</div>
        </div>
        <div>
          <div className="text-tiny text-muted">Winning competitor(s)</div>
          <div style={{ fontSize: 13 }}>{winningCompetitors.length > 0 ? winningCompetitors.join(', ') : 'None -- not a losing prompt'}</div>
        </div>
        <div>
          <div className="text-tiny text-muted">Confidence</div>
          <div style={{ fontSize: 13 }}>{analysis.confidence}</div>
        </div>
      </div>

      {Object.keys(dims).map(k => (
        <GapDimension key={k} dimKey={k} dim={dims[k]} isPrimary={analysis.primary_gap === k} isSecondary={analysis.secondary_gap === k} />
      ))}

      {Array.isArray(analysis.recommended_actions) && analysis.recommended_actions.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="text-small" style={{ fontWeight: 600, marginBottom: 6 }}>Recommended action</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
            {analysis.recommended_actions.map((a, i) => <li key={i}>{a.action}</li>)}
          </ul>
        </div>
      )}

      {analysis.opportunityResults && <OpportunityOutcome opportunityResults={analysis.opportunityResults} />}

      <div className="text-tiny text-muted" style={{ marginTop: 10 }}>
        Analyzed {new Date(analysis.analyzed_at).toLocaleString()}.
      </div>
    </div>
  )
}

export default function PromptGapAnalysisPanel({ clientId, initialCandidates = [], initialAnalyses = [] }) {
  const router = useRouter()
  const [candidates] = useState(initialCandidates)
  const [analyses, setAnalyses] = useState(initialAnalyses)
  const [selectedPrompt, setSelectedPrompt] = useState(candidates.find(c => c.status === 'LOSS' || c.status === 'MIXED')?.promptText || '')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)

  const analysisByPrompt = new Map(analyses.map(a => [a.prompt_text, a]))

  async function runAnalysis() {
    if (!selectedPrompt) return
    setRunning(true)
    setError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/prompt-gaps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promptText: selectedPrompt })
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Analysis failed.')
      setAnalyses(prev => [body.analysis, ...prev.filter(a => a.prompt_text !== body.analysis.prompt_text)])
      router.refresh()
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setRunning(false)
    }
  }

  if (candidates.length === 0) {
    return (
      <div className="card card-empty" style={{ padding: 18, marginTop: 24 }}>
        No tracked test prompts exist yet for this client -- add some under AI &amp; GEO Visibility first.
      </div>
    )
  }

  const selectedAnalysis = analysisByPrompt.get(selectedPrompt)

  return (
    <div style={{ marginTop: 24 }}>
      <div className="section-label">Prompt-Level Gap Analysis</div>
      <p className="text-small text-muted" style={{ marginTop: 4, marginBottom: 12 }}>
        For one specific losing prompt: which competitor wins, exactly why, and what to do about it. Runs on demand
        (one live check per click) -- never automatically. Foundation-level; not yet wired into Opportunities.
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          value={selectedPrompt}
          onChange={e => setSelectedPrompt(e.target.value)}
          style={{ flex: '1 1 320px', padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}
        >
          {candidates.map(c => (
            <option key={c.promptText} value={c.promptText}>
              [{STATUS_LABEL[c.status] || c.status}] {c.promptText}
            </option>
          ))}
        </select>
        <button className="btn btn-primary" onClick={runAnalysis} disabled={running || !selectedPrompt}>
          {running ? 'Analyzing…' : 'Analyze this prompt'}
        </button>
      </div>

      {selectedPrompt && (
        <div style={{ marginTop: 6 }}>
          <span className={`tag ${STATUS_TONE[candidates.find(c => c.promptText === selectedPrompt)?.status] || 'watch'}`}>
            {STATUS_LABEL[candidates.find(c => c.promptText === selectedPrompt)?.status] || '—'}
          </span>
        </div>
      )}

      {error && <div className="text-small" style={{ color: 'var(--grade-f)', marginTop: 8 }}>{error}</div>}

      {selectedAnalysis && <AnalysisResult analysis={selectedAnalysis} />}

      {analyses.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div className="text-small text-muted" style={{ marginBottom: 6 }}>Previously analyzed prompts</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {analyses.map(a => (
              <div
                key={a.id}
                className="cluster-card"
                style={{ padding: '8px 12px' }}
                onClick={() => setSelectedPrompt(a.prompt_text)}
              >
                <span className="text-small">&ldquo;{a.prompt_text}&rdquo;</span>
                {a.primary_gap && <span className="tag gap" style={{ marginLeft: 8 }}>{DIMENSION_LABELS[a.primary_gap] || a.primary_gap}</span>}
                {!a.primary_gap && <span className="tag watch" style={{ marginLeft: 8 }}>No gap found</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
