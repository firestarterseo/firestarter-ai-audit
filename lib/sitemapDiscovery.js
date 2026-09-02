// SITEMAP DISCOVERY -- shared sitemap-index/urlset parsing + bounded
// recursive page-URL discovery. Added 2026-09-02 to fix a real bug in the
// Schema & Structure pillar's page-selection step: child sitemap XML files
// (e.g. /post-sitemap.xml, /page-sitemap.xml) were being surfaced as if
// they were real pages to classify.
//
// ROOT CAUSE THIS FILE FIXES: lib/checkers/checker.js's old
// countSitemapPages() ran one flat regex (`/<loc>.../gi`) against the
// entire fetched sitemap.xml body, with no distinction between:
//   - a <sitemapindex> root, whose <sitemap><loc> entries are CHILD
//     SITEMAP FILES, never pages, and
//   - a <urlset> root, whose <url><loc> entries are REAL PAGES.
// A client on a sitemap index (the very common Yoast/WordPress shape --
// sitemap_index.xml -> post-sitemap.xml, page-sitemap.xml,
// case-studies-sitemap.xml, landing-page-sitemap.xml, ...) had every one of
// those child-sitemap URLs treated and displayed as if it were a page.
//
// WHY A NEW SHARED FILE, NOT A REUSE OF lib/checkers/technical-checker.js:
// Technical Foundation's checkRobotsAndSitemap() already correctly tells a
// <sitemapindex> apart from a <urlset> (see that file) and already samples
// a handful of child sitemaps -- its detection logic is correct, but it is
// (a) a private, non-exported function whose only output is human-readable
// evidence strings and an aggregate URL count, not a page-URL list; (b)
// capped at sampling 5 sub-sitemaps, which is fine for "give a representative
// total" but would silently miss real page types living in sitemaps outside
// the sample; and (c) has no nested-index recursion or cross-sitemap
// dedupe, since it never needed either for its own purpose. Reimplementing
// its detection logic here (rather than changing technical-checker.js's
// exports or behavior) keeps Technical Foundation's own scoring pillar
// completely untouched, at zero risk, while giving Schema & Structure (and
// any future caller) a real, structured, page-URL-producing primitive. A
// future cleanup could migrate technical-checker.js's own sitemap check to
// call this module too, but that is a separate, optional refactor -- not
// part of this fix, and not required by it.
//
// CONSERVATIVE, BOUNDED, ZERO-NEW-DEPENDENCIES -- same discipline as every
// other file in lib/: no XML parser library, just the same plain-regex
// approach already used throughout this codebase (see checker.js's and
// technical-checker.js's own header comments on why). Bounded on three
// independent axes so a pathological or malicious sitemap tree can never
// turn one audit run into hundreds of fetches:
//   - MAX_CHILD_SITEMAPS_PER_INDEX -- how many <sitemap> children of ONE
//     index are followed
//   - MAX_SITEMAPS_FETCHED_TOTAL   -- total sitemap XML fetches across the
//     whole recursive walk (root included), regardless of branching
//   - MAX_SITEMAP_DEPTH            -- how many levels of nested
//     <sitemapindex> are followed before giving up on that branch
// A branch that hits any of these bounds is simply not explored further --
// it is NEVER, under any circumstance, treated as if its sitemap URL were
// itself a page.

const { fetchWebPage } = require('./webPageFetch')
const { normalizeUrlIdentity } = require('./urlIdentity')

// MAX_SITEMAP_PAGES_LISTED -- cap on how many real page URLs get returned
// for display/persistence (unchanged value from the pre-fix
// lib/checkers/checker.js constant of the same name, 2026-08-17 precedent
// -- this project's sitemaps can run into the hundreds/thousands of URLs;
// persisting every single one for a step that only lists a handful is
// wasted storage for no benefit). `count` below is NOT capped by this --
// it reflects the real total distinct pages discovered (subject to the
// fetch bounds above), so the "Site-wide" stat pill still shows a real
// number even when the displayed list is trimmed.
const MAX_SITEMAP_PAGES_LISTED = 20

// Yoast (this project's most common client plugin) typically ships 4-10
// child sitemaps (post/page/case-studies/landing-page/category/tag/...) --
// these bounds comfortably cover that real-world shape in full (no
// sampling gap) while still stopping a pathological tree (a client with
// hundreds of child sitemaps, or a deeply/infinitely nested index) well
// short of turning one audit into hundreds of fetches. Reasonable
// first-pass bounds, easy to retune later -- same spirit as the
// opportunity-severity bands in technical-checker.js.
const MAX_CHILD_SITEMAPS_PER_INDEX = 10
const MAX_SITEMAPS_FETCHED_TOTAL = 12
const MAX_SITEMAP_DEPTH = 3 // root(0) -> child(1) -> grandchild(2) -> great-grandchild(3); real sites are 1 level deep, this just guards against pathological/malicious nesting.

