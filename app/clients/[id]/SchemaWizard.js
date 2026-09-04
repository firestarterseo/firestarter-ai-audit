'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import SchemaGenerator from './SchemaGenerator'
import { CheckRow, IssuesList, pillarHeadline, StepChips } from './PillarsBoard'
import { computeRecommendedSet } from '../../../lib/schemaPagePriority'
import { toggleQueuedPath, resolveOpenPath } from '../../../lib/schemaPageSelection'
import { deriveHomepageState, deriveStateFromAnalysis, excludedPathsFromStates, getPageState } from '../../../lib/schemaPageLifecycle'
import { mergeDurableQueuedPaths, mergeDurableAnalyses } from '../../../lib/schemaPageHydration'
import { runWithBoundedConcurrency } from '../../../lib/schemaBatchAnalysis'

// BATCH_CONCURRENCY -- Phase 6 (2026-09-04): how many "Analyze Selected" /
// "Prepare Selected" network calls run at once. Bounded deliberately -- an
// AM selecting, say, 40 queued pages must never fire 40 simultaneous
// live-site fetches (or 40 simultaneous LLM-backed prepare-work calls) at
// once. 3 mirrors this codebase's other bounded-concurrency choices for
// live external calls (see lib/serpLandscape.js's own Cloro-call batching).
const BATCH_CONCURRENCY = 3

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
function PageRow({ dossier, isOpen, isQueued, onOpen, onToggleQueue, showRecommendedBadge, homeChecksPassing, homeChecksTotal, pageState, isAnalyzing, queueError }) {
  const isHome = dossier.type === 'Home'
  // Home keeps its own real, already-audited label untouched (PRODUCT
  // DECISION #12). Every other page's status now reflects its real
  // lib/schemaPageLifecycle.js state -- "Not analyzed yet" until an AM
  // actually runs "Analyze page," never a guess.
  const statusTone = isHome ? (homeChecksPassing >= homeChecksTotal * 0.85 ? 'good' : 'bad') : (isAnalyzing ? 'caution' : PAGE_STATE_TONE[pageState] || 'muted')
  const statusText = isHome ? `Analyzed — ${homeChecksPassing} / ${homeChecksTotal} checks` : (isAnalyzing ? 'Analyzing…' : (PAGE_STATE_LABELS[pageState] || 'Not analyzed yet'))

  return (
    <div>
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
      {/* PERSISTENCE WIRING (Phase 5, 2026-09) -- a failed queue-toggle save
          reverts the checkbox above (see toggleQueued) AND surfaces this
          message, so an AM never wrongly believes a queue change survived a
          refresh when the server never actually saved it. */}
      {queueError && (
        <p className="text-small issue-why" style={{ margin: '2px 0 0 24px' }}>Could not save this queue change: {queueError}</p>
      )}
    </div>
  )
}

// FINAL_STATUS_COPY -- DIAGNOSTIC METHODOLOGY pass (2026-09-03). Plain-
// language label + tone per lib/schemaPageTypeChecks.js's four-value
// finalStatus. Deliberately no ranking-impact claim anywhere here (per the
// approved methodology's rule #12: never claim schema will improve
// rankings) -- these describe what the diagnosis found, not what adding
// schema will do for the page.
const FINAL_STATUS_COPY = {
  ACTION_REQUIRED: { label: 'Action required', tone: 'issue-critical' },
  IMPROVEMENT_AVAILABLE: { label: 'Improvement available', tone: 'issue-minor' },
  NO_ACTION_NEEDED: { label: 'No action needed', tone: 'issue-passing' },
  COULD_NOT_VERIFY: { label: 'Could not verify', tone: 'issue-minor' }
}

// CheckList -- shared renderer for a tier's check entries (Core or
// Recommended), each already carrying its own real, data-derived evidence
// sentence from lib/schemaPageTypeChecks.js.
function CheckList({ checks }) {
  if (checks.length === 0) return null
  return (
    <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
      {checks.map(c => (
        <div className="issue-item" key={c.id}>
          <span className={`issue-badge ${c.status === 'pass' ? 'issue-passing' : 'issue-critical'}`}>
            {c.status === 'pass' ? 'Pass' : 'Fail'}
          </span>
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>{c.label}</div>
          <p className="text-small issue-why">{c.evidence}</p>
        </div>
      ))}
    </div>
  )
}

// PageAnalysisResult -- DIAGNOSTIC METHODOLOGY pass (2026-09-03), replacing
// the flat applicable/missingOrInvalid/notApplicable/actionableGap shape
// with the approved TARGET PROFILE / CORE / RECOMMENDED / AVOID / NOT
// APPLICABLE / FINAL STATUS result model (lib/schemaPageTypeChecks.js).
// Shared between the Schema work queue's inline expansion and Step 3's
// detail view, so a page's diagnostic reads identically wherever an AM
// looks at it. Every Core and Recommended check -- pass or fail -- is
// always rendered; Final Status is the LAST thing shown, never the only
// thing shown ("MAKE 'NO ACTION NEEDED' A CONCLUSION, NOT THE ENTIRE
// RESULT," carried over unchanged from the prior UX pass).
function PageAnalysisResult({ analysis }) {
  if (!analysis) return null

  if (analysis.fetchState !== 'success') {
    return (
      <p className="text-small issue-why">
        {analysis.failureDetail || `Fetch failed (${analysis.failureCategory}).`} This is an honest fetch failure, not evidence the page has no schema -- try Re-analyze page once the issue above is resolved.
      </p>
    )
  }

  const statusCopy = FINAL_STATUS_COPY[analysis.finalStatus] || { label: analysis.finalStatus, tone: 'issue-minor' }

  return (
    <div>
      <div className="grade-sub" style={{ marginBottom: 10 }}>
        Classification: {analysis.classification.type} (source: {analysis.classification.source}, confidence: {analysis.classification.confidence})
        {analysis.targetProfile && <> &middot; Target profile: {analysis.targetProfile}</>}
      </div>

      <div style={{ fontWeight: 600, fontSize: 13, margin: '4px 0 6px' }}>Current schema detected</div>
      <p className="text-tiny text-muted" style={{ margin: '0 0 14px' }}>
        {analysis.currentSchema.length > 0 ? analysis.currentSchema.join(', ') : 'None found'}
      </p>

      <div style={{ fontWeight: 600, fontSize: 13, margin: '4px 0 8px' }}>Core checks</div>
      <CheckList checks={analysis.coreChecks} />

      <div style={{ fontWeight: 600, fontSize: 13, margin: '4px 0 8px' }}>Recommended enhancements</div>
      <CheckList checks={analysis.recommendedChecks} />
      {analysis.recommendedChecks.length === 0 && (
        <p className="text-tiny text-muted" style={{ margin: '0 0 16px' }}>No recommended enhancements tracked for this target profile.</p>
      )}

      {analysis.avoidFindings.length > 0 && (
        <>
          <div style={{ fontWeight: 600, fontSize: 13, margin: '4px 0 8px' }}>Avoid &mdash; flagged for review</div>
          <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
            {analysis.avoidFindings.map(f => (
              <div className="issue-item" key={f.id}>
                <span className="issue-badge issue-critical">Review</span>
                <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>{f.label}</div>
                <p className="text-small issue-why">{f.evidence}</p>
              </div>
            ))}
          </div>
        </>
      )}

      {analysis.notApplicable.length > 0 && (
        <>
          <div style={{ fontWeight: 600, fontSize: 13, margin: '4px 0 8px' }}>Not applicable to this target profile</div>
          <p className="text-tiny text-muted" style={{ margin: '0 0 16px' }}>
            {analysis.notApplicable.map(c => c.label).join(', ')} &mdash; not counted as failures.
          </p>
        </>
      )}

      <div style={{ fontWeight: 600, fontSize: 13, margin: '4px 0 4px' }}>
        Final status: <span className={`issue-badge ${statusCopy.tone}`}>{statusCopy.label}</span>
      </div>
      {analysis.targetProfile === 'LOCATION_UNCONFIRMED' && (
        <p className="text-tiny text-muted" style={{ margin: 0 }}>
          This page&rsquo;s physical-location status (a real staffed office vs. a service-area landing page) is not yet confirmed &mdash; no LocalBusiness/address schema is recommended until that&rsquo;s established.
        </p>
      )}
    </div>
  )
}

