'use client'

import { useEffect, useMemo, useState } from 'react'
import SchemaGenerator from './SchemaGenerator'
import { CheckRow, IssuesList, pillarHeadline, StepChips } from './PillarsBoard'
import { computeRecommendedSet } from '../../../lib/schemaPagePriority'
import { toggleQueuedPath, resolveOpenPath } from '../../../lib/schemaPageSelection'
import { deriveHomepageState, deriveStateFromAnalysis, excludedPathsFromStates, getPageState } from '../../../lib/schemaPageLifecycle'

// RECOMMENDATION_BATCH_SIZE -- PRODUCT DECISION #2: "RECOMMENDATIONS SHOULD
// COME IN BATCHES OF 10... This is: NEXT BEST 10, not: TOP 10 FOREVER."
// Passed as both targetMin and targetMax to computeRecommendedSet (see that
// function's header for how "next batch" advancement falls out of
// excludePaths with no separate batch-index state needed).
const RECOMMENDATION_BATCH_SIZE = 10

// PAGE_STATE_LABELS / PAGE_STATE_TONE -- display-only presentation for
// lib/schemaPageLifecycle.js's PAGE_STATES, used by PageRow for every
// non-Home page (Home keeps its own real "Analyzed -- X / Y checks" label,
// unchanged -- PRODUCT DECISION #12 requires not touching its existing
// display, only its recommendation/exclusion behavior).
const PAGE_STATE_LABELS = {
  UNANALYZED: 'Not analyzed yet',
  ACTIONABLE_GAP: 'Actionable gap found',
  NO_ACTION_NEEDED: 'No action needed',
  WORK_IN_PROGRESS: 'Work in progress',
  COMPLETED: 'Completed'
}
const PAGE_STATE_TONE = {
  UNANALYZED: 'muted',
  ACTIONABLE_GAP: 'bad',
  NO_ACTION_NEEDED: 'good',
  WORK_IN_PROGRESS: 'caution',
  COMPLETED: 'good'
}

