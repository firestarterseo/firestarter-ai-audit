'use client'

import { useEffect, useMemo, useState } from 'react'
import SchemaGenerator from './SchemaGenerator'
import { CheckRow, IssuesList, pillarHeadline, StepChips } from './PillarsBoard'
import { computeRecommendedSet } from '../../../lib/schemaPagePriority'
import { toggleQueuedPath, resolveOpenPath } from '../../../lib/schemaPageSelection'

// PAGE_TYPE_OPTIONS / PRIORITY_TIER_OPTIONS -- literal duplicates of the
// canonical lists in lib/sitemapDiscovery.js / lib/schemaPagePriority.js
// (same "small, pure list, not worth a cross-module dependency for"
// reasoning this file already uses for gradeClass below). Kept separate
// deliberately: lib/sitemapDiscovery.js pulls in lib/webPageFetch.js (a
// server-fetch module with no reason to ship to the browser bundle) just
// to get one small display-filter list -- not worth it for a filter
// dropdown's option set.
// 'Product' / 'Landing Page' added 2026-09-02, kept in sync with
// lib/sitemapDiscovery.js's PAGE_TYPES (the sitemap-provenance
// classification fix -- see that file's ROOT CAUSE #3).
const PAGE_TYPE_OPTIONS = ['Home', 'Service', 'Location', 'Article', 'Case Study', 'Product', 'Landing Page', 'About', 'Contact', 'Utility/Legal', 'Other']
const PRIORITY_TIER_OPTIONS = ['CORE', 'COMMERCIAL', 'PROOF', 'CONTENT', 'LOW_PRIORITY', 'OTHER']

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
// row this step renders is now a real, classified page URL.
//
// 2026-09-02, Phase A of the Schema page-workflow redesign: step 2 was
// still just a flat, cosmetic list -- a real bug immediately after the
// fix above showed the candidate list itself was capped WHILE WALKING the
// sitemap hierarchy (in sitemap-fetch order), so an early, large
// post-sitemap.xml could crowd out page-sitemap.xml's About/Contact/
// Service pages entirely; classification never used the sitemap filename
// as evidence (so e.g. a post-sitemap.xml URL with no "/blog/" segment
// fell through to Uncategorized even though it's obviously a post); and
// "selecting" a row was purely cosmetic -- the first row was always
// highlighted regardless of any click, and no other step ever knew what
// was "selected." This phase fixes discovery/classification at the source
// (lib/sitemapDiscovery.js) and adds real prioritization
// (lib/schemaPagePriority.js) plus a genuine two-state (open/queued)
// selection UI. Per-page SCHEMA SCORING and generation are still not
// built for anything but the homepage -- that's the honest "Not analyzed
// yet" status below, a later phase, not faked here. The schema work
// QUEUE built in this step is CURRENT-RUN / UI STATE ONLY (plain React
// state) -- it does not survive a refresh or a new audit run yet; durable
// tracking is planned for a later phase via the existing
// lib/opportunityLifecycle.js machinery, not built here.

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

// CLIENT_PROFILE_FIELD_KEYS -- the three Phase 1b client_profile_fields
// keys this step matches page slugs against (see
// lib/schemaPagePriority.js#matchClientIntelligence). Only AM-CONFIRMED
// rows (confirmation_status === 'confirmed') are used -- an unconfirmed,
// system-detected guess is not solid enough ground to build a second guess
// (page priority) on top of.
const PRIMARY_SERVICE_FIELD_KEY = 'primary_products_services'
const SECONDARY_SERVICE_FIELD_KEY = 'secondary_products_services'
const GEOGRAPHY_FIELD_KEY = 'primary_geography_markets'

