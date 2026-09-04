// SCHEMA PAGE SELECTION -- Phase A of the Schema page-workflow redesign
// (2026-09-02). Pure, network-free, zero dependencies (same discipline as
// lib/sitemapDiscovery.js and lib/schemaPagePriority.js).
//
// WHY THIS FILE EXISTS: SchemaWizard.js's Step 2 needs two genuinely
// independent pieces of selection state -- which page is currently OPEN
// (viewed in the detail panel, one at a time, click-driven) and which pages
// are QUEUED (intentionally added to schema work, any number, checkbox-
// driven). Both existed as small inline React state updaters directly
// inside the component, which is fine for the app itself but leaves that
// logic untestable without a browser/DOM test harness -- something this
// codebase deliberately has none of (every other lib/ module is tested with
// plain `node foo.test.js`, no jsdom, no React Testing Library, no new
// devDependencies). Pulling the actual state-transition logic out into pure
// functions here means:
//   (a) it's trivially unit-testable with plain fixtures, no DOM, no React;
//   (b) SchemaWizard.js itself gets simpler -- it just calls these and
//       hands the result to useState's setter;
//   (c) the OPEN/QUEUED independence the product decisions require (see
//       SchemaWizard.js's header) is enforced by a pure function's contract,
//       not just "the component happens to use two different useState
//       calls today."
//
// CURRENT-RUN / UI-STATE-ONLY -- deliberate, not an oversight. Nothing in
// this file reads or writes Supabase, localStorage, or any other persistent
// store -- it only ever transforms a Set/string that the CALLER owns as
// React state (or, in a test, a plain local variable). Durable backlog
// persistence is an explicit later phase (Phase B/C, via the existing
// lib/opportunityLifecycle.js machinery with originating_pillar =
// 'schema_structure') -- see PRODUCT DECISIONS #1 and #2 in this project's
// Phase A spec. This module's total absence of any persistence API is
// itself the guarantee that Phase A's queue cannot accidentally become
// durable.

// toggleQueuedPath(queuedPaths, path) -> new Set
// Immutable toggle: returns a NEW Set with `path` added if it wasn't
// present, or removed if it was -- never mutates the Set passed in, so a
// caller (or a test) can hold onto the previous value and compare.
function toggleQueuedPath(queuedPaths, path) {
  const next = new Set(queuedPaths)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  return next
}

// resolveOpenPath({ openPath, recommended, candidatePages }) -> string | null
// The single source of truth for "what page is open right now," entirely
// independent of `queuedPaths` -- opening a page never queues it, and
// queuing a page never opens it. Falls back, in order, to: the explicitly
// opened path, the first Recommended page, the first candidate page at all,
// or null (only possible when there are zero candidate pages).
function resolveOpenPath({ openPath, recommended, candidatePages }) {
  if (openPath) return openPath
  if (recommended && recommended.length > 0) return recommended[0].path
  if (candidatePages && candidatePages.length > 0) return candidatePages[0].path
  return null
}

// queuedCount(queuedPaths) -> number
// Trivial, but exists so callers/tests never reach into Set internals
// directly -- keeps "how many pages are queued" a single, named concept.
function queuedCount(queuedPaths) {
  return queuedPaths ? queuedPaths.size : 0
}

// resolveActiveWorkItem({ effectiveOpenPath, homepagePath }) ->
//   { type: 'home' | 'page' | null, path: string | null }
//
// WORKFLOW CORRECTION (2026-09-04d): Step 4/5/6 of SchemaWizard.js used to
// unconditionally render the homepage/sitewide LocalBusiness generator
// (SchemaGenerator), no matter which page was actually open -- so an AM
// working /about/'s or /contact/'s Schema gap who navigated (or was
// carried, via the step tabs) into "Generate & Review" saw an unrelated
// homepage form instead of that page's own prepared-work/review UI. ROOT
// CAUSE: those steps never consulted `effectiveOpenPath`/`isHomeOpen` at
// all -- the exact same "which page is active" state every other step
// (1-3) already derives and uses.
//
// The fix is not a new workflow/persistence model -- it's naming the
// decision "is the active work item the homepage/sitewide task, or a
// specific page's task" as its own pure, testable function, built from the
// SAME `effectiveOpenPath` (see resolveOpenPath above) and the SAME real
// homepage path (`homepageEntry.path` in SchemaWizard.js, itself derived
// from the discovered/classified candidate pages, never a hardcoded '/'
// literal -- see that file's own 2026-09-02 CORRECTION comment) that Steps
// 1-3 already rely on. Steps 4-6 now call this once and dispatch on its
// `type`, so all three steps -- Generate & Review, Publish, Verify -- are
// structurally guaranteed to act on the exact same active item; there is
// no separate "which page is step 5 about" concept that could ever drift
// from "which page is step 4 about."
//
// `type: null` only when there is no active page at all (zero candidate
// pages) -- callers should show an empty/"pick a page" state, never guess.
function resolveActiveWorkItem({ effectiveOpenPath, homepagePath }) {
  if (!effectiveOpenPath) return { type: null, path: null }
  if (homepagePath && effectiveOpenPath === homepagePath) return { type: 'home', path: effectiveOpenPath }
  return { type: 'page', path: effectiveOpenPath }
}

module.exports = { toggleQueuedPath, resolveOpenPath, queuedCount, resolveActiveWorkItem }