// PreparedWorkPanel -- Schema Prepared Work + AM Review (Phase 6,
// 2026-09-03). Renders instruction #5's mockup: DIAGNOSIS is
// PageAnalysisResult above this panel (never duplicated here); this panel
// covers CURRENT SCHEMA / PROPOSED CHANGES (ADD/MODIFY, KEEP alongside)
// / PREPARED JSON-LD / APPROVE / EDIT THEN APPROVE / REJECT. Purely
// presentational plus the callbacks SchemaWizard passes in -- it never
// calls fetch() itself.
//
// ELIGIBILITY (client-side mirror of lib/schemaOpportunity.js's
// isEligibleForPreparedWork -- display-only; the prepare-work route
// re-derives this authoritatively server-side regardless): ACTION_REQUIRED,
// or IMPROVEMENT_AVAILABLE with a real failing Recommended check.
// NO_ACTION_NEEDED / COULD_NOT_VERIFY never show the CTA, and this panel
// renders nothing at all once there's neither an eligible diagnosis NOR
// any prepared work already on file for this page.
function isEligibleForPreparedWorkDisplay(analysis) {
  if (!analysis || analysis.fetchState !== 'success') return false
  if (analysis.finalStatus === 'ACTION_REQUIRED') return (analysis.coreChecks || []).some(c => c.status === 'fail')
  if (analysis.finalStatus === 'IMPROVEMENT_AVAILABLE') return (analysis.recommendedChecks || []).some(c => c.status === 'fail')
  return false
}

const APPROVAL_STATUS_COPY = {
  pending: { label: 'Pending AM review', tone: 'issue-minor' },
  approved: { label: 'Approved -- ready for execution (manual/RED)', tone: 'issue-passing' },
  rejected: { label: 'Rejected', tone: 'issue-critical' }
}

function SchemaChangeList({ title, items, tone }) {
  if (!items || items.length === 0) return null
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontWeight: 600, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--muted)', marginBottom: 4 }}>{title}</div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
        {items.map((item, i) => <li key={i} style={{ marginBottom: 4 }}>{typeof item === 'string' ? item : item.description}</li>)}
      </ul>
    </div>
  )
}