// TIER_LABELS / TIER_TONE -- display-only presentation for
// lib/schemaPagePriority.js's PRIORITY_TIERS.
const TIER_LABELS = {
  CORE: 'Core',
  COMMERCIAL: 'Commercial',
  PROOF: 'Proof',
  CONTENT: 'Content',
  LOW_PRIORITY: 'Low priority',
  OTHER: 'Other'
}
const TIER_TONE = {
  CORE: 'good',
  COMMERCIAL: 'good',
  PROOF: 'caution',
  CONTENT: 'caution',
  LOW_PRIORITY: 'muted',
  OTHER: 'muted'
}

// PageRow -- shared row renderer for both the Recommended and All Pages
// lists. Two explicit, independent states, per this phase's product
// direction: OPEN (this row is the one currently being viewed -- click the
// row body) and QUEUED (an AM has intentionally added it to schema work --
// the checkbox, never inferred from "open"). A page can be open without
// being queued, queued without being open, both, or neither -- the UI
// never collapses these into one ambiguous highlight.
function PageRow({ dossier, isOpen, isQueued, onOpen, onToggleQueue, showRecommendedBadge, homeChecksPassing, homeChecksTotal }) {
  const isHome = dossier.type === 'Home'
  const statusTone = isHome ? (homeChecksPassing >= homeChecksTotal * 0.85 ? 'good' : 'bad') : 'muted'
  const statusText = isHome ? `Analyzed — ${homeChecksPassing} / ${homeChecksTotal} checks` : 'Not analyzed yet'

  return (
    <div className={`page-row${isOpen ? ' selected' : ''}`} style={{ display: 'grid', gridTemplateColumns: 'auto auto 1fr auto', alignItems: 'center', gap: 10 }}>
      <input
        type="checkbox"
        checked={isQueued}
        onChange={() => onToggleQueue(dossier.path)}
        aria-label={isQueued ? `Remove ${dossier.path} from schema work` : `Add ${dossier.path} to schema work`}
        title={isQueued ? 'Queued for schema work -- click to remove' : 'Add to schema work'}
      />
      <span className="type-badge" title={dossier.reasons.map(r => r.text).join(' · ')} style={{ cursor: 'default' }}>
        {dossier.type}
      </span>
      <span
        className="path"
        onClick={() => onOpen(dossier.path)}
        style={{ cursor: 'pointer', textDecoration: isOpen ? 'underline' : 'none' }}
      >
        {dossier.path}
        {showRecommendedBadge && <span className="text-tiny text-muted" style={{ marginLeft: 8 }}>&#9733; Recommended</span>}
        {isQueued && <span className="text-tiny text-muted" style={{ marginLeft: 8 }}>Queued</span>}
      </span>
      <span className={`status ${statusTone}`}>{statusText}</span>
    </div>
  )
}

export default function SchemaWizard({ pillar, clientId, client }) {
  const [step, setStep] = useState(1)
  const [selectedPill, setSelectedPill] = useState(null)
  const pills = pillar ? schemaStatPills(pillar) : []

  // -------------------------------------------------------------------
  // Phase A page-selection state (2026-09-02) -- see this file's header
  // for why this is plain React state, not durable storage, in this phase.
  // -------------------------------------------------------------------
  const [clientProfile, setClientProfile] = useState({ primaryServices: [], secondaryServices: [], geographies: [] })
  const [openPath, setOpenPath] = useState(null)
  const [queuedPaths, setQueuedPaths] = useState(() => new Set())
  const [pageSearch, setPageSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('All')
  const [tierFilter, setTierFilter] = useState('All')

  // Best-effort fetch of this client's AM-CONFIRMED profile fields (reuses
  // the existing GET /api/clients/[id]/profile-fields route -- no new
  // Supabase code, no new route, nothing added to what already exists).
  // Only 'confirmed' rows are used as client-intelligence matching signal
  // (see lib/schemaPagePriority.js's own header on why "likely," never
  // "confirmed page identity"). A failed/empty fetch just means
  // prioritization runs with zero client-intelligence matches -- it never
  // blocks the page list itself from rendering.
  useEffect(() => {
    let cancelled = false
    async function loadClientProfile() {
      try {
        const res = await fetch(`/api/clients/${clientId}/profile-fields`)
        if (!res.ok) return
        const body = await res.json()
        const rows = Array.isArray(body.fields) ? body.fields : []
        if (cancelled) return
        const confirmedValues = fieldKey => rows
          .filter(r => r.field_key === fieldKey && r.confirmation_status === 'confirmed' && r.value)
          .map(r => r.value)
        setClientProfile({
          primaryServices: confirmedValues(PRIMARY_SERVICE_FIELD_KEY),
          secondaryServices: confirmedValues(SECONDARY_SERVICE_FIELD_KEY),
          geographies: confirmedValues(GEOGRAPHY_FIELD_KEY)
        })
      } catch (e) {
        // Best-effort -- see comment above.
      }
    }
    if (clientId) loadClientProfile()
    return () => { cancelled = true }
  }, [clientId])

  const realPages = Array.isArray(pillar?.raw?.sitemapPages) ? pillar.raw.sitemapPages : null
  const candidatePages = useMemo(() => (
    realPages && realPages.length > 0
      ? realPages
      : [{ path: '/', type: 'Home', sourceSitemap: null, classificationSource: 'url_pattern', classificationConfidence: 'high', classificationReason: 'This is the homepage.' }]
  ), [realPages])

  const { recommended, all } = useMemo(
    () => computeRecommendedSet(candidatePages, clientProfile),
    [candidatePages, clientProfile]
  )

  const recommendedPaths = useMemo(() => new Set(recommended.map(d => d.path)), [recommended])

  const filteredAll = useMemo(() => {
    const term = pageSearch.trim().toLowerCase()
    return all.filter(d => {
      if (typeFilter !== 'All' && d.type !== typeFilter) return false
      if (tierFilter !== 'All' && d.tier !== tierFilter) return false
      if (term && !d.path.toLowerCase().includes(term)) return false
      return true
    })
  }, [all, pageSearch, typeFilter, tierFilter])

  const effectiveOpenPath = resolveOpenPath({ openPath, recommended, candidatePages })
  const openDossier = all.find(d => d.path === effectiveOpenPath) || null

  function toggleQueued(path) {
    setQueuedPaths(prev => toggleQueuedPath(prev, path))
  }

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
            const homeChecksPassing = (pillar.checks || []).filter(c => c.status === 'pass').length
            const homeChecksTotal = (pillar.checks || []).length || 7
            const rowProps = dossier => ({
              key: dossier.path,
              dossier,
              isOpen: dossier.path === effectiveOpenPath,
              isQueued: queuedPaths.has(dossier.path),
              onOpen: setOpenPath,
              onToggleQueue: toggleQueued,
              homeChecksPassing,
              homeChecksTotal
            })
            return (
              <div>
                <div className="card" style={{ padding: 18, marginBottom: 14 }}>
                  <div className="grade-title" style={{ marginBottom: 2 }}>Not every page needs the same schema</div>
                  <div className="grade-sub" style={{ marginBottom: 10 }}>
                    Pages below are real page URLs discovered from this client&rsquo;s sitemap hierarchy (child sitemaps are followed automatically when the root sitemap is an index -- sitemap XML files themselves never appear here). Recommended pages are the ones most likely worth schema work first, based on page type and (where available) this client&rsquo;s AM-confirmed primary/secondary services and geography -- hover a page&rsquo;s type badge to see exactly why it landed where it did. Only the homepage is actually run through the Schema &amp; Structure checker&rsquo;s 7 checks today; every other page is honestly marked &ldquo;Not analyzed yet&rdquo; rather than a guessed result.
                  </div>
                  <div className="text-tiny text-muted">
                    {queuedPaths.size} page{queuedPaths.size === 1 ? '' : 's'} queued for schema work &mdash; kept only in this browser session (clears on refresh or a new audit run; durable tracking is a later phase).
                  </div>
                </div>

                <div className="card" style={{ padding: 18, marginBottom: 14 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Recommended for schema review ({recommended.length})</div>
                  {recommended.length === 0 && (
                    <p className="text-tiny text-muted" style={{ margin: '0 0 8px' }}>No pages met the bar for recommendation this run -- see All discovered pages below.</p>
                  )}
                  <div style={{ display: 'grid', gap: 6 }}>
                    {recommended.map(dossier => <PageRow {...rowProps(dossier)} showRecommendedBadge={false} />)}
                  </div>
                </div>

                <div className="card" style={{ padding: 18, marginBottom: 14 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>All discovered pages ({all.length}{realPages && realPages.length >= 150 ? '+' : ''})</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                    <input
                      type="text"
                      placeholder="Search by path..."
                      value={pageSearch}
                      onChange={e => setPageSearch(e.target.value)}
                      style={{ flex: '1 1 200px' }}
                    />
                    <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
                      <option value="All">All page types</option>
                      {PAGE_TYPE_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <select value={tierFilter} onChange={e => setTierFilter(e.target.value)}>
                      <option value="All">All priority tiers</option>
                      {PRIORITY_TIER_OPTIONS.map(t => <option key={t} value={t}>{TIER_LABELS[t]}</option>)}
                    </select>
                  </div>
                  {filteredAll.length === 0 ? (
                    <p className="text-tiny text-muted">No discovered pages match this filter.</p>
                  ) : (
                    <div style={{ display: 'grid', gap: 6 }}>
                      {filteredAll.map(dossier => (
                        <PageRow {...rowProps(dossier)} showRecommendedBadge={recommendedPaths.has(dossier.path)} />
                      ))}
                    </div>
                  )}
                  {!realPages && (
                    <p className="text-tiny text-muted" style={{ marginTop: 10 }}>
                      This run predates the real sitemap page list, or the sitemap fetch failed -- re-run the audit to see this client&rsquo;s actual pages here.
                    </p>
                  )}
                </div>

                {openDossier && (
                  <div className="card" style={{ padding: 18 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
                      Open page: {openDossier.path}
                      <span className={`text-tiny tier-badge ${TIER_TONE[openDossier.tier]}`} style={{ marginLeft: 8 }}>
                        {TIER_LABELS[openDossier.tier]} tier
                      </span>
                    </div>
                    <ul className="text-tiny text-muted" style={{ margin: '0 0 10px', paddingLeft: 18 }}>
                      {openDossier.reasons.map((r, i) => <li key={i}>{r.text}</li>)}
                    </ul>
                    {openDossier.type === 'Home' ? (
                      <p className="text-tiny text-muted" style={{ margin: '0 0 10px' }}>
                        This page has already been analyzed -- see &ldquo;What&rsquo;s missing&rdquo; for its real schema checks.
                      </p>
                    ) : (
                      <p className="text-tiny text-muted" style={{ margin: '0 0 10px' }}>
                        Page-level analysis isn&rsquo;t built yet -- that&rsquo;s the next workflow step, not something this screen fakes. For now, use the checkbox or the button below to add this page to the schema work queue.
                      </p>
                    )}
                    <button
                      className={queuedPaths.has(openDossier.path) ? 'btn btn-secondary' : 'btn btn-primary'}
                      onClick={() => toggleQueued(openDossier.path)}
                    >
                      {queuedPaths.has(openDossier.path) ? 'Remove from schema work' : 'Add to schema work'}
                    </button>
                  </div>
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
            {effectiveOpenPath === '/' ? (
              <button className="btn btn-primary" onClick={() => setStep(3)}>See gaps for the homepage &rarr;</button>
            ) : (
              <button className="btn btn-secondary" disabled title="Page-level analysis isn't built yet -- use Add to schema work instead.">
                Page-level gaps &mdash; not built yet
              </button>
            )}
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