// PAGE_TYPE_OPTIONS / PRIORITY_TIER_OPTIONS (the "All discovered pages"
// filter dropdowns' option sets) were removed 2026-09-02 along with that
// section itself -- see PRODUCT DECISION #1's correction pass below. If a
// deliberate "search/add another page" affordance is designed later, these
// lists (lib/sitemapDiscovery.js's PAGE_TYPES / lib/schemaPagePriority.js's
// PRIORITY_TIERS) are still the canonical source to duplicate from.

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
function PageRow({ dossier, isOpen, isQueued, onOpen, onToggleQueue, showRecommendedBadge, homeChecksPassing, homeChecksTotal, pageState, isAnalyzing }) {
  const isHome = dossier.type === 'Home'
  // Home keeps its own real, already-audited label untouched (PRODUCT
  // DECISION #12). Every other page's status now reflects its real
  // lib/schemaPageLifecycle.js state -- "Not analyzed yet" until an AM
  // actually runs "Analyze page," never a guess.
  const statusTone = isHome ? (homeChecksPassing >= homeChecksTotal * 0.85 ? 'good' : 'bad') : (isAnalyzing ? 'caution' : PAGE_STATE_TONE[pageState] || 'muted')
  const statusText = isHome ? `Analyzed — ${homeChecksPassing} / ${homeChecksTotal} checks` : (isAnalyzing ? 'Analyzing…' : (PAGE_STATE_LABELS[pageState] || 'Not analyzed yet'))

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
  // -------------------------------------------------------------------
  // Phase B page-analysis state (2026-09-02) -- see lib/pageAnalysis.js and
  // lib/schemaPageLifecycle.js's headers for why this is real fetched
  // evidence (via the analyze-page API route), kept as plain React state
  // (current-run / UI-state-only, same as queuedPaths above) rather than
  // persisted anywhere.
  // -------------------------------------------------------------------
  const [pageAnalyses, setPageAnalyses] = useState(() => new Map()) // path -> lib/pageAnalysis.js result
  const [analyzingPaths, setAnalyzingPaths] = useState(() => new Set()) // paths with an in-flight "Analyze page" request
  const [analysisRequestErrors, setAnalysisRequestErrors] = useState(() => new Map()) // path -> message, only for a failed CALL to our own route (network/HTTP) -- a page that fetched but came back non-HTML/404/etc is a normal, successful analyzePage() result, not an error here

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

  // homepagePath -- 2026-09-02 CORRECTION: the live validation found the
  // homepage still showing up Recommended despite 7/7 checks passing. ROOT
  // CAUSE (traced, not patched cosmetically): pageStates below used to
  // hardcode the literal string '/' as "the homepage's path" instead of
  // asking the actual discovered/classified data what the homepage's real
  // path is. That is exactly the class of bug this codebase's other
  // modules go out of their way to avoid (see lib/sitemapDiscovery.js's own
  // sourceSitemap-tracking discipline) -- two independent places computing
  // "which page is the homepage" can silently disagree. This now derives
  // the homepage's path from the SAME candidatePages array
  // computeRecommendedSet consumes, by its real classification
  // (`type === 'Home'`, set once, authoritatively, by
  // lib/sitemapDiscovery.js's classifyPage / this file's own fallback
  // default) -- never a second, independent assumption about what that
  // path string looks like. A mismatch between "the page pageStates marks
  // resolved" and "the page computeRecommendedSet is asked to exclude" is
  // now structurally impossible: both read `dossier.path`/`page.path` off
  // the identical entry.
  const homepageEntry = useMemo(() => candidatePages.find(p => p.type === 'Home') || null, [candidatePages])

  // pageStates -- every page's real lib/schemaPageLifecycle.js state,
  // derived fresh on every render from its two real sources: the
  // homepage's existing 7-check pillar result (PRODUCT DECISION #12), and
  // this browser session's own "Analyze page" results (PRODUCT DECISION
  // #8/#10). Deliberately NOT its own independent useState -- deriving it
  // means it can never drift out of sync with `pillar` or `pageAnalyses`,
  // and a page's state is always exactly what those two real sources say
  // right now, never a stale copy.
  const pageStates = useMemo(() => {
    const states = new Map()
    if (pillar && homepageEntry) {
      const checksPassing = (pillar.checks || []).filter(c => c.status === 'pass').length
      const checksTotal = (pillar.checks || []).length || 7
      states.set(homepageEntry.path, deriveHomepageState({ checksPassing, checksTotal }))
    }
    for (const [path, analysis] of pageAnalyses.entries()) {
      states.set(path, deriveStateFromAnalysis(analysis))
    }
    return states
  }, [pillar, homepageEntry, pageAnalyses])

  // excludePaths -- PRODUCT DECISION #3 / #11: a page in a resolved state
  // (today: NO_ACTION_NEEDED -- see lib/schemaPageLifecycle.js) never
  // occupies a recommendation-batch slot. This is what actually fixes the
  // live bug: once the homepage is 7/7, its pageStates entry is
  // NO_ACTION_NEEDED, so it lands here and computeRecommendedSet skips it.
  const excludePaths = useMemo(() => excludedPathsFromStates(pageStates), [pageStates])

  const { recommended, all } = useMemo(
    () => computeRecommendedSet(candidatePages, clientProfile, { targetMin: RECOMMENDATION_BATCH_SIZE, targetMax: RECOMMENDATION_BATCH_SIZE, excludePaths }),
    [candidatePages, clientProfile, excludePaths]
  )

  const effectiveOpenPath = resolveOpenPath({ openPath, recommended, candidatePages })
  const openDossier = all.find(d => d.path === effectiveOpenPath) || null
  // isHomeOpen -- same fix as homepageEntry above: compares against the
  // homepage's REAL discovered path, never a hardcoded '/' literal.
  const isHomeOpen = !!homepageEntry && effectiveOpenPath === homepageEntry.path

  function toggleQueued(path) {
    setQueuedPaths(prev => toggleQueuedPath(prev, path))
  }

  // analyzePageNow(path) -- PRODUCT DECISION #6/#8's real QUEUED PAGE ->
  // OPEN/ANALYZE PAGE -> FETCH THAT PAGE -> RUN PAGE-TYPE-APPROPRIATE
  // SCHEMA ANALYSIS transition. Calls the analyze-page route (server-side,
  // since the browser can't fetch an arbitrary client site directly) for
  // exactly the one page an AM asked about -- never the whole sitemap, and
  // never automatically. A page's own classification metadata (type,
  // source, confidence) travels along so the route can run the correct
  // page-type check list without re-walking the sitemap to re-derive it.
  async function analyzePageNow(path) {
    if (analyzingPaths.has(path)) return // already in flight -- never double-fire on a fast double-click
    const dossier = all.find(d => d.path === path)
    setAnalyzingPaths(prev => new Set(prev).add(path))
    setAnalysisRequestErrors(prev => {
      if (!prev.has(path)) return prev
      const next = new Map(prev)
      next.delete(path)
      return next
    })
    try {
      const res = await fetch(`/api/clients/${clientId}/schema/analyze-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path,
          page: dossier ? {
            type: dossier.type,
            classificationSource: dossier.classificationSource,
            classificationConfidence: dossier.classificationConfidence
          } : undefined
        })
      })
      const body = await res.json()
      if (!res.ok) {
        setAnalysisRequestErrors(prev => new Map(prev).set(path, body?.error || `Request failed (HTTP ${res.status}).`))
        return
      }
      setPageAnalyses(prev => new Map(prev).set(path, body))
    } catch (e) {
      setAnalysisRequestErrors(prev => new Map(prev).set(path, 'Could not reach the server to analyze this page.'))
    } finally {
      setAnalyzingPaths(prev => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
    }
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
              homeChecksTotal,
              pageState: getPageState(pageStates, dossier.path),
              isAnalyzing: analyzingPaths.has(dossier.path)
            })
            const queuedDossiers = all.filter(d => queuedPaths.has(d.path))
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
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Next {RECOMMENDATION_BATCH_SIZE} recommended pages ({recommended.length})</div>
                  <p className="text-tiny text-muted" style={{ margin: '0 0 8px' }}>
                    A rolling batch, not a fixed top {RECOMMENDATION_BATCH_SIZE} -- once a page here needs no more action, the next-best eligible page from the full discovered universe takes its place. Checking a box below adds a page to the Schema work queue; it does not analyze or queue it on its own.
                  </p>
                  {recommended.length === 0 && (
                    <p className="text-tiny text-muted" style={{ margin: '0 0 8px' }}>No pages met the bar for recommendation this run -- see &ldquo;View all discovered pages&rdquo; below.</p>
                  )}
                  <div style={{ display: 'grid', gap: 6 }}>
                    {recommended.map(dossier => <PageRow {...rowProps(dossier)} showRecommendedBadge={false} />)}
                  </div>
                </div>

                {queuedDossiers.length > 0 && (
                  <div className="card" style={{ padding: 18, marginBottom: 14 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Schema work queue ({queuedDossiers.length})</div>
                    <p className="text-tiny text-muted" style={{ margin: '0 0 8px' }}>
                      Pages an AM has intentionally chosen for schema work -- separate from Recommended (the system&rsquo;s suggestion) and from Open (whichever page is currently shown below). Queuing a page doesn&rsquo;t analyze it by itself; click Analyze page to actually fetch it and run its real checks.
                    </p>
                    <div style={{ display: 'grid', gap: 6 }}>
                      {queuedDossiers.map(dossier => {
                        const state = getPageState(pageStates, dossier.path)
                        const isAnalyzing = analyzingPaths.has(dossier.path)
                        const reqError = analysisRequestErrors.get(dossier.path)
                        return (
                          <div key={dossier.path} className="page-row" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', alignItems: 'center', gap: 10 }}>
                            <span className="type-badge" style={{ cursor: 'default' }}>{dossier.type}</span>
                            <span className="path" onClick={() => setOpenPath(dossier.path)} style={{ cursor: 'pointer', textDecoration: dossier.path === effectiveOpenPath ? 'underline' : 'none' }}>
                              {dossier.path}
                            </span>
                            <span className={`status ${isAnalyzing ? 'caution' : PAGE_STATE_TONE[state] || 'muted'}`}>
                              {isAnalyzing ? 'Analyzing…' : (reqError || PAGE_STATE_LABELS[state] || 'Not analyzed yet')}
                            </span>
                            <button className="btn btn-secondary" disabled={isAnalyzing || dossier.type === 'Home'} onClick={() => analyzePageNow(dossier.path)}>
                              {dossier.type === 'Home' ? 'Already analyzed' : (state === 'UNANALYZED' ? 'Analyze page' : 'Re-analyze page')}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* PRODUCT DECISION #1 (2026-09-02 correction pass): "All
                    discovered pages" is REMOVED from the normal workflow --
                    not merely collapsed behind a toggle, which the live
                    validation showed was not good enough (an AM should
                    never be handed 282 URLs to browse). The full discovered
                    universe (`all`, from computeRecommendedSet) still feeds
                    classification, prioritization, and the recommendation
                    batch/advancement logic below -- it is simply no longer
                    rendered as a browsable list. If "search/add another
                    page" is needed later, that is an intentional, separate
                    design decision, not a re-add of this section. */}

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
                        {getPageState(pageStates, openDossier.path) === 'NO_ACTION_NEEDED'
                          ? 'This page has already been analyzed and has no actionable schema gap -- no action needed.'
                          : 'This page has already been analyzed -- see “What’s missing” for its real schema checks.'}
                      </p>
                    ) : (() => {
                      const state = getPageState(pageStates, openDossier.path)
                      const isAnalyzing = analyzingPaths.has(openDossier.path)
                      const reqError = analysisRequestErrors.get(openDossier.path)
                      return (
                        <>
                          <p className="text-tiny text-muted" style={{ margin: '0 0 10px' }}>
                            {state === 'UNANALYZED' && !isAnalyzing && 'Not analyzed yet -- click Analyze page to fetch this page and run its real, page-type-appropriate schema checks (never the homepage’s 7 checks).'}
                            {isAnalyzing && 'Fetching this page and running its schema checks now…'}
                            {state === 'ACTIONABLE_GAP' && 'A real schema gap was found on this page -- see “See schema gaps” below.'}
                            {state === 'NO_ACTION_NEEDED' && 'Analyzed -- no actionable schema gap found on this page.'}
                            {reqError && ` (${reqError})`}
                          </p>
                          <button
                            className="btn btn-secondary"
                            disabled={isAnalyzing}
                            style={{ marginRight: 8 }}
                            onClick={() => analyzePageNow(openDossier.path)}
                          >
                            {state === 'UNANALYZED' ? 'Analyze page' : 'Re-analyze page'}
                          </button>
                        </>
                      )
                    })()}
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
            {isHomeOpen ? (
              <button className="btn btn-primary" onClick={() => setStep(3)}>See gaps for the homepage &rarr;</button>
            ) : (() => {
              // PRODUCT DECISION #7: this button is now genuinely contextual
              // to the open/queued page instead of always routing to the
              // homepage's gaps -- "ANALYZE PAGE" while unanalyzed, "SEE
              // SCHEMA GAPS" once a real gap was found, disabled "NO ACTION
              // NEEDED" once analysis confirms there's nothing to fix.
              const state = getPageState(pageStates, effectiveOpenPath)
              const isAnalyzing = analyzingPaths.has(effectiveOpenPath)
              if (isAnalyzing) {
                return <button className="btn btn-secondary" disabled>Analyzing…</button>
              }
              if (state === 'ACTIONABLE_GAP') {
                return <button className="btn btn-primary" onClick={() => setStep(3)}>See schema gaps &rarr;</button>
              }
              if (state === 'NO_ACTION_NEEDED') {
                return <button className="btn btn-secondary" disabled title="This page was analyzed and has no actionable schema gap.">No action needed</button>
              }
              return (
                <button className="btn btn-primary" onClick={() => analyzePageNow(effectiveOpenPath)}>
                  Analyze page &rarr;
                </button>
              )
            })()}
          </div>
        </div>
      )}

      {step === 3 && (
        <div>
          {!isHomeOpen ? (() => {
            // PRODUCT DECISION #9/#10: a non-homepage page's "What's
            // missing" is the real, page-type-dispatched analysis-result
            // contract from lib/pageAnalysis.js -- CURRENT SCHEMA /
            // APPLICABLE / MISSING-INVALID / NOT APPLICABLE / ACTIONABLE
            // SCHEMA GAP -- never the homepage's 7 checks.
            const analysis = pageAnalyses.get(effectiveOpenPath)
            const dossier = all.find(d => d.path === effectiveOpenPath)
            if (!analysis) {
              return (
                <div className="card-empty" style={{ padding: 18 }}>
                  <div className="text-small text-muted">This page hasn&rsquo;t been analyzed yet -- go back and click Analyze page.</div>
                </div>
              )
            }
            if (analysis.fetchState !== 'success') {
              return (
                <div className="card" style={{ padding: 18 }}>
                  <div className="grade-title" style={{ marginBottom: 8 }}>{analysis.path} &mdash; could not be analyzed</div>
                  <p className="text-small issue-why">
                    {analysis.failureDetail || `Fetch failed (${analysis.failureCategory}).`} This is an honest fetch failure, not evidence the page has no schema -- try Re-analyze page once the issue above is resolved.
                  </p>
                </div>
              )
            }
            const AnalysisListRow = ({ label, tone }) => (
              <div className="issue-item" key={label}>
                <span className={`issue-badge ${tone === 'good' ? 'issue-passing' : tone === 'bad' ? 'issue-critical' : 'issue-minor'}`}>
                  {tone === 'good' ? 'Present' : tone === 'bad' ? 'Missing / invalid' : 'Not applicable'}
                </span>
                <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>{label}</div>
              </div>
            )
            return (
              <div className="card" style={{ padding: 18 }}>
                <div className="grade-title" style={{ marginBottom: 2 }}>{analysis.path}</div>
                <div className="grade-sub" style={{ marginBottom: 4 }}>
                  Classification: {analysis.classification.type} (source: {analysis.classification.source}, confidence: {analysis.classification.confidence})
                </div>
                <div className="grade-sub" style={{ marginBottom: 14 }}>
                  Current schema on this page: {analysis.currentSchema.length > 0 ? analysis.currentSchema.join(', ') : 'None found'}
                </div>

                <div style={{ fontWeight: 600, fontSize: 13, margin: '4px 0 8px' }}>
                  Actionable schema gap: {analysis.actionableGap ? 'Yes' : 'No'}
                </div>
                {analysis.actionableGap ? (
                  <p className="text-tiny text-muted" style={{ margin: '0 0 12px' }}>
                    This page has a real, genuinely-applicable schema gap -- see &ldquo;Missing / invalid&rdquo; below. Prepared schema work for arbitrary page types is a later phase; queuing this page alone does not create that work automatically.
                  </p>
                ) : (
                  <p className="text-tiny text-muted" style={{ margin: '0 0 12px' }}>
                    No actionable gap -- every genuinely-applicable check for this page type either passed or doesn&rsquo;t apply here. This page is marked No action needed and will not appear in future recommendation batches.
                  </p>
                )}

                {analysis.missingOrInvalid.length > 0 && (
                  <>
                    <div style={{ fontWeight: 600, fontSize: 13, margin: '4px 0 8px' }}>Missing / invalid</div>
                    <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
                      {analysis.missingOrInvalid.map(c => <AnalysisListRow key={c.id} label={c.label} tone="bad" />)}
                    </div>
                  </>
                )}
                {analysis.applicable.filter(c => !analysis.missingOrInvalid.some(m => m.id === c.id)).length > 0 && (
                  <>
                    <div style={{ fontWeight: 600, fontSize: 13, margin: '4px 0 8px' }}>Applicable and passing</div>
                    <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
                      {analysis.applicable.filter(c => !analysis.missingOrInvalid.some(m => m.id === c.id)).map(c => <AnalysisListRow key={c.id} label={c.label} tone="good" />)}
                    </div>
                  </>
                )}
                {analysis.notApplicable.length > 0 && (
                  <>
                    <div style={{ fontWeight: 600, fontSize: 13, margin: '4px 0 8px' }}>Not applicable to this page type</div>
                    <div style={{ display: 'grid', gap: 8 }}>
                      {analysis.notApplicable.map(c => <AnalysisListRow key={c.id} label={c.label} tone="muted" />)}
                    </div>
                  </>
                )}
              </div>
            )
          })() : pillar ? (() => {
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
            {isHomeOpen ? (
              <button className="btn btn-primary" onClick={() => setStep(4)}>Fix with the generator &rarr;</button>
            ) : (
              // PRODUCT DECISION #10: "Do not create a Phase 3 opportunity
              // merely because the page was queued." The Schema Generator
              // (steps 4-6) is homepage/business-entity-specific; prepared
              // schema work for an arbitrary page type's real gap is an
              // explicitly later phase, not fabricated here.
              <button className="btn btn-secondary" disabled title="Prepared schema work for this page is a later phase -- not built yet.">
                Prepared schema work &mdash; not built yet
              </button>
            )}
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