function PreparedWorkPanel({
  path, analysis, prepared, isPreparing, isBusy, error, editingDraft,
  onPrepare, onApprove, onStartEdit, onCancelEdit, onDraftChange, onSaveEdit, onReject
}) {
  const eligible = isEligibleForPreparedWorkDisplay(analysis)
  const opportunity = prepared?.opportunity
  const versions = prepared?.preparedWork || []
  const latest = versions[0] || null

  if (!eligible && !opportunity) return null

  return (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Schema prepared work</div>

      {error && <p className="text-small issue-why" style={{ marginBottom: 8 }}>{error}</p>}

      {!opportunity && eligible && (
        <>
          <p className="text-tiny text-muted" style={{ margin: '0 0 8px' }}>
            This page&rsquo;s diagnosed gap can be prepared as real, page-specific schema for AM review -- nothing is generated or changed until you click below.
          </p>
          <button className="btn btn-primary" disabled={isPreparing} onClick={onPrepare}>
            {isPreparing ? 'Preparing…' : 'Prepare schema work'}
          </button>
        </>
      )}

      {opportunity && latest && (
        <div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
            {opportunity.detail?.targetProfile && <>Target profile: {opportunity.detail.targetProfile} &middot; </>}
            Version {latest.version}{latest.created_by === 'am' ? ' (AM-edited)' : ''}
            {latest.status === 'preparation_failed' && ' -- preparation failed'}
          </div>

          {latest.status === 'preparation_failed' ? (
            <p className="text-small issue-why">
              {latest.payload?.reason || 'No content-defensible schema change could be generated for this page without fabricating evidence.'}
            </p>
          ) : (
            <>
              <SchemaChangeList title="Current schema (kept unchanged)" items={latest.payload?.keep} />
              <SchemaChangeList title="Proposed: add" items={latest.payload?.add} />
              <SchemaChangeList title="Proposed: modify" items={latest.payload?.modify} />

              {latest.payload?.canonicalEntity && !latest.payload.canonicalEntity.resolved && (
                <p className="text-tiny text-muted" style={{ margin: '0 0 8px' }}>
                  Canonical Organization @id not resolved ({latest.payload.canonicalEntity.source}) -- entity references were omitted rather than fabricated.
                </p>
              )}
              {Array.isArray(latest.payload?.unresolvedDependencies) && latest.payload.unresolvedDependencies.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>Unresolved dependencies</div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--muted)' }}>
                    {latest.payload.unresolvedDependencies.map((d, i) => <li key={i}>{d}</li>)}
                  </ul>
                </div>
              )}

              {editingDraft === undefined ? (
                (latest.payload?.add?.length > 0 || latest.payload?.modify?.length > 0) && (
                  <>
                    <div style={{ fontWeight: 600, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--muted)', marginBottom: 4 }}>Prepared JSON-LD</div>
                    <pre style={{ background: 'var(--bg-alt)', padding: 10, borderRadius: 'var(--radius-sm)', fontSize: 12, overflowX: 'auto', marginBottom: 10 }}>
                      {JSON.stringify({ add: latest.payload.add, modify: latest.payload.modify }, null, 2)}
                    </pre>
                  </>
                )
              ) : (
                <>
                  <div style={{ fontWeight: 600, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--muted)', marginBottom: 4 }}>Edit prepared JSON-LD (add / modify)</div>
                  <textarea
                    value={editingDraft}
                    onChange={(e) => onDraftChange(e.target.value)}
                    rows={12}
                    style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, marginBottom: 8 }}
                  />
                </>
              )}
            </>
          )}

          {opportunity.approval_status && APPROVAL_STATUS_COPY[opportunity.approval_status] && (
            <div style={{ margin: '4px 0 10px' }}>
              <span className={`issue-badge ${APPROVAL_STATUS_COPY[opportunity.approval_status].tone}`}>
                {APPROVAL_STATUS_COPY[opportunity.approval_status].label}
              </span>
            </div>
          )}

          {opportunity.approval_status === 'pending' && latest.status !== 'preparation_failed' && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {editingDraft === undefined ? (
                <>
                  <button className="btn btn-primary" disabled={isBusy} onClick={() => onApprove(latest)}>Approve</button>
                  <button className="btn btn-secondary" disabled={isBusy} onClick={() => onStartEdit(latest.payload)}>Edit before approving</button>
                  <button className="btn btn-secondary" disabled={isBusy} onClick={onReject}>Reject</button>
                </>
              ) : (
                <>
                  <button className="btn btn-primary" disabled={isBusy} onClick={() => onSaveEdit(latest)}>Save edited version</button>
                  <button className="btn btn-secondary" disabled={isBusy} onClick={onCancelEdit}>Cancel edit</button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function SchemaWizard({ pillar, clientId, client }) {
  const [step, setStep] = useState(1)
  const [selectedPill, setSelectedPill] = useState(null)
  const pills = pillar ? schemaStatPills(pillar) : []

  // -------------------------------------------------------------------
  // Phase A page-selection state (2026-09-02). `openPath` (which page is
  // currently open) remains plain, current-run-only React state -- there is
  // no product requirement to remember it across a refresh. `queuedPaths`
  // is still a plain React Set for the SAME reason toggleQueued below is
  // still an immediate, optimistic local update (an AM's click must never
  // feel gated on a network round trip) -- but as of Phase 5 (2026-09) it
  // is also durably persisted (lib/schemaPageWork.js, via the page-work/queue
  // route) and hydrated back on mount (see durableRows/hydratedPageWorkRef
  // below), so a refresh no longer loses it.
  // -------------------------------------------------------------------
  const [clientProfile, setClientProfile] = useState({ primaryServices: [], secondaryServices: [], geographies: [] })
  const [openPath, setOpenPath] = useState(null)
  const [queuedPaths, setQueuedPaths] = useState(() => new Set())
  // -------------------------------------------------------------------
  // Phase B page-analysis state (2026-09-02) -- see lib/pageAnalysis.js and
  // lib/schemaPageLifecycle.js's headers for why this is real fetched
  // evidence (via the analyze-page API route). As of Phase 5 (2026-09),
  // every completed analysis is also durably persisted (lib/schemaPageWork.js)
  // and hydrated back into this Map on mount (see durableRows/
  // hydratedPageWorkRef below) -- `pageAnalyses` itself stays a plain React
  // Map for the same "instant local update" reasoning as queuedPaths above.
  // -------------------------------------------------------------------
  const [pageAnalyses, setPageAnalyses] = useState(() => new Map()) // path -> lib/pageAnalysis.js result
  const [analyzingPaths, setAnalyzingPaths] = useState(() => new Set()) // paths with an in-flight "Analyze page" request
  const [analysisRequestErrors, setAnalysisRequestErrors] = useState(() => new Map()) // path -> message, only for a failed CALL to our own route (network/HTTP) -- a page that fetched but came back non-HTML/404/etc is a normal, successful analyzePage() result, not an error here
  // expandedAnalysisPaths -- PAGE ANALYSIS RESULT UX pass (2026-09-02):
  // which queued pages currently have their full diagnostic breakdown
  // expanded inline in the Schema work queue. Deliberately separate from
  // `openPath`/`effectiveOpenPath` -- viewing a page's analysis in the
  // queue must never change which page is "open," and vice versa (same
  // independence discipline as OPEN vs QUEUED). A page's analysis, once
  // run, stays visible on request regardless of its NO_ACTION_NEEDED /
  // ACTIONABLE_GAP conclusion -- "DO NOT HIDE PASSING PAGES' ANALYSIS."
  const [expandedAnalysisPaths, setExpandedAnalysisPaths] = useState(() => new Set())
  // queuePersistErrors -- a queue/unqueue toggle that failed to save
  // server-side (see toggleQueued below, which reverts the optimistic
  // local change when this happens). analysisPersistWarnings -- a
  // completed, correctly-shown analysis whose durable save failed (see
  // analyzePageNow below); non-blocking, since the diagnosis itself is
  // still real and correct -- only a refresh could lose it.
  const [queuePersistErrors, setQueuePersistErrors] = useState(() => new Map())
  const [analysisPersistWarnings, setAnalysisPersistWarnings] = useState(() => new Map())

  // -------------------------------------------------------------------
  // Durable Schema page-work state (Phase 5, 2026-09) -- see
  // lib/schemaPageWork.js and lib/schemaPageHydration.js. `durableRows` is
  // a plain read-only cache of GET /api/clients/[id]/schema/page-work,
  // fetched once on mount; `hydratedPageWorkRef` guards the ONE-TIME merge
  // of that durable state into queuedPaths/pageAnalyses below so a later
  // sitemap/recommendation recompute (or a slow-resolving fetch) can never
  // re-apply now-stale durable state over an AM's own in-session actions
  // (Section 9/12 of the Phase 5 spec -- "never wipe durable state... "
  // cuts both ways).
  // -------------------------------------------------------------------
  const [durableRows, setDurableRows] = useState(null) // null = not yet loaded
  const hydratedPageWorkRef = useRef(false)

  // -------------------------------------------------------------------
  // Schema Prepared Work + AM Review state (Phase 6, 2026-09-03). Unlike
  // pageAnalyses above, this IS durable server-side state -- every value
  // here is a client-side CACHE of what app/api/clients/[id]/schema/
  // prepare-work/route.js and the shared opportunity lifecycle route
  // already persisted (the real opportunities/opportunity_prepared_work
  // rows), refreshed after every prepare/approve/edit/reject call. Losing
  // this cache (e.g. a page refresh) loses nothing real -- the GET branch
  // of the prepare-work route re-reads it from Supabase on demand.
  // -------------------------------------------------------------------
  const [preparedWorkByPath, setPreparedWorkByPath] = useState(() => new Map()) // path -> { opportunity, preparedWork: [...] }
  const [preparingPaths, setPreparingPaths] = useState(() => new Set())
  const [lifecycleBusyPaths, setLifecycleBusyPaths] = useState(() => new Set())
  const [preparedWorkErrors, setPreparedWorkErrors] = useState(() => new Map())
  const [editingDrafts, setEditingDrafts] = useState(() => new Map()) // path -> draft JSON text

  // -------------------------------------------------------------------
  // Schema Batch Workflow state (Phase 6, 2026-09-04). `selectedPaths` is a
  // NEW, purely client-side, NEVER-persisted selection layer -- fully
  // independent of the durable `queuedPaths` above (Section 3's SELECTION
  // MODEL: selecting a page for a batch action is not the same fact as
  // queuing it, and must never be confused with or survive as durable
  // state). It is pruned whenever a path leaves the queue (see
  // toggleQueued below) since a batch action should never silently target
  // a page an AM just removed from schema work.
  // -------------------------------------------------------------------
  const [selectedPaths, setSelectedPaths] = useState(() => new Set())
  const [isBatchAnalyzing, setIsBatchAnalyzing] = useState(false)
  const [batchAnalysisSummary, setBatchAnalysisSummary] = useState(null) // { total, succeeded, failedPaths } | null
  const [isBatchPreparing, setIsBatchPreparing] = useState(false)
  const [batchPrepareSummary, setBatchPrepareSummary] = useState(null) // { total, succeeded, failedPaths } | null

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

  // Durable Schema page-work hydration (Phase 5, 2026-09) -- a single,
  // best-effort read of every durable schema_page_work row for this
  // client, once per mount. A failed/empty fetch just means hydration
  // never runs (queuedPaths/pageAnalyses simply stay current-run-only, as
  // they always were before this phase) -- it never blocks the page list
  // itself from rendering, same discipline as the client-profile fetch
  // above.
  useEffect(() => {
    let cancelled = false
    async function loadPageWork() {
      try {
        const res = await fetch(`/api/clients/${clientId}/schema/page-work`)
        if (!res.ok) return
        const body = await res.json()
        if (cancelled) return
        setDurableRows(Array.isArray(body.pages) ? body.pages : [])
      } catch (e) {
        // Best-effort -- see comment above.
      }
    }
    if (clientId) loadPageWork()
    return () => { cancelled = true }
  }, [clientId])

  // ONE-TIME merge of durable state into queuedPaths/pageAnalyses, as soon
  // as both the durable rows AND the candidate-page list are available.
  // Guarded by hydratedPageWorkRef so this never re-runs on a later
  // sitemap/recommendation recompute -- see that ref's declaration above
  // for why. Seeding pageAnalyses here is sufficient for the recommendation
  // engine's exclusion/eligibility to reflect durable state correctly, with
  // ZERO changes to lib/schemaPageLifecycle.js or lib/schemaPagePriority.js
  // (pageStates below is a useMemo purely derived from pageAnalyses).
  useEffect(() => {
    if (hydratedPageWorkRef.current) return
    if (durableRows === null) return
    if (!candidatePages || candidatePages.length === 0) return
    hydratedPageWorkRef.current = true
    const candidatePaths = candidatePages.map(p => p.path)
    setQueuedPaths(prev => mergeDurableQueuedPaths(prev, durableRows, candidatePaths))
    setPageAnalyses(prev => mergeDurableAnalyses(prev, durableRows, candidatePaths))
  }, [durableRows, candidatePages])

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

  // queuedDossiers -- PHASE 6 (2026-09-04): hoisted out of Step 2's JSX
  // (where it used to be computed inline, once per render, only reachable
  // from that one spot) so the new multi-page selection/batch-analysis
  // logic below can reference the same list without duplicating the
  // filter or risking it drifting out of sync with the queue the AM
  // actually sees.
  const queuedDossiers = useMemo(() => all.filter(d => queuedPaths.has(d.path)), [all, queuedPaths])

  // Best-effort, read-only load of any Schema prepared work that already
  // exists for a page -- calls the prepare-work route's GET branch ONLY
  // (never POST: this never fetches the client's live site, never
  // qualifies, never generates anything). Skips entirely once a path is
  // already cached, so switching back and forth between pages never
  // re-fetches state it already has.
  //
  // PHASE 6 (2026-09-04) extension: this used to hydrate ONLY the
  // currently open page. It now covers every QUEUED page as well (so the
  // new multi-page review section below can show every queued page's
  // prepared-work/approval status without an AM having to open each one
  // first), plus the open page itself in case it isn't queued (preserving
  // the original single-page behavior for a Recommended-but-not-yet-queued
  // page an AM is previewing). Bounded concurrency keeps a client with
  // many queued pages from firing an unbounded burst of requests at once.
  useEffect(() => {
    const targetSet = new Set(queuedPaths)
    if (effectiveOpenPath && !isHomeOpen) targetSet.add(effectiveOpenPath)
    if (homepageEntry) targetSet.delete(homepageEntry.path)
    const targets = Array.from(targetSet).filter(path => !preparedWorkByPath.has(path))
    if (targets.length === 0) return
    let cancelled = false
    runWithBoundedConcurrency(targets, async (path) => {
      const res = await fetch(`/api/clients/${clientId}/schema/prepare-work?path=${encodeURIComponent(path)}`)
      if (!res.ok) return
      const body = await res.json().catch(() => null)
      if (cancelled || !body || !body.opportunity) return
      setPreparedWorkByPath(prev => (prev.has(path) ? prev : new Map(prev).set(path, { opportunity: body.opportunity, preparedWork: body.preparedWork || [] })))
    }, BATCH_CONCURRENCY)
    // Best-effort throughout -- an AM can always click "Prepare schema
    // work" fresh on any page this hydration missed, same as before.
    return () => { cancelled = true }
  }, [queuedPaths, effectiveOpenPath, isHomeOpen, homepageEntry, clientId, preparedWorkByPath])

  // toggleQueued(path) -- Phase 5 (2026-09): still an immediate, optimistic
  // local toggle (an AM's click must never feel gated on a network round
  // trip), but now also persists the change durably via POST
  // /api/clients/[id]/schema/page-work/queue. On a genuine failure (the
  // fetch() call itself failing, or the server returning a real HTTP
  // error), the optimistic toggle is REVERTED and the failure is surfaced
  // per-path via queuePersistErrors -- an AM must never be left believing a
  // queue change survived a refresh when the server never actually saved
  // it (Section 15's "never claim Queued/Analyzed/Saved if the write
  // failed," applied here to the queue action specifically).
  async function toggleQueued(path) {
    const wasQueued = queuedPaths.has(path)
    setQueuedPaths(prev => toggleQueuedPath(prev, path))
    setQueuePersistErrors(prev => {
      if (!prev.has(path)) return prev
      const next = new Map(prev)
      next.delete(path)
      return next
    })
    // PHASE 6 (2026-09-04), SELECTION MODEL: unqueuing a page must prune it
    // from the batch-selection Set immediately -- a page an AM just
    // removed from schema work must never remain a silent target of the
    // next "Analyze Selected"/"Prepare Selected" click. This fires on the
    // optimistic toggle itself (not gated on the persist call below)
    // because selection is ephemeral, never-persisted UI state to begin
    // with -- it has no "revert on failure" story of its own, and if the
    // unqueue itself is later reverted (a failed save), the page simply
    // goes back to being an ordinary queued-but-unselected row, which an
    // AM can reselect in one click.
    if (wasQueued) {
      setSelectedPaths(prev => {
        if (!prev.has(path)) return prev
        const next = new Set(prev)
        next.delete(path)
        return next
      })
    }
    const dossier = all.find(d => d.path === path)
    try {
      const res = await fetch(`/api/clients/${clientId}/schema/page-work/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path,
          queued: !wasQueued,
          page: dossier ? { type: dossier.type } : undefined
        })
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        setQueuedPaths(prev => toggleQueuedPath(prev, path)) // revert
        setQueuePersistErrors(prev => new Map(prev).set(path, body?.error || `Request failed (HTTP ${res.status}).`))
      }
    } catch (e) {
      setQueuedPaths(prev => toggleQueuedPath(prev, path)) // revert
      setQueuePersistErrors(prev => new Map(prev).set(path, 'Could not reach the server to save this queue change.'))
    }
  }

  // analyzePageNow(path) -- PRODUCT DECISION #6/#8's real QUEUED PAGE ->
  // OPEN/ANALYZE PAGE -> FETCH THAT PAGE -> RUN PAGE-TYPE-APPROPRIATE
  // SCHEMA ANALYSIS transition. Calls the analyze-page route (server-side,
  // since the browser can't fetch an arbitrary client site directly) for
  // exactly the one page an AM asked about -- never the whole sitemap, and
  // never automatically. A page's own classification metadata (type,
  // source, confidence) travels along so the route can run the correct
  // page-type check list without re-walking the sitemap to re-derive it.
  // analyzeOnePage(path) -- PHASE 6 (2026-09-04): the actual analyze-page
  // network call plus every state update a completed diagnosis always
  // needs (pageAnalyses, auto-expand, the non-fatal persistence warning,
  // and analysisRequestErrors on failure). Extracted from the old
  // analyzePageNow so BOTH the single-page "Analyze page" button and the
  // new batch "Analyze Selected" action share one code path -- deliberately
  // does NOT touch `analyzingPaths` itself, since the two callers below
  // manage that Set differently (one path at a time vs. the whole batch up
  // front). NEVER throws -- matches this codebase's established
  // "external-call wrapper always returns a result object" convention
  // (lib/pageAnalysis.js, lib/checkers/ahrefs.js, lib/llm/anthropic.js) --
  // this is what lets runWithBoundedConcurrency's own try/catch stay purely
  // defensive rather than load-bearing.
  async function analyzeOnePage(path) {
    const dossier = all.find(d => d.path === path)
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
        const message = body?.error || `Request failed (HTTP ${res.status}).`
        setAnalysisRequestErrors(prev => new Map(prev).set(path, message))
        return { path, ok: false, error: message }
      }
      setPageAnalyses(prev => new Map(prev).set(path, body))
      // Auto-expand the result the moment a fresh analysis completes -- an
      // AM who just clicked "Analyze page" should see the real diagnostic
      // output immediately, not have to click a second "View analysis"
      // button to see what they just asked for.
      setExpandedAnalysisPaths(prev => new Set(prev).add(path))
      // Phase 5 (2026-09): the diagnosis above is always real and correct
      // regardless of whether it was saved durably (see analyze-page/route.js's
      // own non-fatal persistence handling) -- a save failure is surfaced as
      // a NON-BLOCKING warning, never substituted for the real result and
      // never treated as an analysisRequestErrors-style failure.
      setAnalysisPersistWarnings(prev => {
        const next = new Map(prev)
        if (body.persistence && body.persistence.ok === false) next.set(path, 'Diagnosis succeeded but could not be saved -- it may not persist after a refresh.')
        else next.delete(path)
        return next
      })
      return { path, ok: true, analysis: body }
    } catch (e) {
      const message = 'Could not reach the server to analyze this page.'
      setAnalysisRequestErrors(prev => new Map(prev).set(path, message))
      return { path, ok: false, error: message }
    }
  }

  async function analyzePageNow(path) {
    if (analyzingPaths.has(path)) return // already in flight -- never double-fire on a fast double-click
    setAnalyzingPaths(prev => new Set(prev).add(path))
    try {
      await analyzeOnePage(path)
    } finally {
      setAnalyzingPaths(prev => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
    }
  }

  // isSelectablePath(path) -- Section 3's SELECTION MODEL: a page can only
  // be selected for a batch action while it's actually queued (selecting a
  // page an AM hasn't chosen for schema work at all would be a silent way
  // to queue-and-act in one step, which is not what Select/Analyze Selected
  // means), and never the homepage (which is analyzed via the existing
  // audit pipeline, not this page-by-page flow -- see PageRow's own
  // "Already analyzed" handling for the same rule).
  function isSelectablePath(path) {
    return queuedPaths.has(path) && !(homepageEntry && path === homepageEntry.path)
  }

  function toggleSelected(path) {
    setSelectedPaths(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function selectAllEligible() {
    setSelectedPaths(new Set(queuedDossiers.filter(d => isSelectablePath(d.path)).map(d => d.path)))
  }

  function clearSelection() {
    setSelectedPaths(new Set())
  }

  // analyzeSelected() -- Section 2's BATCH ANALYSIS: runs analyzeOnePage
  // for every selected, selectable, not-already-in-flight page, bounded by
  // BATCH_CONCURRENCY via the same pure runWithBoundedConcurrency utility
  // the tests in lib/schemaBatchAnalysis.test.js cover. Every selected page
  // is marked "Analyzing…" up front (one setState call, so the UI reflects
  // the whole batch instantly rather than one row at a time), then cleared
  // individually as each one actually finishes -- a slow page never makes
  // a fast one's completed result sit hidden behind a stale spinner.
  // Per Section 11: one page's failure is captured in the summary below,
  // never allowed to stop or hide the others' real results.
  async function analyzeSelected() {
    if (isBatchAnalyzing) return
    const targets = Array.from(selectedPaths).filter(p => isSelectablePath(p) && !analyzingPaths.has(p))
    if (targets.length === 0) return
    setIsBatchAnalyzing(true)
    setBatchAnalysisSummary(null)
    setAnalyzingPaths(prev => {
      const next = new Set(prev)
      targets.forEach(p => next.add(p))
      return next
    })
    try {
      const results = await runWithBoundedConcurrency(targets, async (path) => {
        const result = await analyzeOnePage(path)
        setAnalyzingPaths(prev => {
          const next = new Set(prev)
          next.delete(path)
          return next
        })
        return result
      }, BATCH_CONCURRENCY)
      const succeeded = results.filter(r => r.status === 'fulfilled' && r.value?.ok)
      const failedPaths = results
        .filter(r => !(r.status === 'fulfilled' && r.value?.ok))
        .map(r => (r.status === 'fulfilled' ? r.value?.path : r.item))
      setBatchAnalysisSummary({ total: targets.length, succeeded: succeeded.length, failedPaths })
    } finally {
      setIsBatchAnalyzing(false)
    }
  }

  // clearPreparedWorkError(path) -- shared by every action below so a
  // stale error from a previous attempt never lingers next to a
  // successful retry's result.
  function clearPreparedWorkError(path) {
    setPreparedWorkErrors(prev => {
      if (!prev.has(path)) return prev
      const next = new Map(prev)
      next.delete(path)
      return next
    })
  }

  // refreshPreparedWork(path) -- the GET branch of the prepare-work route:
  // read-only, no live fetch, no re-qualification. Called after every
  // approve/reject/edit_then_approve/prepare_edited_version action (which
  // themselves go through the SHARED lifecycle route, not this one) so the
  // AM Review card reflects the durable state those actions just wrote.
  async function refreshPreparedWork(path) {
    const res = await fetch(`/api/clients/${clientId}/schema/prepare-work?path=${encodeURIComponent(path)}`)
    const body = await res.json().catch(() => null)
    if (!res.ok || !body) return false
    setPreparedWorkByPath(prev => new Map(prev).set(path, { opportunity: body.opportunity, preparedWork: body.preparedWork || [] }))
    return true
  }

  // prepareSchemaWorkNow(path) -- the AM's explicit "Prepare Schema Work"
  // click (instruction #5's CTA). Runs the full ANALYZE -> QUALIFY ->
  // PREPARE -> SUBMIT-FOR-APPROVAL flow server-side (see
  // app/api/clients/[id]/schema/prepare-work/route.js) -- never fires
  // automatically, and never on a page that hasn't already been diagnosed
  // as eligible in this UI (see PreparedWorkPanel's own eligibility gate
  // below; the route re-checks eligibility authoritatively regardless).
  // Returns { ok: true } on success or { ok: false, error } on any
  // failure -- added in Phase 6 (2026-09-04) purely so prepareSelected()
  // below can build an accurate "prepared N of M" summary without having
  // to re-read the preparedWorkErrors Map's own (potentially stale) React
  // closure. The single "Prepare schema work" button ignores this return
  // value entirely, so this is a strictly additive change to an existing
  // function's contract, not a behavior change for its existing caller.
  async function prepareSchemaWorkNow(path) {
    if (preparingPaths.has(path)) return { ok: false, error: 'Already in progress.' }
    const dossier = all.find(d => d.path === path)
    setPreparingPaths(prev => new Set(prev).add(path))
    clearPreparedWorkError(path)
    const donePreparingPath = () => setPreparingPaths(prev => {
      const next = new Set(prev)
      next.delete(path)
      return next
    })

    // Step 1: the actual network call. ONLY a failure HERE -- fetch()
    // itself never resolving to a response at all (offline, DNS failure,
    // CORS, the app genuinely unreachable) -- is a real "could not reach
    // the server" condition. See app/api/clients/[id]/schema/prepare-work/
    // route.js's logAndClassify() for why every other failure mode (a
    // real 4xx/5xx, or a response whose body isn't valid JSON because the
    // server threw before returning one) must never be reported this way.
    let res
    try {
      res = await fetch(`/api/clients/${clientId}/schema/prepare-work`, {
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
    } catch (e) {
      const message = 'Could not reach the server to prepare schema work.'
      setPreparedWorkErrors(prev => new Map(prev).set(path, message))
      donePreparingPath()
      return { ok: false, error: message }
    }

    // Step 2: the server responded with a real HTTP status -- parse its
    // body separately. If THIS throws, the server was reached and ran,
    // but crashed before returning valid JSON (an uncaught exception) --
    // that is a server error, not a connectivity problem, and must be
    // reported as such rather than falling into the network-error message.
    let body
    try {
      body = await res.json()
    } catch (e) {
      const message = `The server returned an unexpected response (HTTP ${res.status}) while preparing schema work. This is a server error, not a connectivity problem -- please try again, and report this if it keeps happening.`
      setPreparedWorkErrors(prev => new Map(prev).set(path, message))
      donePreparingPath()
      return { ok: false, error: message }
    }

    if (!res.ok) {
      const message = body?.error || `Request failed (HTTP ${res.status}).`
      setPreparedWorkErrors(prev => new Map(prev).set(path, message))
      donePreparingPath()
      return { ok: false, error: message }
    }
    setPreparedWorkByPath(prev => new Map(prev).set(path, { opportunity: body.opportunity, preparedWork: body.preparedWork || [] }))
    // The route re-diagnosed this page live to establish eligibility --
    // fold that fresh diagnosis back into pageAnalyses so the "What's
    // missing" view never shows a diagnosis older than the prepared
    // work it's sitting next to.
    if (body.analysis) setPageAnalyses(prev => new Map(prev).set(path, body.analysis))
    donePreparingPath()
    return { ok: true }
  }

  // isEligibleForPrepare(path) -- the SAME eligibility gate PreparedWorkPanel
  // already applies (isEligibleForPreparedWorkDisplay) plus "doesn't already
  // have prepared work on file" -- prepareSelected() must never re-prepare a
  // page that already has a pending/approved/rejected opportunity sitting
  // next to it (an AM who wants a NEW version for an already-prepared page
  // uses that page's own "Edit before approving" flow, not a bulk action).
  function isEligibleForPrepare(path) {
    const analysis = pageAnalyses.get(path)
    return isEligibleForPreparedWorkDisplay(analysis) && !preparedWorkByPath.get(path)?.opportunity
  }

  // prepareSelected() -- Section 6's "Prepare Selected" bulk action: loops
  // the EXISTING prepareSchemaWorkNow(path) per selected+eligible page with
  // bounded concurrency, exactly per this phase's guardrails -- never
  // combines multiple pages into one opportunity (each call creates its own,
  // independent opportunity via the existing route), and never auto-approves
  // anything (this only ever reaches the 'pending AM review' state; approval
  // stays a separate, explicit per-page click).
  async function prepareSelected() {
    if (isBatchPreparing) return
    const targets = Array.from(selectedPaths).filter(p => (
      isSelectablePath(p) && isEligibleForPrepare(p) && !preparingPaths.has(p)
    ))
    if (targets.length === 0) return
    setIsBatchPreparing(true)
    setBatchPrepareSummary(null)
    try {
      const results = await runWithBoundedConcurrency(targets, async (path) => {
        const result = await prepareSchemaWorkNow(path)
        if (!result?.ok) throw new Error(result?.error || 'Could not prepare schema work.')
        return path
      }, BATCH_CONCURRENCY)
      const succeeded = results.filter(r => r.status === 'fulfilled')
      const failedPaths = results.filter(r => r.status === 'rejected').map(r => r.item)
      setBatchPrepareSummary({ total: targets.length, succeeded: succeeded.length, failedPaths })
    } finally {
      setIsBatchPreparing(false)
    }
  }

  // runOpportunityLifecycleAction(path, opportunityId, action, extra) --
  // every APPROVE / EDIT THEN APPROVE / REJECT / prepared-edited-version
  // control goes through the EXISTING SHARED lifecycle route
  // (app/api/clients/[id]/opportunities/[opportunityId]/lifecycle/
  // route.js) -- the same dispatcher SourceCitationWizard.js already
  // uses, never a schema-specific approval endpoint. Always refreshes via
  // the read-only GET afterward rather than trusting the lifecycle
  // response's own shape (which varies per action).
  async function runOpportunityLifecycleAction(path, opportunityId, action, extra = {}) {
    setLifecycleBusyPaths(prev => new Set(prev).add(path))
    clearPreparedWorkError(path)
    try {
      const res = await fetch(`/api/clients/${clientId}/opportunities/${opportunityId}/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra })
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        setPreparedWorkErrors(prev => new Map(prev).set(path, body?.error || `Request failed (HTTP ${res.status}).`))
        return
      }
      await refreshPreparedWork(path)
      if (action === 'prepare_edited_version') {
        setEditingDrafts(prev => {
          if (!prev.has(path)) return prev
          const next = new Map(prev)
          next.delete(path)
          return next
        })
      }
    } catch (e) {
      setPreparedWorkErrors(prev => new Map(prev).set(path, 'Could not reach the server.'))
    } finally {
      setLifecycleBusyPaths(prev => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
    }
  }

  function startEditingPreparedWork(path, latestPayload) {
    setEditingDrafts(prev => new Map(prev).set(path, JSON.stringify({ add: latestPayload?.add || [], modify: latestPayload?.modify || [] }, null, 2)))
  }

  function cancelEditingPreparedWork(path) {
    setEditingDrafts(prev => {
      const next = new Map(prev)
      next.delete(path)
      return next
    })
  }

  // saveEditedPreparedWork -- instruction #6 (EDIT THEN APPROVE): creates a
  // NEW prepared-work version via the shared lifecycle's
  // 'prepare_edited_version' action (never overwrites the original). The
  // edited add/modify replace the latest version's; everything else
  // (keep/canonicalEntity/currentSchema/unresolvedDependencies) is carried
  // over unchanged, since the AM is editing the proposed JSON-LD, not
  // re-diagnosing the page.
  function saveEditedPreparedWork(path, opportunityId, latest) {
    const draft = editingDrafts.get(path)
    let parsed
    try {
      parsed = JSON.parse(draft)
    } catch (e) {
      setPreparedWorkErrors(prev => new Map(prev).set(path, `Edited JSON-LD is not valid JSON: ${e.message}`))
      return
    }
    const payload = { ...latest.payload, add: Array.isArray(parsed.add) ? parsed.add : latest.payload.add, modify: Array.isArray(parsed.modify) ? parsed.modify : latest.payload.modify }
    runOpportunityLifecycleAction(path, opportunityId, 'prepare_edited_version', {
      artifactType: 'schema_jsonld',
      payload,
      previousVersionId: latest.id,
      evidenceContext: [{ text: 'Edited by AM before approval.', source: 'am_edit' }]
    })
  }

  // approvePreparedWork -- dispatches to 'edit_then_approve' when the
  // latest version is the AM's own edited version (created_by: 'am'),
  // and plain 'approve' otherwise (a system-generated version an AM is
  // approving as-is). Both take the SAME preparedWorkId; the only
  // difference is which history event lib/opportunityLifecycle.js logs
  // (edited_then_approved vs approved) -- see that file and the shared
  // lifecycle route's own comments on why this distinction matters.
  function approvePreparedWork(path, opportunityId, latest) {
    const action = latest.created_by === 'am' ? 'edit_then_approve' : 'approve'
    runOpportunityLifecycleAction(path, opportunityId, action, { preparedWorkId: latest.id })
  }

  function rejectPreparedWork(path, opportunityId) {
    runOpportunityLifecycleAction(path, opportunityId, 'reject', { reason: 'am_rejected' })
  }

  function toggleAnalysisExpanded(path) {
    setExpandedAnalysisPaths(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
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
              isAnalyzing: analyzingPaths.has(dossier.path),
              queueError: queuePersistErrors.get(dossier.path) || null
            })
            return (
              <div>
                <div className="card" style={{ padding: 18, marginBottom: 14 }}>
                  <div className="grade-title" style={{ marginBottom: 2 }}>Not every page needs the same schema</div>
                  <div className="grade-sub" style={{ marginBottom: 10 }}>
                    Pages below are real page URLs discovered from this client&rsquo;s sitemap hierarchy (child sitemaps are followed automatically when the root sitemap is an index -- sitemap XML files themselves never appear here). Recommended pages are the ones most likely worth schema work first, based on page type and (where available) this client&rsquo;s AM-confirmed primary/secondary services and geography -- hover a page&rsquo;s type badge to see exactly why it landed where it did. Only the homepage is actually run through the Schema &amp; Structure checker&rsquo;s 7 checks today; every other page is honestly marked &ldquo;Not analyzed yet&rdquo; rather than a guessed result.
                  </div>
                  <div className="text-tiny text-muted">
                    {queuedPaths.size} page{queuedPaths.size === 1 ? '' : 's'} queued for schema work &mdash; saved durably, so this survives a refresh.
                  </div>
                </div>

                <div className="card" style={{ padding: 18, marginBottom: 14 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Next {RECOMMENDATION_BATCH_SIZE} recommended pages ({recommended.length})</div>
                  <p className="text-tiny text-muted" style={{ margin: '0 0 8px' }}>
                    A rolling batch, not a fixed top {RECOMMENDATION_BATCH_SIZE} -- once a page here needs no more action, the next-best eligible page from the full discovered universe takes its place. Checking a box below adds a page to the Schema work queue; it does not analyze or queue it on its own.
                  </p>
                  {recommended.length === 0 && (
                    <p className="text-tiny text-muted" style={{ margin: '0 0 8px' }}>No pages currently meet the bar for recommendation -- every discovered page is either resolved or already queued.</p>
                  )}
                  <div style={{ display: 'grid', gap: 6 }}>
                    {recommended.map(dossier => <PageRow {...rowProps(dossier)} showRecommendedBadge={false} />)}
                  </div>
                </div>

                {queuedDossiers.length > 0 && (() => {
                  const selectableCount = queuedDossiers.filter(d => isSelectablePath(d.path)).length
                  const selectedSelectableCount = Array.from(selectedPaths).filter(isSelectablePath).length
                  const analyzeTargetCount = Array.from(selectedPaths).filter(p => isSelectablePath(p) && !analyzingPaths.has(p)).length
                  const prepareTargetCount = Array.from(selectedPaths).filter(p => isSelectablePath(p) && isEligibleForPrepare(p) && !preparingPaths.has(p)).length
                  return (
                    <div className="card" style={{ padding: 18, marginBottom: 14 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Schema work queue ({queuedDossiers.length})</div>
                      <p className="text-tiny text-muted" style={{ margin: '0 0 8px' }}>
                        Pages an AM has intentionally chosen for schema work -- separate from Recommended (the system&rsquo;s suggestion) and from Open (whichever page is currently shown below). Queuing a page doesn&rsquo;t analyze it by itself; click Analyze page to actually fetch it and run its real checks.
                      </p>
                      {/* PHASE 6 (2026-09-04) -- BATCH ANALYSIS / SELECTION MODEL: the
                          checkboxes below select pages for the two bulk actions here.
                          Selection is temporary, client-side-only state -- it is never
                          saved, and is pruned automatically the moment a page is
                          removed from the queue (see toggleQueued). Selecting a page
                          never analyzes or prepares it by itself -- only these two
                          explicit buttons do. */}
                      <p className="text-tiny text-muted" style={{ margin: '0 0 10px' }}>
                        Select pages below to Analyze or Prepare several at once -- selection is temporary and clears if a page leaves the queue.
                      </p>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
                        <button className="btn btn-secondary" onClick={selectAllEligible} disabled={selectableCount === 0}>
                          Select all eligible ({selectableCount})
                        </button>
                        <button className="btn btn-secondary" onClick={clearSelection} disabled={selectedPaths.size === 0}>
                          Clear selection
                        </button>
                        <button className="btn btn-primary" disabled={isBatchAnalyzing || analyzeTargetCount === 0} onClick={analyzeSelected}>
                          {isBatchAnalyzing ? 'Analyzing selected…' : `Analyze selected (${selectedSelectableCount})`}
                        </button>
                        <button className="btn btn-secondary" disabled={isBatchPreparing || prepareTargetCount === 0} onClick={prepareSelected}>
                          {isBatchPreparing ? 'Preparing selected…' : `Prepare selected (${selectedSelectableCount})`}
                        </button>
                      </div>
                      {/* Partial-success summaries (Section 11) -- deliberately never
                          replace or hide any individual row's own status/error above;
                          this is just the one aggregate line an AM needs after a batch
                          run without inspecting every row. */}
                      {batchAnalysisSummary && (
                        <p className="text-tiny text-muted" style={{ margin: '0 0 8px' }}>
                          Analyzed {batchAnalysisSummary.succeeded} of {batchAnalysisSummary.total} page{batchAnalysisSummary.total === 1 ? '' : 's'}.
                          {batchAnalysisSummary.failedPaths.length > 0 && ` ${batchAnalysisSummary.failedPaths.length} page${batchAnalysisSummary.failedPaths.length === 1 ? '' : 's'} could not be analyzed: ${batchAnalysisSummary.failedPaths.join(', ')}.`}
                        </p>
                      )}
                      {batchPrepareSummary && (
                        <p className="text-tiny text-muted" style={{ margin: '0 0 8px' }}>
                          Prepared {batchPrepareSummary.succeeded} of {batchPrepareSummary.total} page{batchPrepareSummary.total === 1 ? '' : 's'}.
                          {batchPrepareSummary.failedPaths.length > 0 && ` ${batchPrepareSummary.failedPaths.length} page${batchPrepareSummary.failedPaths.length === 1 ? '' : 's'} could not be prepared: ${batchPrepareSummary.failedPaths.join(', ')}.`}
                        </p>
                      )}
                      <div style={{ display: 'grid', gap: 6 }}>
                        {queuedDossiers.map(dossier => {
                          const state = getPageState(pageStates, dossier.path)
                          const isAnalyzing = analyzingPaths.has(dossier.path)
                          const reqError = analysisRequestErrors.get(dossier.path)
                          const persistWarning = analysisPersistWarnings.get(dossier.path)
                          const queueError = queuePersistErrors.get(dossier.path)
                          const analysis = pageAnalyses.get(dossier.path)
                          const isExpanded = expandedAnalysisPaths.has(dossier.path)
                          const selectable = isSelectablePath(dossier.path)
                          const prepared = preparedWorkByPath.get(dossier.path)
                          const approval = prepared?.opportunity?.approval_status
                          return (
                            <div key={dossier.path} className="card" style={{ padding: 10 }}>
                              <div className="page-row" style={{ display: 'grid', gridTemplateColumns: 'auto auto 1fr auto auto auto', alignItems: 'center', gap: 10 }}>
                                <input
                                  type="checkbox"
                                  checked={selectedPaths.has(dossier.path)}
                                  disabled={!selectable}
                                  onChange={() => toggleSelected(dossier.path)}
                                  aria-label={selectedPaths.has(dossier.path) ? `Deselect ${dossier.path}` : `Select ${dossier.path} for batch actions`}
                                  title={selectable ? 'Select for batch Analyze/Prepare' : 'The homepage is analyzed via the audit, not this flow'}
                                />
                                <span className="type-badge" style={{ cursor: 'default' }}>{dossier.type}</span>
                                <span className="path" onClick={() => setOpenPath(dossier.path)} style={{ cursor: 'pointer', textDecoration: dossier.path === effectiveOpenPath ? 'underline' : 'none' }}>
                                  {dossier.path}
                                </span>
                                <span className={`status ${isAnalyzing ? 'caution' : PAGE_STATE_TONE[state] || 'muted'}`}>
                                  {isAnalyzing ? 'Analyzing…' : (reqError || PAGE_STATE_LABELS[state] || 'Not analyzed yet')}
                                </span>
                                {analysis && (
                                  <button className="btn btn-secondary" onClick={() => toggleAnalysisExpanded(dossier.path)}>
                                    {isExpanded ? 'Hide analysis' : 'View analysis'}
                                  </button>
                                )}
                                <button className="btn btn-secondary" disabled={isAnalyzing || dossier.type === 'Home'} onClick={() => analyzePageNow(dossier.path)}>
                                  {dossier.type === 'Home' ? 'Already analyzed' : (state === 'UNANALYZED' ? 'Analyze page' : 'Re-analyze page')}
                                </button>
                              </div>
                              {/* STATUS MODEL (Section 8) -- the approval/prepared-work
                                  status is a SEPARATE fact from the diagnosis status above
                                  (ACTIONABLE_GAP/NO_ACTION_NEEDED/etc.), shown as its own
                                  badge rather than folded into or overwriting it, so an AM
                                  can tell "what did the diagnosis find" apart from "what's
                                  happened to the prepared fix for it" at a glance. */}
                              {approval && APPROVAL_STATUS_COPY[approval] && (
                                <div style={{ margin: '6px 0 0 24px' }}>
                                  <span className={`issue-badge ${APPROVAL_STATUS_COPY[approval].tone}`}>
                                    {APPROVAL_STATUS_COPY[approval].label}
                                  </span>
                                </div>
                              )}
                              {queueError && <p className="text-small issue-why" style={{ margin: '6px 0 0' }}>Could not save this queue change: {queueError}</p>}
                              {persistWarning && <p className="text-small issue-why" style={{ margin: '6px 0 0' }}>{persistWarning}</p>}
                              {isExpanded && analysis && (
                                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                                  <PageAnalysisResult analysis={analysis} />
                                  {/* MULTI-PAGE REVIEW (Section 4/7) -- the SAME
                                      PreparedWorkPanel Step 3 uses for the single open
                                      page, reused here per queued+expanded page so an AM
                                      can review/approve/edit/reject prepared schema work
                                      for several pages without opening each one
                                      individually. Zero new review UI was built -- this
                                      is entirely the existing component and handlers,
                                      parameterized by this row's own path instead of
                                      effectiveOpenPath. */}
                                  <PreparedWorkPanel
                                    path={dossier.path}
                                    analysis={analysis}
                                    prepared={prepared}
                                    isPreparing={preparingPaths.has(dossier.path)}
                                    isBusy={lifecycleBusyPaths.has(dossier.path)}
                                    error={preparedWorkErrors.get(dossier.path)}
                                    editingDraft={editingDrafts.get(dossier.path)}
                                    onPrepare={() => prepareSchemaWorkNow(dossier.path)}
                                    onApprove={(latest) => approvePreparedWork(dossier.path, prepared?.opportunity?.id, latest)}
                                    onStartEdit={(payload) => startEditingPreparedWork(dossier.path, payload)}
                                    onCancelEdit={() => cancelEditingPreparedWork(dossier.path)}
                                    onDraftChange={(text) => setEditingDrafts(prev => new Map(prev).set(dossier.path, text))}
                                    onSaveEdit={(latest) => saveEditedPreparedWork(dossier.path, prepared?.opportunity?.id, latest)}
                                    onReject={() => rejectPreparedWork(dossier.path, prepared?.opportunity?.id)}
                                  />
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })()}

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
                      const persistWarning = analysisPersistWarnings.get(openDossier.path)
                      return (
                        <>
                          <p className="text-tiny text-muted" style={{ margin: '0 0 10px' }}>
                            {state === 'UNANALYZED' && !isAnalyzing && 'Not analyzed yet -- click Analyze page to fetch this page and run its real, page-type-appropriate schema checks (never the homepage’s 7 checks).'}
                            {isAnalyzing && 'Fetching this page and running its schema checks now…'}
                            {state === 'ACTIONABLE_GAP' && 'A real schema gap was found on this page -- see “See schema gaps” below.'}
                            {state === 'NO_ACTION_NEEDED' && 'Analyzed -- no actionable schema gap found on this page.'}
                            {reqError && ` (${reqError})`}
                          </p>
                          {persistWarning && <p className="text-small issue-why" style={{ margin: '0 0 10px' }}>{persistWarning}</p>}
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
                    {queuePersistErrors.get(openDossier.path) && (
                      <p className="text-small issue-why" style={{ margin: '6px 0 0' }}>Could not save this queue change: {queuePersistErrors.get(openDossier.path)}</p>
                    )}
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
            if (!analysis) {
              return (
                <div className="card-empty" style={{ padding: 18 }}>
                  <div className="text-small text-muted">This page hasn&rsquo;t been analyzed yet -- go back and click Analyze page.</div>
                </div>
              )
            }
            return (
              <div className="card" style={{ padding: 18 }}>
                <div className="grade-title" style={{ marginBottom: 10 }}>
                  {analysis.path}{analysis.fetchState !== 'success' && ' — could not be analyzed'}
                </div>
                <PageAnalysisResult analysis={analysis} />
                <PreparedWorkPanel
                  path={effectiveOpenPath}
                  analysis={analysis}
                  prepared={preparedWorkByPath.get(effectiveOpenPath)}
                  isPreparing={preparingPaths.has(effectiveOpenPath)}
                  isBusy={lifecycleBusyPaths.has(effectiveOpenPath)}
                  error={preparedWorkErrors.get(effectiveOpenPath)}
                  editingDraft={editingDrafts.get(effectiveOpenPath)}
                  onPrepare={() => prepareSchemaWorkNow(effectiveOpenPath)}
                  onApprove={(latest) => approvePreparedWork(effectiveOpenPath, preparedWorkByPath.get(effectiveOpenPath)?.opportunity?.id, latest)}
                  onStartEdit={(payload) => startEditingPreparedWork(effectiveOpenPath, payload)}
                  onCancelEdit={() => cancelEditingPreparedWork(effectiveOpenPath)}
                  onDraftChange={(text) => setEditingDrafts(prev => new Map(prev).set(effectiveOpenPath, text))}
                  onSaveEdit={(latest) => saveEditedPreparedWork(effectiveOpenPath, preparedWorkByPath.get(effectiveOpenPath)?.opportunity?.id, latest)}
                  onReject={() => rejectPreparedWork(effectiveOpenPath, preparedWorkByPath.get(effectiveOpenPath)?.opportunity?.id)}
                />
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
            {isHomeOpen && (
              <button className="btn btn-primary" onClick={() => setStep(4)}>Fix with the generator &rarr;</button>
            )}
            {/* PRODUCT DECISION #10 originally left a disabled "Prepared
                schema work -- not built yet" button here for non-homepage
                pages. That phase is now built: the PreparedWorkPanel
                rendered above (Phase 6, 2026-09-03) already owns the
                entire Prepare/Approve/Edit/Reject flow for this page, so
                this footer intentionally shows no second, competing
                Prepare Schema Work control -- see Section 18 of the
                2026-09 persistence/integration debugging pass. */}
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
