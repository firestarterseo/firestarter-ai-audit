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
// ROOT CAUSE #3 (fixed 2026-09-02, this pass) -- URL-PATTERN PRECEDENCE OVER
// EXPLICIT SITEMAP PROVENANCE: live client sitemaps surfaced real blog
// posts -- e.g. /technical-seo-cleanup-service-indexing-crawl-budget-
// canonicals-redirects/, discovered in post-sitemap.xml -- misclassified as
// Service, purely because the word "service" appears in the slug. The old
// classifyPage() checked matchUrlPattern(path) FIRST, unconditionally, and
// only consulted the source sitemap's filename as a weak fallback when NO
// url pattern matched at all. That's backwards for a filename as explicit
// as post-sitemap.xml: Yoast (and most WordPress SEO plugins) name child
// sitemaps after the actual CMS post type they contain, which is
// structural, CMS-authored evidence -- far stronger than a slug merely
// mentioning a topic word. A blog post ABOUT a service is still an
// ARTICLE; page TYPE (what kind of URL this is) and page TOPIC (what it's
// about) are different questions, and the old code conflated them by
// letting "Service"/"Location" URL patterns -- which are inherently
// TOPIC-word patterns, not structural ones -- override an explicit,
// structural post-sitemap.xml/case-studies-sitemap.xml/product-sitemap.xml
// classification. Note sitemap provenance itself was NEVER being discarded
// end to end -- every page object always carried its real `sourceSitemap`
// URL from discovery through to the persisted `_raw.sitemapPages` and into
// SchemaWizard.js -- the bug was purely in classifyPage()'s evidence
// PRECEDENCE, not in the data being lost.
//
// NEW PRECEDENCE (see classifyPage below for the full implementation):
//   1. SITEMAP / POST-TYPE PROVENANCE -- highest-confidence structural
//      signal when explicit (post-sitemap(N)?.xml -> Article,
//      case-stud(y|ies)-sitemap.xml -> Case Study, product-sitemap.xml ->
//      Product). When this tier resolves a type, URL-slug topic words
//      (Service, Location, or any other pattern) NEVER override it in this
//      phase -- there is currently no page-content evidence (tier 2 below)
//      strong enough to justify overriding explicit CMS-authored sitemap
//      provenance with a mere slug-word heuristic.
//   2. ACTUAL PAGE EVIDENCE (title, H1, meta/OG type, on-page JSON-LD,
//      article byline/date, breadcrumbs) -- NOT implemented in this pass.
//      This module deliberately still never fetches a candidate page's own
//      HTML (same constraint stated in this file's header since Phase A --
//      doing so for up to MAX_SITEMAP_CANDIDATES_DISCOVERED pages per audit
//      would be a large new cost/scope change, not a bug fix). Reserved for
//      a later phase, exactly like Phase A already reserved it.
//   3. URL-PATTERN HEURISTICS -- fallback only, used exactly as before,
//      for pages whose source sitemap carries no strong, unambiguous type
//      claim of its own (a generic page-sitemap.xml, a landing-page-
//      sitemap.xml, or an unrecognized/non-WordPress sitemap name). This is
//      NOT a regression for those cases -- a page-sitemap.xml URL
//      containing "/services/" still correctly resolves to Service via
//      this tier, exactly as before, since page-sitemap.xml itself makes
//      no competing structural claim to override.
//
// Category/tag/author archive sitemaps (category-sitemap.xml,
// tag-sitemap.xml, author-sitemap.xml, and their numbered variants) are now
// excluded from the candidate universe entirely -- they are not schema
// page-selection candidates today, and including them would silently
// surface archive/taxonomy URLs alongside real content pages.
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

