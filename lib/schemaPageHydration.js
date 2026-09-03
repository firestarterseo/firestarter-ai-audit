// SCHEMA PAGE HYDRATION -- Phase 5 of the 2026-09 Schema persistence pass.
// Pure, network-free, zero dependencies (same discipline as
// lib/schemaPageSelection.js / lib/schemaPagePriority.js) -- the merge
// logic for SchemaWizard.js's hydration effect (Section 9/10 of the Phase
// 5 spec) lives here instead of inline in the component so it stays
// unit-testable with plain `node` fixtures. This codebase deliberately has
// no DOM/React test harness (see lib/schemaPageSelection.js's own header
// for the same reasoning) -- every other piece of "component logic" that
// needs real test coverage gets pulled out into a pure lib/ module exactly
// like this one.
//
// WHAT THIS DOES: takes the durable rows the GET
// /api/clients/[id]/schema/page-work endpoint returns (already camelCased,
// keyed by normalizedPath) and the client's CURRENT candidate-page list
// (raw, un-normalized path strings, exactly as SchemaWizard.js's
// candidatePages already has them), and produces the merged queuedPaths
// Set / pageAnalyses Map SchemaWizard.js should seed its React state with
// on mount -- matched via lib/schemaPageIdentity.js's
// normalizeSchemaPagePath(), the SAME single normalization rule the server
// used to write these rows in the first place. No second normalization
// rule is invented here.
//
// NEVER WIPES SESSION STATE (Section 9's "never wipe durable state when
// sitemap/recommendation calculation runs" cuts both ways): both merge
// functions UNION durable state into whatever the caller already has --
// an AM's own in-session queue/analysis actions this run are never
// overwritten by a hydration fetch that resolves late, and a hydration
// merge never clears anything the caller already had.
//
// This module never touches lib/schemaPageLifecycle.js or
// lib/schemaPagePriority.js -- SchemaWizard.js's `pageStates` is already a
// useMemo purely derived from `pageAnalyses` (see that file), so seeding
// pageAnalyses here is sufficient to make recommendation
// exclusion/eligibility correctly reflect durable state with zero changes
// to either pure lib file (Section 11's explicit requirement).

const { normalizeSchemaPagePath } = require('./schemaPageIdentity')

// mergeDurableQueuedPaths(queuedPaths, durableRows, candidatePaths) -> new Set
// Adds every candidate path whose normalized identity matches a durable
// row with queueStatus 'queued' -- never removes anything already in
// `queuedPaths` (a durable 'not_queued' row is not itself a signal to
// un-queue a page the AM already queued this session; removal only ever
// happens through the AM's own explicit toggleQueued action).
function mergeDurableQueuedPaths(queuedPaths, durableRows, candidatePaths) {
  const next = new Set(queuedPaths)
  const queuedNormalized = new Set(
    (durableRows || []).filter(r => r.queueStatus === 'queued').map(r => r.normalizedPath)
  )
  for (const path of candidatePaths || []) {
    if (queuedNormalized.has(normalizeSchemaPagePath(path))) next.add(path)
  }
  return next
}

// mergeDurableAnalyses(pageAnalyses, durableRows, candidatePaths) -> new Map
// Seeds an entry (the durable row's latestAnalysis, verbatim -- the exact
// shape lib/pageAnalysis.js#analyzePage() already returns, so it needs no
// translation to be usable by every existing pageAnalyses consumer) for
// every candidate path whose normalized identity matches an analyzed
// durable row -- but ONLY when the caller's map has no entry for that path
// yet, so a hydration fetch that resolves after an AM has already
// re-analyzed a page in this session can never overwrite the fresher
// in-session result with stale durable data.
function mergeDurableAnalyses(pageAnalyses, durableRows, candidatePaths) {
  const next = new Map(pageAnalyses)
  const byNormalized = new Map((durableRows || []).map(r => [r.normalizedPath, r]))
  for (const path of candidatePaths || []) {
    if (next.has(path)) continue
    const row = byNormalized.get(normalizeSchemaPagePath(path))
    if (row && row.analysisStatus === 'analyzed' && row.latestAnalysis) {
      next.set(path, row.latestAnalysis)
    }
  }
  return next
}

// durableOpportunityIdForPath(durableRows, path) -> string | null
// A small lookup SchemaWizard.js can use to know a page's linked
// opportunity (e.g. to show "Prepared" status) even before it has opened
// that page's own AM Review card and fetched it directly.
function durableOpportunityIdForPath(durableRows, path) {
  const normalized = normalizeSchemaPagePath(path)
  const row = (durableRows || []).find(r => r.normalizedPath === normalized)
  return row ? row.opportunityId : null
}

module.exports = { mergeDurableQueuedPaths, mergeDurableAnalyses, durableOpportunityIdForPath }