// A conservative, well-known list of non-HTML asset extensions a sitemap
// can legitimately reference directly (some generators list PDFs, images,
// or even other feeds as top-level <url> entries) -- these are never real
// HTML pages to classify, so they're excluded from the page candidate list
// the same way a sitemap XML URL itself is. `.xml` is included here too, as
// a second, independent safety net beyond the sitemapindex/urlset
// structural distinction below (e.g. a urlset that mistakenly points at
// another XML file as a "page").
const NON_PAGE_ASSET_EXTENSION_RE = /\.(xml|pdf|jpe?g|png|gif|webp|svg|ico|bmp|tiff?|mp4|mp3|wav|mov|avi|webm|zip|rar|7z|gz|tar|docx?|xlsx?|pptx?|csv|json|txt|rss|atom)(?:[?#].*)?$/i

// detectSitemapKind(xmlText) -> 'sitemapindex' | 'urlset' | 'unknown'
function detectSitemapKind(xmlText) {
  if (typeof xmlText !== 'string') return 'unknown'
  if (/<sitemapindex[\s>]/i.test(xmlText)) return 'sitemapindex'
  if (/<urlset[\s>]/i.test(xmlText)) return 'urlset'
  return 'unknown'
}

// extractIndexChildLocs(xmlText) -> string[] of raw child-sitemap URLs.
// A <sitemapindex> document only ever contains <sitemap><loc>...</loc>
// ...</sitemap> entries -- it has no <url> blocks of its own -- so every
// literal <loc> found in an index document is a child sitemap reference,
// never a page.
function extractIndexChildLocs(xmlText) {
  return [...xmlText.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map(m => m[1])
}

// extractUrlsetPageLocs(xmlText) -> string[] of raw page URLs.
// Scoped to each <url>...</url> block individually and takes only that
// block's OWN literal <loc> -- not a document-wide match -- so an
// image/video/news sitemap extension's own nested tags (<image:loc>,
// <video:content_loc>, etc., all distinct namespaced tag names) are never
// mistaken for the page's own <loc>. This is an extra safety layer on top
// of the fact that a literal `<loc>` regex already can't match a
// differently-named tag like `<image:loc>`.
function extractUrlsetPageLocs(xmlText) {
  const blocks = [...xmlText.matchAll(/<url>([\s\S]*?)<\/url>/gi)].map(m => m[1])
  const locs = []
  for (const block of blocks) {
    const m = block.match(/<loc>\s*([^<]+?)\s*<\/loc>/i)
    if (m) locs.push(m[1])
  }
  return locs
}

// looksLikeNonPageAsset(rawUrl) -> boolean
function looksLikeNonPageAsset(rawUrl) {
  let path
  try { path = new URL(rawUrl).pathname } catch (e) { path = rawUrl }
  return NON_PAGE_ASSET_EXTENSION_RE.test(path)
}

// classifySitemapPath(path) -> page-type label.
// Cheap, real URL-pattern classification -- explicitly a fallback, not a
// certainty (see this file's header and SchemaWizard.js's own comment on
// why per-page schema SCORING beyond the homepage isn't built yet; this
// only classifies what KIND of page a URL looks like). Stronger,
// evidence-based classification (title/meta/on-page schema) would require
// fetching every candidate page's HTML, which this step deliberately does
// NOT do -- see MAX_SITEMAP_PAGES_LISTED's own comment and requirement 6 of
// the fix this file was added for ("do not fetch/classify hundreds of pages
// unnecessarily"). The one page this checker already has real HTML for
// (the homepage) doesn't need pattern-matching at all -- '/' is
// unambiguous. Order matters: more specific patterns are checked before the
// more general 'Service' pattern (e.g. "/services/case-studies/example/"
// should read as Case Study, not Service).
function classifySitemapPath(path) {
  if (path === '/' || path === '') return 'Home'
  if (/contact/i.test(path)) return 'Contact'
  if (/\babout([-_]us)?\b/i.test(path)) return 'About'
  if (/case-stud(y|ies)/i.test(path)) return 'Case Study'
  if (/\/(blog|article|articles|news|post|posts)\//i.test(path) || /\/(blog|articles|news)$/i.test(path)) return 'Article'
  if (/\/(service-areas?|locations?|areas-we-serve)\//i.test(path)) return 'Location'
  if (/\bservices?\b/i.test(path)) return 'Service'
  return 'Uncategorized'
}

// fetchSitemapPages(rootUrl, { fetcher }) ->
//   Promise<{ count, pages, sitemapsFetched, truncated } | null>
//
// pages: Array<{ path, type, sourceSitemap }> -- sourceSitemap is the
// child (or root) sitemap URL this page was actually found in, preserved
// for traceability per this fix's requirement 5, capped at
// MAX_SITEMAP_PAGES_LISTED entries.
// count: the REAL total distinct pages discovered (not capped by the above
//   -- only the returned `pages` array is).
// truncated: true if any bound (child count, total fetch count, or the
//   listed-pages cap) meant not everything discoverable was included.
//
// Returns null (never a zero-length result) on any failure to establish a
// usable page list at all -- same "data gap, not a finding" contract as
// every other additive check in this project (see checker.js's
// countSitemapPages), so callers can tell "confirmed zero pages" apart
// from "couldn't check."
async function fetchSitemapPages(rootUrl, { fetcher = fetch } = {}) {
  if (!rootUrl) return null

  const rootResult = await fetchWebPage(rootUrl, { fetcher, headers: {} })
  if (rootResult.fetchState !== 'success') return null

  const rootKind = detectSitemapKind(rootResult.html)
  if (rootKind === 'unknown') return null

  const visitedSitemapUrls = new Set([rootUrl])
  let sitemapsFetched = 1
  const seenPageIdentityKeys = new Set()
  const collectedPages = [] // { rawUrl, sourceSitemap }
  let truncated = false

  function addPage(rawUrl, sourceSitemap) {
    if (looksLikeNonPageAsset(rawUrl)) return
    const identity = normalizeUrlIdentity(rawUrl)
    const dedupeKey = identity.valid ? identity.key : rawUrl
    if (seenPageIdentityKeys.has(dedupeKey)) return
    seenPageIdentityKeys.add(dedupeKey)
    collectedPages.push({ rawUrl, sourceSitemap })
  }

  // walkIndex(xmlText, depth) -- `depth` is the depth of the index document
  // ALREADY IN HAND (xmlText); any child fetched from it is at depth + 1.
  async function walkIndex(xmlText, depth) {
    const childLocs = extractIndexChildLocs(xmlText)
    if (childLocs.length > MAX_CHILD_SITEMAPS_PER_INDEX) truncated = true
    const bounded = childLocs.slice(0, MAX_CHILD_SITEMAPS_PER_INDEX)

    for (const childUrl of bounded) {
      if (visitedSitemapUrls.has(childUrl)) continue // guards a duplicate/cyclical reference between sitemaps
      visitedSitemapUrls.add(childUrl)

      if (depth + 1 > MAX_SITEMAP_DEPTH) { truncated = true; continue } // depth guard -- the child is simply never fetched, and its URL is never treated as a page
      if (sitemapsFetched >= MAX_SITEMAPS_FETCHED_TOTAL) { truncated = true; continue } // total-fetch guard -- same: never fetched, never treated as a page

      sitemapsFetched += 1
      const childResult = await fetchWebPage(childUrl, { fetcher, headers: {} })
      if (childResult.fetchState !== 'success') continue // malformed/unreachable child sitemap fails gracefully -- childUrl is dropped, never emitted as a page

      const childKind = detectSitemapKind(childResult.html)
      if (childKind === 'sitemapindex') {
        await walkIndex(childResult.html, depth + 1)
      } else if (childKind === 'urlset') {
        for (const loc of extractUrlsetPageLocs(childResult.html)) addPage(loc, childUrl)
      }
      // childKind === 'unknown': nothing usable in this child; already skipped.
    }
  }

  if (rootKind === 'sitemapindex') {
    await walkIndex(rootResult.html, 0)
  } else {
    for (const loc of extractUrlsetPageLocs(rootResult.html)) addPage(loc, rootUrl)
  }

  if (collectedPages.length === 0) return null

  if (collectedPages.length > MAX_SITEMAP_PAGES_LISTED) truncated = true

  const pages = collectedPages.slice(0, MAX_SITEMAP_PAGES_LISTED).map(({ rawUrl, sourceSitemap }) => {
    let path
    try {
      path = new URL(rawUrl).pathname || '/'
    } catch (e) {
      path = rawUrl
    }
    return { path, type: classifySitemapPath(path), sourceSitemap }
  })

  return { count: collectedPages.length, pages, sitemapsFetched, truncated }
}

module.exports = {
  fetchSitemapPages,
  classifySitemapPath,
  detectSitemapKind,
  extractIndexChildLocs,
  extractUrlsetPageLocs,
  looksLikeNonPageAsset,
  MAX_SITEMAP_PAGES_LISTED,
  MAX_CHILD_SITEMAPS_PER_INDEX,
  MAX_SITEMAPS_FETCHED_TOTAL,
  MAX_SITEMAP_DEPTH,
  NON_PAGE_ASSET_EXTENSION_RE
}