// ROOT CAUSE #4 (fixed 2026-09-02, this pass) -- WALK-ORDER STARVATION,
// the same discovery-vs-display bug as ROOT CAUSE #2 above, but at a scale
// Phase A's fixture testing didn't reach. Phase A raised the candidate cap
// from 20 to 150 and proved (see TEST 11 below) that a first child sitemap
// with MORE POSTS THAN THE OLD CAP no longer starves a later child sitemap
// -- but that test used 25 posts, comfortably under the new 150 cap, so it
// never actually exercised the case where the FIRST child sitemap ALONE
// exceeds the cap. Real-client validation of a downstream feature (Page
// Search Footprint, see lib/pageSearchFootprint.js) surfaced exactly that
// case on a real site: Firestarter's own sitemap index lists
// post-sitemap.xml first, which alone holds ~185 URLs -- comfortably more
// than the old 150-candidate cap -- so the walk exhausted its entire
// candidate budget on blog posts before ever reaching page-sitemap.xml,
// where /denver-seo-agency/ (a real, high-value, actively-ranking service
// page) lives. The cap was being enforced INSIDE addPage(), i.e. WHILE
// walking, in whatever order the sitemap index happened to list its
// children -- so "does this page make the candidate list" depended on
// sitemap-fetch order, not on which pages actually exist. Same root shape
// as ROOT CAUSE #2, one level deeper.
//
// FIX -- DISCOVERY VS DISPLAY, PART 2: this module now separates two
// concerns that a single flat cap used to conflate:
//   (A) SITEMAP-FETCH BOUNDS -- MAX_CHILD_SITEMAPS_PER_INDEX,
//       MAX_SITEMAPS_FETCHED_TOTAL, MAX_SITEMAP_DEPTH (below) -- these
//       bound NETWORK REQUESTS and XML PARSING (how many sitemap XML
//       *documents* get fetched). They are unchanged by this fix: a
//       Yoast-shaped site's 4-10 child sitemaps were never the problem.
//   (B) PAGE-URL EXTRACTION BOUND -- MAX_SITEMAP_CANDIDATES_DISCOVERED,
//       this constant -- bounds MEMORY and the JSON PAYLOAD SIZE persisted
//       to pillar_scores. It has nothing to do with (A): classification is
//       pure regex work with no extra network cost per page, so this bound
//       exists purely to stop a pathological sitemap (tens of thousands of
//       URLs) from becoming an unbounded in-memory list.
// Because (B) was previously enforced greedily DURING the walk, it also
// accidentally encoded "whichever sitemap the index lists first wins the
// slots" -- a completely incidental, business-meaningless ordering. The
// fix: addPage() now collects EVERY deduped page URL found within bounds
// (A), unbounded by (B), while the walk runs. Only once the ENTIRE
// sitemap-fetch traversal (bounded by (A)) is complete does this function
// apply (B) as a single, final step. For any real client whose total real
// page count is under MAX_SITEMAP_CANDIDATES_DISCOVERED -- every client
// this product has actually seen, Firestarter's own 282 real pages
// included -- this means COMPLETE extraction, with walk order no longer
// mattering at all. If a site's real page count DOES exceed the bound (a
// case this product hasn't hit yet, but should still degrade honestly
// rather than silently), the final list is built by
// fairlySampleBySourceSitemap() (below): a simple round-robin across each
// distinct sourceSitemap's own pages, so even in that truncation case, one
// high-volume sitemap still cannot consume every slot and starve every
// other sitemap to zero, the way a raw slice(0, N) would.
//
// 1000 is chosen the same way 150 was reasoned about above: classification
// is pure regex work, so a larger candidate universe only costs a larger
// (still small) JSON payload -- roughly 300-500 bytes per page object, so
// 1000 pages is on the order of a few hundred KB, negligible for a
// Postgres JSONB column. It gives ~3.5x headroom over the largest real
// client site this product has actually measured (Firestarter, 282 real
// pages) while still bounding a genuinely enormous sitemap (a large
// e-commerce catalog, thousands of URLs) well short of unbounded. Which of
// the returned candidates are actually worth showing an account manager
// remains a SEPARATE, later decision -- see lib/schemaPagePriority.js --
// this file's only job is to discover and classify, never to decide what's
// "important."
const MAX_SITEMAP_CANDIDATES_DISCOVERED = 1000

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

