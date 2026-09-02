// SITEMAP DISCOVERY -- shared sitemap-index/urlset parsing + bounded
// recursive page-URL discovery, with source-sitemap-aware page
// classification. Added 2026-09-02 to fix a real bug in the Schema &
// Structure pillar's page-selection step: child sitemap XML files (e.g.
// /post-sitemap.xml, /page-sitemap.xml) were being surfaced as if they were
// real pages to classify. Extended 2026-09-02 (Phase A of the Schema
// page-workflow redesign) to fix a SECOND real bug found immediately after
// that fix shipped: the candidate list was capped WHILE WALKING the sitemap
// hierarchy, in sitemap-fetch order -- a client whose post-sitemap.xml
// (fetched first, per the index's own listing order) contained 20+ posts
// would fill the entire candidate list before page-sitemap.xml (About/
// Contact/Services) was ever considered, even though page-sitemap.xml WAS
// fetched. See DISCOVERY VS DISPLAY below.
//
// ROOT CAUSE #1 (fixed 2026-09-02, first pass): lib/checkers/checker.js's
// old countSitemapPages() ran one flat regex (`/<loc>.../gi`) against the
// entire fetched sitemap.xml body, with no distinction between:
//   - a <sitemapindex> root, whose <sitemap><loc> entries are CHILD
//     SITEMAP FILES, never pages, and
//   - a <urlset> root, whose <url><loc> entries are REAL PAGES.
// A client on a sitemap index (the very common Yoast/WordPress shape --
// sitemap_index.xml -> post-sitemap.xml, page-sitemap.xml,
// case-studies-sitemap.xml, landing-page-sitemap.xml, ...) had every one of
// those child-sitemap URLs treated and displayed as if it were a page.
//
// ROOT CAUSE #2 (fixed 2026-09-02, this pass) -- DISCOVERY VS DISPLAY:
// even after fix #1, every page found across every fetched child sitemap
// WAS being collected internally, but the final list handed back to the
// caller was built with `.slice(0, N)` in raw insertion order -- i.e.
// whichever sitemap the index happened to list (and therefore fetch) FIRST.
// A page-selection UI must never assume sitemap order is priority order.
// This file now separates two independent concerns that used to be one:
//   DISCOVERY  -- fetchSitemapPages() below collects a larger, still
//                 safely bounded CANDIDATE UNIVERSE (MAX_SITEMAP_
//                 CANDIDATES_DISCOVERED, currently 150) across every
//                 fetched sitemap, with real classification metadata
//                 attached to every candidate, regardless of which sitemap
//                 it came from or in what order.
//   PRIORITIZATION / DISPLAY SELECTION -- deliberately NOT this file's job.
//                 lib/schemaPagePriority.js decides which of the returned
//                 candidates are worth surfacing as "Recommended," from
//                 real page-type/business-relevance signals -- never from
//                 "was it early in the list."
// This file still enforces one hard cap (MAX_SITEMAP_CANDIDATES_DISCOVERED)
// so a pathological sitemap (thousands of URLs) can't blow up memory/JSON
// size, but that cap is now large enough that real per-child-sitemap
// content (post/page/case-studies/landing-page, the common Yoast shape) is
// never partially dropped the way a 20-item cap silently was.
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
// approach already used throughout this codebase. Bounded on three
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
// itself a page. This step still deliberately never fetches a candidate
// PAGE's own HTML (only sitemap XML files) -- classification here is
// bounded, cheap, regex-only evidence; anything requiring real page content
// is explicitly out of scope until a page is actually opened for analysis
// (a later phase, not this one).

const { fetchWebPage } = require('./webPageFetch')
const { normalizeUrlIdentity } = require('./urlIdentity')

// MAX_SITEMAP_CANDIDATES_DISCOVERED -- cap on the total CANDIDATE page
// universe this module collects and classifies (2026-09-02, Phase A of the
// Schema page-workflow redesign; supersedes the old, smaller
// MAX_SITEMAP_PAGES_LISTED display cap, which caused ROOT CAUSE #2 above).
// 150 is deliberately generous relative to the old 20 -- classification
// here is pure regex work (cheap, no extra network calls), so the real cost
// of a larger candidate universe is only a somewhat larger JSON payload
// persisted to pillar_scores (150 short objects is a few KB, negligible)
// -- while still bounding a client with an enormous sitemap (thousands of
// URLs) well short of turning this into an unbounded list. Which of these
// candidates are actually worth showing an account manager is a SEPARATE,
// later decision -- see lib/schemaPagePriority.js -- this file's only job
// is to discover and classify, never to decide what's "important."
const MAX_SITEMAP_CANDIDATES_DISCOVERED = 150

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

