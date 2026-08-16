'use client'

import { useState } from 'react'
import SchemaGenerator from './SchemaGenerator'
import { CheckRow, IssuesList, pillarHeadline } from './PillarsBoard'

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

// Real 3-stat-pill Diagnosis row (2026-08-16) -- ports workflow-mockup.html's
// #pane-schema Diagnosis step exactly (grade-row + stat-pill-row with
// data-pill="failing"/"notfound"/"sitewide"), which is NOT the generic
// grade-badge+CheckRow layout this file originally used. All 3 numbers are
// real, sourced from lib/checkers/checker.js's `_raw` (persisted as
// `pillar.raw`, same convention every other pillar's `_raw` already uses):
//   - failing: checksPassing/checksTotal (checksTotal is always 7 today --
//     see that file's header comment listing all 7 real checks).
//   - notfound: businessEntityCount -- 0 means check #2 (Business entity
//     schema) failed; >0 means it passed with that many distinct
//     business-entity-type schema blocks found.
//   - sitewide: sitemapPageCount -- a real sitemap.xml <loc> count, added
//     alongside this Diagnosis rebuild specifically so this stat pill
//     wouldn't have to stay the mockup's illustrative "5 pages." Renders
//     "Not checked" (not a fake 0) when the sitemap fetch failed/no URL was
//     available -- see countSitemapPages's own null-on-failure contract.
//     Deliberately doesn't claim "coverage varies by page" the way the
//     mockup's illustrative version does -- real per-page classification
//     is still the not-yet-built Page coverage step (2/3 below).
// Old audit runs (anything scored before 2026-08-16) never persisted
// businessEntityCount/sitemapPageCount at all -- those keys are simply
// absent from `raw`, not present-but-null. Collapsing "never checked" and
// "checked and failed" into one flat "Not checked" reads as a flat
// contradiction against the top finding sentence (itself derived from the
// SAME old run) whenever that finding says business-entity schema WAS
// found -- exactly what showed up live on Firestarter SEO's own client
// page. So: derive a real Found/Not-found from the pass/fail check that DID
// run on every version of this checker, before ever falling back to a true
// "no data at all" state. The exact count still requires a fresh audit run
// (checks only ever recorded pass/fail, never a count) -- that's said
// honestly rather than guessed.
function schemaStatPills(pillar) {
  const raw = pillar?.raw || {}
  const checks = pillar?.checks || []
  const checksTotal = typeof raw.checksTotal === 'number' ? raw.checksTotal : (checks.length || 7)
  const checksPassing = typeof raw.checksPassing === 'number'
    ? raw.checksPassing
    : checks.filter(c => c.status === 'pass').length
  const passRatio = checksTotal > 0 ? checksPassing / checksTotal : 0

  const businessEntityCountRaw = typeof raw.businessEntityCount === 'number' ? raw.businessEntityCount : null
  const businessEntityCheck = checks.find(c => /business entity/i.test(c.label || ''))
  // null = no data at all (neither the new field nor an old check exists);
  // true/false = derived from the old run's real pass/fail check.
  const businessEntityKnownPass = businessEntityCountRaw === null && businessEntityCheck
    ? businessEntityCheck.status === 'pass'
    : null

  // Distinguish "this run predates the sitemap check entirely" (key absent
  // from raw) from "the check ran but the fetch failed" (key present,
  // value null) -- otherwise an old run gets the misleading claim that
  // sitemap.xml "wasn't reachable" when it was never even attempted.
  const sitemapKeyPresent = Object.prototype.hasOwnProperty.call(raw, 'sitemapPageCount')
  const sitemapPageCount = typeof raw.sitemapPageCount === 'number' ? raw.sitemapPageCount : null

  return [
    {
      key: 'failing',
      tone: passRatio >= 0.85 ? 'good' : passRatio >= 0.5 ? 'caution' : 'bad',
      eyebrow: passRatio >= 0.85 ? '▲ Passing' : '▼ Failing',
      value: `${checksPassing} / ${checksTotal}`,
      desc: 'homepage checks passing right now'
    },
    {
      key: 'notfound',
      tone: businessEntityCountRaw !== null
        ? (businessEntityCountRaw > 0 ? 'good' : 'gap')
        : businessEntityKnownPass !== null
          ? (businessEntityKnownPass ? 'good' : 'gap')
          : null,
      eyebrow: businessEntityCountRaw !== null
        ? (businessEntityCountRaw > 0 ? '▲ Found' : '● Not found')
        : businessEntityKnownPass !== null
          ? (businessEntityKnownPass ? '▲ Found' : '● Not found')
          : '● Not checked',
      value: businessEntityCountRaw !== null
        ? String(businessEntityCountRaw)
        : businessEntityKnownPass !== null
          ? (businessEntityKnownPass ? 'Yes' : 'No')
          : '--',
      desc: businessEntityCountRaw !== null
        ? 'business-entity schema (Organization / LocalBusiness)'
        : businessEntityKnownPass !== null
          ? 'exact count needs a fresh audit run'
          : 'business-entity schema (Organization / LocalBusiness)'
    },
    {
      key: 'sitewide',
      tone: sitemapPageCount === null ? null : 'caution',
      eyebrow: sitemapPageCount === null ? '● Not checked' : '● Site-wide',
      value: sitemapPageCount === null ? 'Not checked' : `${sitemapPageCount} page${sitemapPageCount === 1 ? '' : 's'}`,
      desc: sitemapPageCount !== null
        ? 'found in sitemap.xml -- per-page checks not yet built'
        : sitemapKeyPresent
          ? 'sitemap.xml not reachable this run'
          : 'not available until the next audit run'
    }
  ]
}

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
  const [selectedPill, setSelectedPill] = useState(null)
  const pills = pillar ? schemaStatPills(pillar) : []

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
                  <div className="grade-title">{pillarHeadline('Schema & Structure', pillar)}</div>
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
                  {selectedPill === 'failing' && <CheckRow checks={pillar.checks} />}
                  {selectedPill === 'notfound' && (() => {
                    const raw = pillar.raw || {}
                    const businessEntityCountRaw = typeof raw.businessEntityCount === 'number' ? raw.businessEntityCount : null
                    const businessEntityCheck = (pillar.checks || []).find(c => /business entity/i.test(c.label || ''))
                    if (businessEntityCountRaw !== null) {
                      return (
                        <p className="pd-lead" style={{ margin: 0 }}>
                          {businessEntityCountRaw > 0
                            ? `${businessEntityCountRaw} business-entity schema block(s) found (${(raw.schemasFound || []).join(', ') || 'see raw evidence below'}).`
                            : 'No LocalBusiness/Organization-style schema found -- this is the single biggest lever for showing up correctly in AI answers and local search.'}
                        </p>
                      )
                    }
                    if (businessEntityCheck) {
                      return (
                        <p className="pd-lead" style={{ margin: 0 }}>
                          {businessEntityCheck.status === 'pass'
                            ? "A business-entity schema check passed on this run, but this older run didn't record the exact count/type -- run a fresh audit to see it broken out here."
                            : 'No LocalBusiness/Organization-style schema found -- this is the single biggest lever for showing up correctly in AI answers and local search.'}
                        </p>
                      )
                    }
                    return <p className="pd-lead" style={{ margin: 0 }}>Not checked yet -- run an audit to see this.</p>
                  })()}
                  {selectedPill === 'sitewide' && (() => {
                    const raw = pillar.raw || {}
                    const sitemapKeyPresent = Object.prototype.hasOwnProperty.call(raw, 'sitemapPageCount')
                    if (typeof raw.sitemapPageCount === 'number') {
                      return (
                        <p className="pd-lead" style={{ margin: 0 }}>
                          {`sitemap.xml lists ${raw.sitemapPageCount} page(s). Only the homepage is actually checked for schema today -- classifying and checking every page individually is the Page coverage step below, not yet built.`}
                        </p>
                      )
                    }
                    return (
                      <p className="pd-lead" style={{ margin: 0 }}>
                        {sitemapKeyPresent
                          ? "sitemap.xml wasn't reachable on the most recent run, so this couldn't be counted -- not the same as zero pages."
                          : 'This run predates the sitemap page-count check -- run a fresh audit to see it here.'}
                      </p>
                    )
                  })()}
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
