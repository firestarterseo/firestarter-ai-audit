// URL IDENTITY / NORMALIZATION -- Phase 2B ("Discovery Observation + URL
// Identity Primitives", 2026-09-02). Pure, network-free, zero dependencies.
//
// WHY THIS FILE EXISTS: the Phase 2A "Source Discovery & Evidence
// Architecture Audit" found that this codebase has NO URL-identity
// normalization anywhere -- every dedup today (lib/citedPageInspection.js's
// `(client_id, url)` cache key, lib/sourceCitation.js's per-domain URL
// Sets) is exact-string-match only, so `https://example.com/page` and
// `https://example.com/page?utm_source=chatgpt` are treated as two
// unrelated pages forever. This file is the smallest fix: a pure function
// that computes a conservative "is this plausibly the same page" grouping
// key, for lib/discoveryObservation.js's multi-channel provenance merging
// to use. It does NOT replace exact-URL storage anywhere -- see that file's
// header for how the two are meant to coexist.
//
// THREE DISTINCT CONCEPTS THIS FILE (AND THE FUTURE DISCOVERY/FETCH FLOW)
// DELIBERATELY KEEP SEPARATE -- do not conflate them:
//   RAW URL                  -- exactly what a discovery channel observed,
//                               verbatim, never altered.
//   NORMALIZED PAGE IDENTITY -- THIS FILE's output: a conservative, pure,
//                               pre-fetch grouping key for "plausibly the
//                               same page." Never a claim of certainty.
//   FINAL/RESOLVED URL       -- lib/webPageFetch.js's `finalUrl`, known only
//                               AFTER a real fetch actually happens
//                               (redirects, etc.). This file has no opinion
//                               about it and never tries to predict it.
//
// FUTURE FLOW (documented now per the approved Phase 2B architecture,
// NOT wired up or implemented this phase):
//   discovery observation (lib/discoveryObservation.js)
//     -> normalizeUrlIdentity() (THIS FILE) -- pre-fetch grouping only,
//        used to answer "how many distinct pages were discovered," never
//        to skip fetching a URL that looks similar to one already fetched
//     -> lib/webPageFetch.js#fetchWebPage() -- the real network fetch;
//        its own `finalUrl`/`redirected` are separate facts, discovered
//        only after a real request, and are never merged back into the
//        pre-fetch identity this file computes
//     -> pillar-specific page inspection/extraction (Entity & Brand
//        Authority's own future module, or lib/citedPageInspection.js for
//        Source & Citation)
// lib/webPageFetch.js is NOT modified by this phase -- no defect was found
// in it, and normalizing a URL before a fetch decision is a distinct
// concern from performing the fetch itself.
//
// CONSERVATIVE BY DESIGN -- this is explicitly NOT a canonicalization
// engine. It never fetches, never reads rel=canonical, never guesses that
// two structurally different URLs are the same page, and never collapses
// every page on a domain into one identity. It only resolves ambiguity
// that is genuinely trivial: www./hostname case/URL fragment/trailing
// slash/a short, well-known tracking-parameter list. When in doubt, two
// URLs stay distinct rather than being guessed as the same page --
// e.g. http:// and https:// versions of the same path are DELIBERATELY
// kept distinct here (not in the "trivial" list below); reconciling that
// is exactly what a real fetch's `finalUrl` is for, not this pre-fetch step.

// The only parameters removed -- a short, genuinely well-known list, never
// a broad heuristic (e.g. never "any param starting with a single letter").
// Compared case-insensitively; the ORIGINAL casing of every kept parameter
// is preserved untouched.
const KNOWN_TRACKING_PARAM_NAMES = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid'
])

// stripTrivialTrailingSlash(path) -- "/page/" -> "/page", but the bare root
// "/" is left alone (there is nothing trivial to strip from it).
function stripTrivialTrailingSlash(path) {
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1)
  return path
}

// normalizeUrlIdentity(rawUrl) -> { raw, valid, error, normalized, key }
//
// Never throws, never performs a network request. `normalized`/`key` are
// null whenever `valid` is false -- every caller (see
// lib/discoveryObservation.js#groupObservationsByPageIdentity) MUST handle
// that case explicitly rather than assuming every observed URL yields a
// usable identity. This is the "malformed URL fails normalized identity
// safely" contract Phase 2B requires: the raw observation itself is never
// rejected by this function -- only its derived identity is marked invalid.
//
// `normalized` shape: { protocol, hostname, port, path, query } -- kept as
// a structured object (not just the final `key` string) so a caller can
// inspect any one piece (e.g. "is this the same hostname") without
// re-parsing `key`.
function normalizeUrlIdentity(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    return { raw: rawUrl === undefined ? null : rawUrl, valid: false, error: 'empty_or_non_string', normalized: null, key: null }
  }

  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch (e) {
    return { raw: rawUrl, valid: false, error: 'unparseable_url', normalized: null, key: null }
  }

  const protocol = parsed.protocol.replace(/:$/, '').toLowerCase()
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '')
  const port = parsed.port || null // kept distinct rather than assumed default -- a non-default port is a real, meaningful difference, never stripped.
  const path = stripTrivialTrailingSlash(parsed.pathname || '/')

  // Preserve every query parameter EXCEPT the short, well-known tracking
  // set above -- deliberately NOT an aggressive strip (see module header).
  // Sorted by key purely to produce a STABLE, deterministic identity
  // string -- sorting never discards a parameter or its value, it only
  // makes "?a=1&b=2" and "?b=2&a=1" (the same real query, different order)
  // produce the same identity, which is meaning-preserving, not a guess.
  const keptParams = [...parsed.searchParams.entries()]
    .filter(([k]) => !KNOWN_TRACKING_PARAM_NAMES.has(k.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const query = keptParams.map(([k, v]) => `${k}=${v}`).join('&')

  const normalized = { protocol, hostname, port, path, query }
  const key = `${protocol}://${hostname}${port ? `:${port}` : ''}${path}${query ? `?${query}` : ''}`

  return { raw: rawUrl, valid: true, error: null, normalized, key }
}

module.exports = { normalizeUrlIdentity, KNOWN_TRACKING_PARAM_NAMES }