// fairlySampleBySourceSitemap(items, cap) -> items.slice(...), fairly.
// Only ever called when items.length > cap (see fetchSitemapPages) -- the
// ordinary case for every real client seen so far is items.length <= cap,
// where this function is never invoked and complete extraction is
// returned untouched. When a true safety bound IS hit, this replaces a
// naive `items.slice(0, cap)` (which would just re-introduce ROOT CAUSE #4
// at the truncation boundary -- the first sourceSitemap in `items` would
// still take every slot) with a deterministic round-robin: one item from
// each distinct sourceSitemap, in the order those sitemaps were first
// encountered, repeated until either every item is taken or the cap is
// reached. Guarantees no single sourceSitemap can starve every other one
// down to zero. Within each sourceSitemap's own group, original discovery
// order is preserved.
function fairlySampleBySourceSitemap(items, cap) {
  if (items.length <= cap) return items

  const groupOrder = []
  const groups = new Map()
  for (const item of items) {
    const key = item.sourceSitemap
    if (!groups.has(key)) { groups.set(key, []); groupOrder.push(key) }
    groups.get(key).push(item)
  }

  const result = []
  let tookAnyThisRound = true
  while (result.length < cap && tookAnyThisRound) {
    tookAnyThisRound = false
    for (const key of groupOrder) {
      if (result.length >= cap) break
      const group = groups.get(key)
      if (group.length > 0) {
        result.push(group.shift())
        tookAnyThisRound = true
      }
    }
  }
  return result
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

// PAGE_TYPES -- 'Landing Page' and 'Product' added 2026-09-02 alongside the
// sitemap-provenance fix, per explicit request ("landing-page-sitemap.xml
// -> LANDING PAGE", "product-sitemap.xml -> product"). No other taxonomy
// added -- the schema page-selection workflow has no current use for
// finer-grained types than this.
const PAGE_TYPES = ['Home', 'Service', 'Location', 'Article', 'Case Study', 'Product', 'Landing Page', 'About', 'Contact', 'Utility/Legal', 'Other']

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

// -----------------------------------------------------------------------
// SITEMAP TYPE INFERENCE -- WordPress/Yoast-style child-sitemap naming
// conventions, generalized (2026-09-02, ROOT CAUSE #3 fix) to numbered
// variants (post-sitemap2.xml, post-sitemap3.xml, ...) via plain substring
// pattern matching rather than exact-filename equality -- no numbered
// variant needs to be hardcoded, since e.g. /post-sitemap/i already matches
// "post-sitemap2.xml" as a substring. Does NOT assume every site is
// WordPress: a filename that matches none of these patterns resolves to
// 'unknown', which classifyPage treats exactly like a generic sitemap --
// falling back to URL-pattern evidence, never guessing a false structural
// claim from an unrecognized name.
// -----------------------------------------------------------------------

// STRONG_SITEMAP_TYPE_RULES -- a filename this explicit and CMS-authored is
// treated as the HIGHEST-confidence structural signal for its page type;
// see classifyPage's precedence rules. Checked before GENERIC/EXCLUDED
// below would ever matter, though in practice their filename patterns
// don't overlap.
const STRONG_SITEMAP_TYPE_RULES = [
  [/post-sitemap/i, 'post'],
  [/case-stud(y|ies)-sitemap/i, 'case_study'],
  [/product-sitemap/i, 'product']
]
const STRONG_SITEMAP_TYPE_TO_PAGE_TYPE = { post: 'Article', case_study: 'Case Study', product: 'Product' }

// GENERIC_SITEMAP_TYPE_RULES -- a filename that signals "this is a real
// content sitemap" but not one single specific type on its own:
// page-sitemap.xml holds an unpredictable mix (About/Contact/Home/random
// pages), and landing-page-sitemap.xml commonly holds a mix of Service and
// Location pages. For BOTH, URL-pattern evidence remains the primary
// signal (tier 3) -- these sitemap types make no strong claim to protect
// URL evidence from, unlike the STRONG types above. 'landing_page' gets one
// extra behavior: when no URL pattern resolves anything more specific, it
// defaults to 'Landing Page' (a real, honest default) rather than 'Other'.
const GENERIC_SITEMAP_TYPE_RULES = [
  [/landing-page-sitemap/i, 'landing_page'],
  [/page-sitemap/i, 'page']
]

// EXCLUDED_SITEMAP_TYPE_RULES -- archive/taxonomy sitemaps that are not
// schema page-selection candidates today ("category/tag/author sitemaps
// should generally NOT be treated as normal schema page candidates unless
// the workflow explicitly intends archive pages" -- it does not). Checked
// first in inferSitemapType so a coincidental future overlap with the
// STRONG/GENERIC patterns above can never accidentally let an archive
// sitemap's pages through.
const EXCLUDED_SITEMAP_TYPE_RULES = [
  [/category-sitemap/i, 'category'],
  [/tag-sitemap/i, 'tag'],
  [/author-sitemap/i, 'author']
]
const EXCLUDED_SITEMAP_TYPES = new Set(EXCLUDED_SITEMAP_TYPE_RULES.map(([, type]) => type))

// inferSitemapType(sourceSitemapUrl) -> 'post' | 'case_study' | 'product' |
//   'landing_page' | 'page' | 'category' | 'tag' | 'author' | 'unknown'
// Pure filename pattern matching -- no assumption that every site is
// WordPress; an unrecognized filename (or no sourceSitemapUrl at all, e.g.
// a synthetic homepage-only fallback candidate) safely resolves to
// 'unknown'.
function inferSitemapType(sourceSitemapUrl) {
  const filename = filenameOf(sourceSitemapUrl)
  if (!filename) return 'unknown'
  for (const [pattern, type] of EXCLUDED_SITEMAP_TYPE_RULES) if (pattern.test(filename)) return type
  for (const [pattern, type] of STRONG_SITEMAP_TYPE_RULES) if (pattern.test(filename)) return type
  for (const [pattern, type] of GENERIC_SITEMAP_TYPE_RULES) if (pattern.test(filename)) return type
  return 'unknown'
}

// classifyPage({ path, sourceSitemap }) -> {
//   type, classificationSource: 'url_pattern' | 'sitemap_name' | 'none',
//   classificationConfidence: 'high' | 'medium' | 'low', classificationReason
// }
// Never hides how a classification was reached -- classificationReason is
// always a real, human-readable sentence, including for Other/Uncategorized
// results, not a silent fallback.
//
// PRECEDENCE (2026-09-02, ROOT CAUSE #3 fix -- see this file's header):
//   0. path === '/' is Home unconditionally -- a purely structural fact,
//      not a slug/topic-word heuristic, checked before anything else.
//   1. STRONG sitemap-type provenance (post/case_study/product) -- when the
//      source sitemap's filename is this explicit, it wins outright.
//      URL-slug topic words (e.g. "service" appearing in a blog post's own
//      slug) NEVER override this tier in this phase -- only real page-level
//      evidence (title/H1/on-page schema -- not fetched by this module,
//      see this file's header) would be strong enough to justify that, and
//      that tier isn't implemented yet.
//   2. (actual page evidence -- not implemented; see file header)
//   3. URL-pattern heuristics -- the fallback for GENERIC (page,
//      landing_page) and 'unknown' sitemap types, exactly as before this
//      fix. A landing_page sitemap with no more specific URL match
//      defaults to 'Landing Page'; a generic page-sitemap.xml or unknown
//      sitemap with no URL match defaults to 'Other', same as before.
function classifyPage({ path, sourceSitemap }) {
  if (path === '/' || path === '') {
    return { type: 'Home', classificationSource: 'url_pattern', classificationConfidence: 'high', classificationReason: 'This is the homepage.' }
  }

  const sitemapType = inferSitemapType(sourceSitemap)
  const strongType = STRONG_SITEMAP_TYPE_TO_PAGE_TYPE[sitemapType]
  if (strongType) {
    const filename = filenameOf(sourceSitemap)
    return {
      type: strongType,
      classificationSource: 'sitemap_name',
      classificationConfidence: 'high',
      classificationReason: `Discovered in ${filename}, which is explicit, structural evidence this is a ${strongType} page -- a URL slug mentioning an unrelated topic word (e.g. "service") does not override this.`
    }
  }

  const urlType = matchUrlPattern(path)
  if (urlType) {
    return {
      type: urlType,
      classificationSource: 'url_pattern',
      classificationConfidence: 'high',
      classificationReason: `The URL path matches the ${urlType} pattern.`
    }
  }

  if (sitemapType === 'landing_page') {
    return {
      type: 'Landing Page',
      classificationSource: 'sitemap_name',
      classificationConfidence: 'medium',
      classificationReason: `Discovered in ${filenameOf(sourceSitemap)}, which typically contains landing pages, and no URL pattern resolved a more specific type.`
    }
  }
  if (sitemapType === 'page') {
    return {
      type: 'Other',
      classificationSource: 'sitemap_name',
      classificationConfidence: 'low',
      classificationReason: `Discovered in ${filenameOf(sourceSitemap)}, which does not indicate one specific page type on its own, and no URL pattern resolved a type either.`
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
// pages: Array<{ path, url, sourceSitemap, sitemapType, type,
//   classificationSource, classificationConfidence, classificationReason }>
// -- the discovered CANDIDATE UNIVERSE, capped at
// MAX_SITEMAP_CANDIDATES_DISCOVERED (see this file's header on why display/
// priority selection is deliberately NOT done here). sourceSitemap is the
// child (or root) sitemap URL this page was actually found in, preserved
// for traceability; sitemapType (added 2026-09-02) is that sitemap's
// inferred provenance ('post' | 'case_study' | 'product' | 'landing_page' |
// 'page' | 'unknown' -- 'category'/'tag'/'author' pages never reach this
// array at all, see EXCLUDED_SITEMAP_TYPES above); url is the original full
// discovered URL (path is only its pathname).
// count: the REAL total distinct pages discovered (not capped by
//   MAX_SITEMAP_CANDIDATES_DISCOVERED when the true total is smaller than
//   it; when the true total exceeds the cap, `count` reports the true
//   total while `pages` is capped -- see `truncated`/`truncationReasons`).
//   Unaffected by walk order or which bound (if any) was hit.
// truncated: true if any bound -- child-sitemap count, total sitemap
//   fetches, sitemap depth, or the page-URL extraction cap -- meant not
//   everything discoverable was included. Never true merely because a
//   later Display/Recommended step (lib/schemaPagePriority.js) will only
//   show a subset -- that is a separate, later decision this field says
//   nothing about.
// truncationReasons: string[], one entry per distinct bound actually hit
//   (never invented, never present when truncated is false) --
//   'child_sitemap_count_exceeded' | 'total_sitemap_fetches_exceeded' |
//   'sitemap_depth_exceeded' | 'page_url_bound_exceeded'. More than one can
//   co-occur on a single pathological tree; each is reported honestly
//   rather than collapsed into a single boolean.
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
  const collectedPages = [] // { rawUrl, sourceSitemap } -- EVERY deduped page found within sitemap-fetch bounds (A), unbounded by the page-URL cap (B) during collection -- see ROOT CAUSE #4 above. The cap is applied exactly once, after this array is complete.
  const truncationReasons = new Set()

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
    if (childLocs.length > MAX_CHILD_SITEMAPS_PER_INDEX) truncationReasons.add('child_sitemap_count_exceeded')
    const bounded = childLocs.slice(0, MAX_CHILD_SITEMAPS_PER_INDEX)

    for (const childUrl of bounded) {
      if (visitedSitemapUrls.has(childUrl)) continue // guards a duplicate/cyclical reference between sitemaps
      visitedSitemapUrls.add(childUrl)

      if (depth + 1 > MAX_SITEMAP_DEPTH) { truncationReasons.add('sitemap_depth_exceeded'); continue } // depth guard -- the child is simply never fetched, and its URL is never treated as a page
      if (sitemapsFetched >= MAX_SITEMAPS_FETCHED_TOTAL) { truncationReasons.add('total_sitemap_fetches_exceeded'); continue } // total-fetch guard -- same: never fetched, never treated as a page

      sitemapsFetched += 1
      const childResult = await fetchWebPage(childUrl, { fetcher, headers: {} })
      if (childResult.fetchState !== 'success') continue // malformed/unreachable child sitemap fails gracefully -- childUrl is dropped, never emitted as a page

      const childKind = detectSitemapKind(childResult.html)
      if (childKind === 'sitemapindex') {
        await walkIndex(childResult.html, depth + 1)
      } else if (childKind === 'urlset') {
        // ROOT CAUSE #3 fix (2026-09-02): a category/tag/author archive
        // sitemap is fetched (so sitemapsFetched/truncated bookkeeping stays
        // accurate) but its pages are never collected as candidates at all
        // -- "category/tag/author sitemaps should generally NOT be treated
        // as normal schema page candidates." Every other urlset (including
        // an 'unknown'-type one -- a non-WordPress or custom sitemap name)
        // is collected exactly as before.
        if (!EXCLUDED_SITEMAP_TYPES.has(inferSitemapType(childUrl))) {
          for (const loc of extractUrlsetPageLocs(childResult.html)) addPage(loc, childUrl)
        }
      }
      // childKind === 'unknown': nothing usable in this child; already skipped.
    }
  }

  if (rootKind === 'sitemapindex') {
    await walkIndex(rootResult.html, 0)
  } else if (!EXCLUDED_SITEMAP_TYPES.has(inferSitemapType(rootUrl))) {
    for (const loc of extractUrlsetPageLocs(rootResult.html)) addPage(loc, rootUrl)
  }

  if (collectedPages.length === 0) return null

  // The page-URL extraction bound (B) is applied here, ONCE, against the
  // COMPLETE collected universe from every sitemap this walk fetched --
  // never mid-walk, never in raw sitemap-fetch order. See ROOT CAUSE #4 and
  // fairlySampleBySourceSitemap() above.
  const totalPagesObserved = collectedPages.length
  let finalPages = collectedPages
  if (collectedPages.length > MAX_SITEMAP_CANDIDATES_DISCOVERED) {
    truncationReasons.add('page_url_bound_exceeded')
    finalPages = fairlySampleBySourceSitemap(collectedPages, MAX_SITEMAP_CANDIDATES_DISCOVERED)
  }

  const pages = finalPages.map(({ rawUrl, sourceSitemap }) => {
    let path
    try {
      path = new URL(rawUrl).pathname || '/'
    } catch (e) {
      path = rawUrl
    }
    const classification = classifyPage({ path, sourceSitemap })
    // sitemapType (2026-09-02, ROOT CAUSE #3 fix) -- the raw inferred
    // WordPress/generic sitemap-type provenance fact itself, exposed
    // transparently alongside the classification it informed (see this
    // file's header on why classification and provenance are kept as
    // separate, both-visible fields rather than only the former). `url`
    // (the full original URL, not just its pathname) is preserved too --
    // this file's `path` field always discarded it before this fix; adding
    // `url` back is additive-only, needed by any later step that wants to
    // actually fetch a candidate page's own content.
    return { path, url: rawUrl, sourceSitemap, sitemapType: inferSitemapType(sourceSitemap), ...classification }
  })

  return {
    count: totalPagesObserved,
    pages,
    sitemapsFetched,
    truncated: truncationReasons.size > 0,
    truncationReasons: [...truncationReasons]
  }
}

module.exports = {
  fetchSitemapPages,
  classifyPage,
  matchUrlPattern,
  inferSitemapType,
  detectSitemapKind,
  extractIndexChildLocs,
  extractUrlsetPageLocs,
  looksLikeNonPageAsset,
  fairlySampleBySourceSitemap,
  PAGE_TYPES,
  EXCLUDED_SITEMAP_TYPES,
  MAX_SITEMAP_CANDIDATES_DISCOVERED,
  MAX_CHILD_SITEMAPS_PER_INDEX,
  MAX_SITEMAPS_FETCHED_TOTAL,
  MAX_SITEMAP_DEPTH,
  NON_PAGE_ASSET_EXTENSION_RE
}