function filenameOf(sitemapUrl) {
  if (!sitemapUrl) return null
  try { return new URL(sitemapUrl).pathname.split('/').pop() || null } catch (e) { return null }
}

// -----------------------------------------------------------------------
// PAGE CLASSIFICATION -- Phase A of the Schema page-workflow redesign
// (2026-09-02). Replaces the old classifySitemapPath(path) -> single label
// with classifyPage({ path, sourceSitemap }) -> a full, transparent
// classification record. The old function considered ONLY the URL path;
// real client sitemaps showed this misses obvious cases -- e.g.
// /ultimate-guide-google-penalties/, /five-ways-find-topics-blog/,
// /keyword-targeting/ contain no "/blog/", "/article/", or "/post/" path
// segment at all, so they fell through to Uncategorized even though they
// are, self-evidently, blog posts -- BECAUSE THEY WERE DISCOVERED IN
// post-sitemap.xml, evidence this function now actually uses. The sitemap
// FILENAME a page was discovered in is real, CMS-authored evidence (Yoast
// names these deliberately: post-sitemap.xml literally means "this
// contains posts"), not a guess -- but it's still weaker than an unambiguous
// URL pattern match, since a generic page-sitemap.xml or
// landing-page-sitemap.xml filename doesn't itself say what KIND of page
// each entry is. Every classification is returned with WHERE it came from
// and HOW confident it is -- never hidden behind a single flat label -- so
// downstream prioritization (lib/schemaPagePriority.js) and the UI can
// treat a high-confidence URL-pattern match differently from a low-
// confidence "nothing resolved it" guess.
// -----------------------------------------------------------------------

const PAGE_TYPES = ['Home', 'Service', 'Location', 'Article', 'Case Study', 'About', 'Contact', 'Utility/Legal', 'Other']

