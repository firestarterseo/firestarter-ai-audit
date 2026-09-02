'use client'

import { useState } from 'react'
import SchemaGenerator from './SchemaGenerator'
import { CheckRow, IssuesList, pillarHeadline, StepChips } from './PillarsBoard'

// Schema & Structure's wizard-style pillar detail (Phase 3 of the mockup ->
// production sync -- see workflow-mockup.html's #pane-schema for the design
// this ports). Replaces the generic PillarDetail rendering (grade badge +
// flat check/issue list) with the same 6-step flow the mockup illustrated,
// wired to REAL data throughout: steps 1, 4, 5, 6 use this client's actual
// pillar_scores row and the actual SchemaGenerator component (the same one
// Phase 1's live-verification card lives in) -- nothing here is invented.
//
// 2026-08-17 correction: step 2 ("Page coverage") and step 3 ("What's
// missing") were BOTH rendered as a single blanket "not built" placeholder
// before this. That was only half right. lib/checkers/checker.js's
// checkSchemaAndStructure() takes one URL and only ever SCORES the
// homepage -- so per-other-page schema scoring genuinely isn't real yet.
// But step 3's "What's missing" content, for the one real page this
// checker DOES score, is entirely real: the mockup's own "7 checks, but
// really just 2 kinds of fix" framing maps label-for-label onto this
// checker's actual 7 checks (Structured data / Business entity schema /
// sameAs / Address+telephone / BreadcrumbList / WebSite+SearchAction / No
// missing required properties) -- 5 of them are resolved by generating +
// publishing schema (the same generator steps 4-6 already use), the other
// 2 (BreadcrumbList, WebSite+SearchAction) are SEO-plugin/theme settings
// this tool doesn't write. That grouping was sitting in already-persisted
// data the whole time; treating it as "not built" was brushing over real
// work the mockup got right, not an honest gap.
//
// 2026-09-02 sitemap/page-discovery fix: step 2's page list used to include
// child sitemap XML files (e.g. /post-sitemap.xml) whenever a client's root
// sitemap was an index -- lib/checkers/checker.js was treating a sitemap
// index's own <loc> entries (child sitemap references) as if they were
// pages. That's fixed at the source (see lib/sitemapDiscovery.js); every
// row this step renders is now a real, classified page URL. Per-page
// SCHEMA SCORING beyond the homepage is still not built -- that's the
// "Not scored yet" status below, a different thing from page-type
// classification (which every row now gets for real).

// SCHEMA_CHECK_GROUPS -- which real check(group) it belongs to, and the
// regex to find its matching real issue (for severity/why/recommendation)
// in pillar.issues, since checks[] and issues[] aren't index-aligned in
// checker.js (WebSite+SearchAction's fail case never pushes an issue at
// all -- it's real, but zero-severity by the checker's own design).
const SCHEMA_CHECK_GROUPS = {
  'Structured data (JSON-LD) present': { group: 'generator', issueMatch: /no structured data \(json-ld\)/i },
  'Business entity schema (LocalBusiness/Organization)': { group: 'generator', issueMatch: /no localbusiness\/organization-style schema/i },
  'sameAs entity-disambiguation links': { group: 'generator', issueMatch: /no sameas links/i },
  'Address + telephone on business entity': { group: 'generator', issueMatch: /missing address and\/or telephone/i },
  'No missing required schema properties': { group: 'generator', issueMatch: /required schema propert(y|ies) missing/i },
  'BreadcrumbList schema': { group: 'plugin', issueMatch: /no breadcrumblist schema/i },
  'WebSite + SearchAction': { group: 'plugin', issueMatch: null }
}

function schemaCheckGroups(pillar) {
  const checks = pillar?.checks || []
  const issues = pillar?.issues || []
  const generator = []
  const plugin = []
  checks.forEach(c => {
    const meta = SCHEMA_CHECK_GROUPS[c.label]
    if (!meta) return
    const issue = meta.issueMatch ? issues.find(i => meta.issueMatch.test(i.message || '')) : null
    const entry = { label: c.label, status: c.status, issue }
    if (meta.group === 'plugin') plugin.push(entry)
    else generator.push(entry)
  })
  return { generator, plugin }
}

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

