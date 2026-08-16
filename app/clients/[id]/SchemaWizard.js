'use client'

import { useState } from 'react'
import SchemaGenerator from './SchemaGenerator'
import { CheckRow, IssuesList } from './PillarsBoard'

// Schema & Structure's wizard-style pillar detail (Phase 3 of the mockup ->
// production sync -- see workflow-mockup.html's #pane-schema for the design
// this ports). Replaces the generic PillarDetail rendering (grade badge +
// flat check/issue list) with the same 6-step flow the mockup illustrated,
// wired to REAL data throughout: steps 1, 4, 5, 6 use this client's actual
// pillar_scores row and the actual SchemaGenerator component (the same one
// Phase 1's live-verification card lives in) -- nothing here is invented.
//
// Steps 2 and 3 ("Page coverage" / "What's missing, page by page") stay in
// the step flow as honest not-yet-built placeholders, per direct
// instruction -- the mockup's version of those steps showed fabricated
// per-page results, and the real schema checker (lib/checkers/checker.js)
// only ever scores the homepage today. There is no real per-page
// classification to show yet; NotBuiltStep says so plainly instead of
// inventing one.
//
// SchemaGenerator is rendered ONCE -- the same mounted instance covers
// steps 4, 5, and 6 (via its `visibleSection` prop), not a fresh instance
// per step. Re-mounting it per step would re-run its on-mount schema fetch
// and reset wpStatus every time a strategist clicked "Verify" then "Back,"
// which would make the wizard feel broken even though nothing was actually
// wrong -- see SchemaGenerator.js's own header comment on `visibleSection`.

const STEP_LABELS = [
  'Diagnosis',
  'Page coverage',
  "What's missing",
  'Generate & review',
  'Publish',
  'Verify'
]

// Literal duplicate of PillarsBoard.js's own gradeClass -- same "small,
// pure helper, not worth a cross-module dependency for" reasoning this
// project's backend checkers already use for things like scoreToGrade.
function gradeClass(grade) {
  if (!grade) return 'grade-none'
  if (grade.startsWith('A')) return 'grade-a'
  if (grade.startsWith('B')) return 'grade-b'
  if (grade.startsWith('C')) return 'grade-c'
  if (grade.startsWith('D')) return 'grade-d'
  return 'grade-f'
}

// Ported from workflow-mockup.html's .concept-banner (2026-08-16) --
// replaces the plain .card-empty box this originally used. .concept-banner
// is the prototype's actual visual language for "illustrative/not real
// yet," a dashed-striped callout, not just a generic empty card.
function NotBuiltStep({ title, note, onBack, onNext }) {
  return (
    <div>
      <div className="concept-banner">
        <span><b>{title} -- not yet built.</b> {note}</span>
      </div>
      <div className="cta-row">
        <button className="btn btn-secondary" onClick={onBack}>&larr; Back</button>
        <button className="btn btn-primary" onClick={onNext}>Continue &rarr;</button>
      </div>
    </div>
  )
}

export default function SchemaWizard({ pillar, clientId, client }) {
  const [step, setStep] = useState(1)

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
      <div className="steps">
        {STEP_LABELS.map((label, i) => {
          const n = i + 1
          return (
            <button
              key={n}
              type="button"
              className={`step-chip${step === n ? ' active' : ''}`}
              onClick={() => setStep(n)}
            >
              <span className="num">{n}</span> {label}
            </button>
          )
        })}
      </div>

      {step === 1 && (
        <div>
          {pillar ? (
            <div className="card" style={{ padding: 20 }}>
              <div className="grade-row">
                <div className={`grade-badge ${gradeClass(pillar.grade)}`} style={{ width: 34, height: 34, fontSize: 17 }}>
                  {pillar.grade || '--'}
                </div>
                <div>
                  <div className="grade-title">Schema &amp; Structure</div>
                  {pillar.finding && <div className="grade-sub">{pillar.finding}</div>}
                </div>
              </div>
              <CheckRow checks={pillar.checks} />
              {Array.isArray(pillar.issues) && pillar.issues.length > 0 && <IssuesList issues={pillar.issues} />}
            </div>
          ) : (
            <div className="card-empty" style={{ padding: 18 }}>
              <div className="text-small text-muted">Not yet audited -- run an audit to see this pillar's real checks.</div>
            </div>
          )}
          <div className="cta-row">
            <button className="btn btn-primary" onClick={() => setStep(2)}>See page coverage &rarr;</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <NotBuiltStep
          title="Page coverage"
          note="Not yet built -- the real Schema & Structure checker only scores the homepage today. Classifying every page from the sitemap and checking each one individually (as this step illustrates) is a proposed capability, not a real one yet."
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      )}

      {step === 3 && (
        <NotBuiltStep
          title="What's missing, page by page"
          note="Not yet built -- depends on real per-page checking existing first (see the Page coverage step). Once that's real, this step would show each page's specific gaps instead of just the homepage's."
          onBack={() => setStep(2)}
          onNext={() => setStep(4)}
        />
      )}

      {(step === 4 || step === 5 || step === 6) && (
        <div>
          <SchemaGenerator
            clientId={clientId}
            client={client}
            bare
            visibleSection={step === 4 ? 'form' : step === 5 ? 'publish' : 'verify'}
          />
          <div className="cta-row">
            <button className="btn btn-secondary" onClick={() => setStep(step - 1)}>&larr; Back</button>
            {step < 6 && (
              <button className="btn btn-primary" onClick={() => setStep(step + 1)}>
                {step === 4 ? 'Publish to WordPress →' : 'Verify →'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
