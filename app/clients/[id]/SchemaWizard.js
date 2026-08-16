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
function schemaStatPills(pillar) {
  const raw = pillar?.raw || {}
  const checksTotal = typeof raw.checksTotal === 'number' ? raw.checksTotal : (pillar?.checks?.length ?? 7)
  const checksPassing = typeof raw.checksPassing === 'number'
    ? raw.checksPassing
    : (pillar?.checks || []).filter(c => c.status === 'pass').length
  const passRatio = checksTotal > 0 ? checksPassing / checksTotal : 0
  const businessEntityCount = typeof raw.businessEntityCount === 'number' ? raw.businessEntityCount : null
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
      tone: businessEntityCount === null ? null : businessEntityCount > 0 ? 'good' : 'gap',
      eyebrow: businessEntityCount === null ? '● Not checked' : businessEntityCount > 0 ? '▲ Found' : '● Not found',
      value: businessEntityCount === null ? '--' : String(businessEntityCount),
      desc: 'business-entity schema (Organization / LocalBusiness)'
    },
    {
      key: 'sitewide',
      tone: sitemapPageCount === null ? null : 'caution',
      eyebrow: sitemapPageCount === null ? '● Not checked' : '● Site-wide',
      value: sitemapPageCount === null ? 'Not checked' : `${sitemapPageCount} page${sitemapPageCount === 1 ? '' : 's'}`,
      desc: sitemapPageCount === null ? 'sitemap.xml not reachable this run' : 'found in sitemap.xml -- per-page checks not yet built'
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
                  <div className="grade-title">Schema &amp; Structure</div>
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
                  {selectedPill === 'notfound' && (
                    <p className="pd-lead" style={{ margin: 0 }}>
                      {pillar.raw?.businessEntityCount > 0
                        ? `${pillar.raw.businessEntityCount} business-entity schema block(s) found (${(pillar.raw.schemasFound || []).join(', ') || 'see raw evidence below'}).`
                        : 'No LocalBusiness/Organization-style schema found -- this is the single biggest lever for showing up correctly in AI answers and local search.'}
                    </p>
                  )}
                  {selectedPill === 'sitewide' && (
                    <p className="pd-lead" style={{ margin: 0 }}>
                      {pillar.raw?.sitemapPageCount != null
                        ? `sitemap.xml lists ${pillar.raw.sitemapPageCount} page(s). Only the homepage is actually checked for schema today -- classifying and checking every page individually is the Page coverage step below, not yet built.`
                        : "sitemap.xml wasn't reachable on the most recent run, so this couldn't be counted -- not the same as zero pages."}
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