// URL_PATTERN_RULES -- checked in order; the FIRST match wins. Order
// matters: more specific patterns are checked before more general ones
// (e.g. "/services/case-studies/example/" must read as Case Study, not
// Service; "/privacy-policy/" must read as Utility/Legal before anything
// else gets a chance to misfire on it).
const URL_PATTERN_RULES = [
  ['Utility/Legal', /privacy(-policy)?|terms(-of-(service|use)|-and-conditions)?|cookie(s|-policy)?|disclaimer|refund-policy|accessibility-statement|sitemap-page/i],
  ['Contact', /contact/i],
  ['About', /\babout([-_]us)?\b/i],
  ['Case Study', /case-stud(y|ies)/i],
  ['Article', /\/(blog|article|articles|news|post|posts)\//i],
  ['Article', /\/(blog|articles|news)$/i],
  ['Location', /\/(service-areas?|locations?|areas-we-serve)\//i],
  ['Service', /\bservices?\b/i]
]

function matchUrlPattern(path) {
  if (path === '/' || path === '') return 'Home'
  for (const [type, pattern] of URL_PATTERN_RULES) {
    if (pattern.test(path)) return type
  }
  return null
}

// SITEMAP_FILENAME_TYPE_HINTS -- a child sitemap filename that reliably
// implies a specific page type on its own (Yoast's own naming convention).
// SITEMAP_FILENAME_AMBIGUOUS_PATTERNS -- a filename that signals "this is a
// real content sitemap" but not which specific type -- page-sitemap.xml
// holds an unpredictable mix (About/Contact/Home/random pages), and
// landing-page-sitemap.xml commonly holds a mix of Service and Location
// pages. These still produce an honest, visible reason string explaining
// why classification stopped short, rather than silently returning
// Other/Uncategorized with no explanation.
const SITEMAP_FILENAME_TYPE_HINTS = [
  [/post-sitemap/i, 'Article'],
  [/case-stud(y|ies)-sitemap/i, 'Case Study']
]
const SITEMAP_FILENAME_AMBIGUOUS_PATTERNS = [/page-sitemap/i, /landing-page-sitemap/i]

// classifyPage({ path, sourceSitemap }) -> {
//   type, classificationSource: 'url_pattern' | 'sitemap_name' | 'none',
//   classificationConfidence: 'high' | 'medium' | 'low', classificationReason
// }
// Never hides how a classification was reached -- classificationReason is
// always a real, human-readable sentence, including for Other/Uncategorized
// results (explaining that no evidence resolved a type, or that the source
// sitemap's filename was ambiguous), not a silent fallback. Stronger,
// content-based classification (title/meta/on-page schema) would require
// fetching every candidate page's HTML, which this step deliberately does
// NOT do (see this file's header) -- URL pattern and sitemap-filename
// evidence are the only two signals available before a page is actually
// opened for analysis.
function classifyPage({ path, sourceSitemap }) {
  const urlType = matchUrlPattern(path)
  if (urlType) {
    return {
      type: urlType,
      classificationSource: 'url_pattern',
      classificationConfidence: 'high',
      classificationReason: urlType === 'Home'
        ? 'This is the homepage.'
        : `The URL path matches the ${urlType} pattern.`
    }
  }

  const filename = filenameOf(sourceSitemap)
  if (filename) {
    const specificHint = SITEMAP_FILENAME_TYPE_HINTS.find(([pattern]) => pattern.test(filename))
    if (specificHint) {
      const [, hintedType] = specificHint
      return {
        type: hintedType,
        classificationSource: 'sitemap_name',
        classificationConfidence: 'medium',
        classificationReason: `Discovered in ${filename}, which typically contains ${hintedType} pages, and no URL pattern contradicted that.`
      }
    }
    if (SITEMAP_FILENAME_AMBIGUOUS_PATTERNS.some(pattern => pattern.test(filename))) {
      return {
        type: 'Other',
        classificationSource: 'sitemap_name',
        classificationConfidence: 'low',
        classificationReason: `Discovered in ${filename}, which does not indicate one specific page type on its own, and no URL pattern resolved a type either.`
      }
    }
  }

  return {
    type: 'Other',
    classificationSource: 'none',
    classificationConfidence: 'low',
    classificationReason: 'No sitemap-source or URL-pattern evidence resolved a specific page type.'
  }
}

// fetchSitemapPages(rootUrl, { fetcher }) ->
//   Promise<{ count, pages, sitemapsFetched, truncated } | null>
//
// pages: Array<{ path, sourceSitemap, type, classificationSource,
//   classificationConfidence, classificationReason }> -- the discovered
// CANDIDATE UNIVERSE, capped at MAX_SITEMAP_CANDIDATES_DISCOVERED (see this
// file's header on why display/priority selection is deliberately NOT done
// here). sourceSitemap is the child (or root) sitemap URL this page was
// actually found in, preserved for traceability.
// count: the REAL total distinct pages discovered (not capped by the
//   above cap when the true total is smaller than it; when the true total
//   exceeds the cap, `count` reports the true total while `pages` is capped
//   -- see `truncated`).
// truncated: true if any bound (child count, total fetch count, or the
//   candidate cap) meant not everything discoverable was included.
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
  let totalPagesSeen = 0
  let truncated = false

  function addPage(rawUrl, sourceSitemap) {
    if (looksLikeNonPageAsset(rawUrl)) return
    const identity = normalizeUrlIdentity(rawUrl)
    const dedupeKey = identity.valid ? identity.key : rawUrl
    if (seenPageIdentityKeys.has(dedupeKey)) return
    seenPageIdentityKeys.add(dedupeKey)
    totalPagesSeen += 1
    if (collectedPages.length >= MAX_SITEMAP_CANDIDATES_DISCOVERED) {
      // Candidate cap reached -- stop COLLECTING, but totalPagesSeen above
      // keeps counting so `count` still reports the real total rather than
      // silently plateauing at the cap (same "count vs. capped list"
      // contract this file already used for MAX_SITEMAP_PAGES_LISTED).
      truncated = true
      return
    }
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

  const pages = collectedPages.map(({ rawUrl, sourceSitemap }) => {
    let path
    try {
      path = new URL(rawUrl).pathname || '/'
    } catch (e) {
      path = rawUrl
    }
    const classification = classifyPage({ path, sourceSitemap })
    return { path, sourceSitemap, ...classification }
  })

  return { count: totalPagesSeen, pages, sitemapsFetched, truncated }
}

module.exports = {
  fetchSitemapPages,
  classifyPage,
  matchUrlPattern,
  detectSitemapKind,
  extractIndexChildLocs,
  extractUrlsetPageLocs,
  looksLikeNonPageAsset,
  PAGE_TYPES,
  MAX_SITEMAP_CANDIDATES_DISCOVERED,
  MAX_CHILD_SITEMAPS_PER_INDEX,
  MAX_SITEMAPS_FETCHED_TOTAL,
  MAX_SITEMAP_DEPTH,
  NON_PAGE_ASSET_EXTENSION_RE
}