export default function SchemaWizard({ pillar, clientId, client }) {
  const [step, setStep] = useState(1)
  const [selectedPill, setSelectedPill] = useState(null)
  const pills = pillar ? schemaStatPills(pillar) : []

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
        <div>
          {pillar ? (() => {
            const realPages = Array.isArray(pillar.raw?.sitemapPages) ? pillar.raw.sitemapPages : null
            const homeChecksPassing = (pillar.checks || []).filter(c => c.status === 'pass').length
            const homeChecksTotal = (pillar.checks || []).length || 7
            const rows = realPages && realPages.length > 0
              ? realPages
              : [{ path: '/', type: 'Home' }]
            return (
              <div className="card" style={{ padding: 18 }}>
                <div className="grade-title" style={{ marginBottom: 2 }}>Not every page needs the same schema</div>
                <div className="grade-sub" style={{ marginBottom: 14 }}>
                  Pages below are real page URLs discovered from this client&rsquo;s sitemap hierarchy (child sitemaps are followed automatically when the root sitemap is an index -- sitemap XML files themselves never appear here). Only the homepage is actually run through the Schema &amp; Structure checker&rsquo;s 7 checks today -- every other real page is listed by its real URL and page type, honestly marked &ldquo;Not scored yet&rdquo; rather than a guessed pass/fail, since per-page schema scoring beyond the homepage isn&rsquo;t built yet.
                </div>
                {rows.map((p, i) => (
                  <div key={p.path} className={`page-row${i === 0 ? ' selected' : ''}`}>
                    <span className="type-badge">{p.type}</span>
                    <span className="path">{p.path}</span>
                    <span className={`status ${p.type === 'Home' ? (homeChecksPassing >= homeChecksTotal * 0.85 ? 'good' : 'bad') : 'muted'}`}>
                      {p.type === 'Home' ? `${homeChecksPassing} / ${homeChecksTotal} checks` : 'Not scored yet'}
                    </span>
                  </div>
                ))}
                {!realPages && (
                  <p className="text-tiny text-muted" style={{ marginTop: 10 }}>
                    This run predates the real sitemap page list, or the sitemap fetch failed -- re-run the audit to see this client&rsquo;s actual pages here.
                  </p>
                )}
              </div>
            )
          })() : (
            <div className="card-empty" style={{ padding: 18 }}>
              <div className="text-small text-muted">Not yet audited -- run an audit to see this pillar's real checks.</div>
            </div>
          )}
          <div className="cta-row">
            <button className="btn btn-secondary" onClick={() => setStep(1)}>&larr; Back</button>
            <button className="btn btn-primary" onClick={() => setStep(3)}>See gaps for selected page &rarr;</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div>
          {pillar ? (() => {
            const { generator, plugin } = schemaCheckGroups(pillar)
            const CheckGroupRow = ({ c }) => (
              <div key={c.label} className="issue-item">
                <span className={`issue-badge ${c.status === 'pass' ? 'issue-passing' : (c.issue?.severity ? `issue-${c.issue.severity}` : 'issue-minor')}`}>
                  {c.status === 'pass' ? 'Passing' : (c.issue?.severity ? c.issue.severity : 'Not detected')}
                </span>
                <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>{c.label}</div>
                <p className="text-small issue-why">
                  {c.status === 'pass'
                    ? (c.issue?.recommendation || 'Already present -- nothing to do here.')
                    : (c.issue?.why || c.issue?.message || 'Not detected on the homepage this run.')}
                </p>
              </div>
            )
            return (
              <div className="card" style={{ padding: 18 }}>
                <div className="grade-title" style={{ marginBottom: 2 }}>/ (Home) -- {(pillar.checks || []).length || 7} checks, but really just 2 kinds of fix</div>
                <div className="grade-sub" style={{ marginBottom: 14 }}>
                  &ldquo;All kinds of schema missing&rdquo; sounds like a long custom job -- in practice these 7 real checks collapse to one generated block, plus a couple of settings this tool doesn&rsquo;t control.
                </div>
                {generator.length > 0 && (
                  <>
                    <div style={{ fontWeight: 600, fontSize: 13, margin: '4px 0 8px' }}>Fix with the Schema Generator -- 1 form, 1 publish</div>
                    <p className="text-tiny text-muted" style={{ margin: '0 0 8px' }}>These checks all live on the same business-entity block. One generated + published schema resolves all of them at once -- this is the tool already built in the next step.</p>
                    <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
                      {generator.map(c => <CheckGroupRow key={c.label} c={c} />)}
                    </div>
                  </>
                )}
                {plugin.length > 0 && (
                  <>
                    <div style={{ fontWeight: 600, fontSize: 13, margin: '4px 0 8px' }}>Already automatic in your SEO plugin -- nothing to build</div>
                    <p className="text-tiny text-muted" style={{ margin: '0 0 8px' }}>These aren&rsquo;t schema this tool writes -- they&rsquo;re a plugin setting. If they&rsquo;re off, that&rsquo;s a toggle for the client&rsquo;s webmaster, not a task for this generator.</p>
                    <div style={{ display: 'grid', gap: 8 }}>
                      {plugin.map(c => <CheckGroupRow key={c.label} c={c} />)}
                    </div>
                  </>
                )}
              </div>
            )
          })() : (
            <div className="card-empty" style={{ padding: 18 }}>
              <div className="text-small text-muted">Not yet audited.</div>
            </div>
          )}
          <div className="cta-row">
            <button className="btn btn-secondary" onClick={() => setStep(2)}>&larr; Pick a different page</button>
            <button className="btn btn-primary" onClick={() => setStep(4)}>Fix with the generator &rarr;</button>
          </div>
        </div>
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
