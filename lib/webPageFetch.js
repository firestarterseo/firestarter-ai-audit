// SHARED WEB PAGE FETCH / INSPECTION INFRASTRUCTURE (Phase 2A, 2026-09-01).
//
// WHY THIS FILE EXISTS: by the time this was written, at least seven
// different places in this codebase each hand-rolled their own "fetch an
// external URL and read the body" logic -- lib/citedPageInspection.js,
// lib/checkers/checker.js, lib/checkers/technical-checker.js,
// lib/checkers/content-checker.js, lib/runAudit.js, lib/schemaGenerator.js,
// lib/trackAiVisibility.js, lib/clientIndustryIntelligence.js -- with
// inconsistent timeout/robots/failure-classification behavior (see the
// Phase 2A inventory report for the full trace). This module is the single
// place that answers the eight questions every one of those callers
// eventually needs answered:
//   1. Was the URL actually fetchable?        -> fetchState
//   2. What URL ultimately resolved?           -> finalUrl / redirected
//   3. What HTTP result occurred?              -> status
//   4. Was access blocked?                     -> failureCategory
//   5. Was robots policy relevant?             -> robotsState
//   6. Did we receive usable HTML?              -> contentType / html
//   7. What page content was actually observed? -> html / truncated
//   8. What failed, and how confidently?        -> failureCategory / failureDetail
//
// SCOPE DISCIPLINE (explicit, load-bearing): this module's job is
// TRANSPORT / ACCESS / EVIDENCE RETRIEVAL ONLY. It does not parse
// meaning out of the page (no entity/brand extraction, no LLM analysis,
// no schema parsing, no competitor logic, no opportunity creation) --
// those stay in each caller's own inspection layer (e.g.
// lib/citedPageInspection.js's client-entity matching, lib/checkers/
// lightweight-jsonld.js's JSON-LD parsing). This is intentional and
// should not be "improved" by growing this file into a page-analysis
// service.
//
// THE CENTRAL PRINCIPLE THIS FILE EXISTS TO PROTECT:
//   FETCH FAILURE ≠ ABSENCE OF EVIDENCE.
// A page that can't be fetched, is robots-blocked, times out, or comes
// back oversized is NEVER conflated with "the page doesn't say X" -- it
// is a distinct, honestly-labeled failure state. Every caller built on
// top of this module inherits that guarantee for free rather than having
// to re-derive it.
//
// ZERO NEW DEPENDENCIES -- same constraint every other checker in this
// project follows (see lib/checkers/checker.js's header on why cheerio/
// jsdom etc. were deliberately avoided): only the runtime's native
// fetch/AbortController/TextDecoder/URL. No retry logic either -- none of
// the seven existing fetch implementations traced for this phase retried
// a failed request, so adding retries here would be new behavior no
// caller asked for, not a consolidation.

const DEFAULT_TIMEOUT_MS = 8000 // matches lib/citedPageInspection.js's existing default -- the strongest existing precedent for a caller that already cares about failure honesty.
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 // 5MB -- generous for real HTML pages; guards against a pathological/streaming response tying up a fetch indefinitely.
const DEFAULT_USER_AGENT = 'FirestarterAIAudit/1.0' // the exact string every existing direct-fetch caller in this repo already sends.

// FAILURE VOCABULARY -- derived from actual existing behavior (see the
// Phase 2A inventory report), not invented from scratch:
//   - invalid_url        : the URL string doesn't parse (lib/citedPageInspection.js precedent)
//   - robots_blocked      : robots.txt disallows this path, and the caller opted into respectRobots (lib/citedPageInspection.js precedent)
//   - timeout             : the request was aborted by this module's own timeout (NEW distinct state -- existing code folded this into network_failure; kept separate here since a caller CAN distinguish it, though see lib/citedPageInspection.js's migration, which deliberately maps this back down to its own legacy 'network_failure' bucket to preserve its exact public contract)
//   - network_failure     : DNS/connection/TLS/generic fetch() failure (lib/citedPageInspection.js precedent)
//   - auth_required       : HTTP 401 (lib/citedPageInspection.js precedent)
//   - blocked_access      : HTTP 403 (lib/citedPageInspection.js precedent)
//   - deleted_page        : HTTP 404/410 (lib/citedPageInspection.js precedent)
//   - rate_limited        : HTTP 429 (lib/citedPageInspection.js precedent)
//   - server_error        : HTTP 5xx (NEW distinct state -- lib/citedPageInspection.js currently folds this into network_failure; kept separate here for richer future callers, with the same backward-compatible mapping in its migration)
//   - non_html            : a successful HTTP response whose content-type doesn't look like HTML/text, when the caller opted into requireHtml (NEW -- no existing checker distinguishes this today, they all just treat any 2xx body as text)
//   - unknown_failure     : catch-all (lib/citedPageInspection.js precedent)
// Deliberately NOT included: a numeric reliability/confidence score
// (explicitly out of scope), and content-level states like
// "js_rendering_required" -- that requires reading and judging the HTML
// itself, which is inspection-layer work each caller already does (see
// lib/citedPageInspection.js's own looksLikeJsRenderedShell, applied to
// this module's returned html), not a transport concern.
const FAILURE_CATEGORIES = [
  'invalid_url', 'robots_blocked', 'timeout', 'network_failure',
  'auth_required', 'blocked_access', 'deleted_page', 'rate_limited',
  'server_error', 'non_html', 'unknown_failure'
]

function nowIso() { return new Date().toISOString() }

function categorizeHttpStatus(status) {
  if (status === 401) return 'auth_required'
  if (status === 403) return 'blocked_access'
  if (status === 404 || status === 410) return 'deleted_page'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server_error'
  return 'unknown_failure'
}

// looksLikeHtmlContentType(contentType) -> boolean. Header-based only
// (never sniffs the body) -- deliberately simple, matching this project's
// consistent "plain checks over clever heuristics" convention.
function looksLikeHtmlContentType(contentType) {
  if (!contentType) return true // no content-type header at all -- don't punish a server for omitting it; treat as usable, same as every existing caller's implicit assumption today.
  const ct = contentType.toLowerCase()
  return ct.includes('text/html') || ct.includes('application/xhtml+xml') || ct.includes('text/plain') || ct.includes('text/xml') || ct.includes('application/xml')
}

// checkRobotsAllowed(origin, targetUrl, fetcher, timeoutMs) -> boolean.
// Moved verbatim (2026-09-01) from lib/citedPageInspection.js's
// isPathAllowedByRobots -- same minimal, HONEST robots.txt check: only
// understands literal `User-agent: *` blocks and literal `Disallow:`
// prefixes, no wildcard/`$` support. Fails OPEN (returns true / allowed)
// whenever robots.txt can't be fetched or parsed, or on any ambiguity --
// this exists to catch the common "block everything" case, not to be a
// complete robots.txt implementation, and an inability to fetch
// robots.txt must never itself block a legitimate inspection.
// lib/citedPageInspection.js now imports this rather than defining its
// own copy; its call site and behavior are unchanged.
async function checkRobotsAllowed(origin, targetUrl, fetcher, timeoutMs) {
  let path
  try { path = new URL(targetUrl).pathname || '/' } catch (e) { return true }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 4000))
  let res
  try {
    res = await fetcher(`${origin}/robots.txt`, { signal: controller.signal })
  } catch (e) {
    return true
  } finally {
    clearTimeout(timer)
  }
  if (!res || !res.ok) return true

  let text
  try { text = await res.text() } catch (e) { return true }

  const lines = text.split(/\r?\n/)
  let inWildcardBlock = false
  const disallows = []
  for (const rawLine of lines) {
    const line = rawLine.split('#')[0].trim()
    if (!line) continue
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim().toLowerCase()
    const value = line.slice(colonIdx + 1).trim()
    if (key === 'user-agent') {
      inWildcardBlock = value === '*'
    } else if (key === 'disallow' && inWildcardBlock && value) {
      disallows.push(value)
    }
  }
  return !disallows.some(prefix => path.startsWith(prefix))
}

// readBoundedText(res, maxBytes) -> { text, truncated }. Streams the body
// when the fetch implementation exposes one (real fetch()/undici does;
// simple test mocks that only implement `.text()` fall back to that,
// which is exactly what every existing test-mock `fetcher` in this repo
// already looks like -- see the Phase 2A inventory). Truncates rather
// than throwing: an oversized page still yields real partial evidence
// (the FETCH FAILURE ≠ ABSENCE OF EVIDENCE principle applies to size
// bounds too, not just network errors) rather than discarding everything
// fetched so far.
async function readBoundedText(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text()
    const byteLength = Buffer.byteLength(text, 'utf8')
    if (byteLength <= maxBytes) return { text, truncated: false }
    // Truncate by character count as a reasonable approximation when we
    // only have the fully-materialized string (no streaming available) --
    // good enough for a body that already exceeded a multi-megabyte cap.
    return { text: text.slice(0, maxBytes), truncated: true }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let received = 0
  let truncated = false
  let result = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maxBytes) {
        const allowed = Math.max(0, value.byteLength - (received - maxBytes))
        result += decoder.decode(value.subarray(0, allowed), { stream: true })
        truncated = true
        try { await reader.cancel() } catch (e) { /* best effort */ }
        break
      }
      result += decoder.decode(value, { stream: true })
    }
    result += decoder.decode()
  } finally {
    try { reader.releaseLock() } catch (e) { /* already released by cancel() above in the truncated path */ }
  }
  return { text: result, truncated }
}

// fetchWebPage(url, options) -> structured result, NEVER throws.
//
// options:
//   fetcher       (default: global fetch) -- same injectable-fetcher
//                 convention every checker in this repo already uses, for
//                 testability without real network calls.
//   timeoutMs     (default: 8000, matches lib/citedPageInspection.js)
//   maxBytes      (default: 5MB) -- body is truncated, not rejected, past this.
//   redirect      (default: 'follow') -- pass 'manual' to observe a raw
//                 3xx instead of having it silently followed (e.g. a
//                 future HTTPS-redirect check); this is caller policy,
//                 not something this module decides for every caller
//                 (see STEP 3 of the Phase 2A report).
//   respectRobots (default: false) -- OFF by default so migrating an
//                 existing caller here never makes it newly robots-aware
//                 (and therefore stricter) without that caller explicitly
//                 opting in. lib/citedPageInspection.js is the one caller
//                 that already was robots-aware before this module
//                 existed; it keeps that exact behavior by calling
//                 checkRobotsAllowed() itself rather than opting into
//                 this flag (see that file's migration comment) --
//                 respectRobots exists here for a genuinely NEW caller
//                 that wants consistent robots-aware fetching in one step.
//   requireHtml   (default: false) -- when true, a successful response
//                 whose content-type doesn't look like HTML/text becomes
//                 a 'non_html' failure instead of returned content. OFF
//                 by default because existing callers fetch non-HTML
//                 resources on purpose (sitemap.xml, robots.txt) and must
//                 not be newly rejected.
//   headers       (default: { 'User-Agent': DEFAULT_USER_AGENT })
//
// Returns:
//   { requestedUrl, finalUrl, redirected, status, contentType, html,
//     fetchState: 'success'|'failed', failureCategory, failureDetail,
//     robotsState: 'not_checked'|'allowed'|'disallowed',
//     truncated, checkedAt }
async function fetchWebPage(url, options = {}) {
  const {
    fetcher = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    redirect = 'follow',
    respectRobots = false,
    requireHtml = false,
    headers = { 'User-Agent': DEFAULT_USER_AGENT }
  } = options

  const checkedAt = nowIso()
  const base = {
    requestedUrl: url, finalUrl: null, redirected: false, status: null,
    contentType: null, html: null, robotsState: 'not_checked', truncated: false, checkedAt
  }

  let origin
  try { origin = new URL(url).origin } catch (e) {
    return { ...base, fetchState: 'failed', failureCategory: 'invalid_url', failureDetail: 'The URL could not be parsed.' }
  }

  if (respectRobots) {
    const allowed = await checkRobotsAllowed(origin, url, fetcher, timeoutMs).catch(() => true)
    if (!allowed) {
      return { ...base, robotsState: 'disallowed', fetchState: 'failed', failureCategory: 'robots_blocked', failureDetail: 'robots.txt disallows this path.' }
    }
  }
  const robotsState = respectRobots ? 'allowed' : 'not_checked'

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  let res
  try {
    res = await fetcher(url, { signal: controller.signal, redirect, headers })
  } catch (err) {
    clearTimeout(timer)
    if (timedOut || err.name === 'AbortError') {
      return { ...base, robotsState, fetchState: 'failed', failureCategory: 'timeout', failureDetail: `No response within ${timeoutMs}ms.` }
    }
    return { ...base, robotsState, fetchState: 'failed', failureCategory: 'network_failure', failureDetail: err.message || String(err) }
  }
  clearTimeout(timer)

  const finalUrl = res.url || url
  const redirected = !!res.redirected || (finalUrl !== url)
  const contentType = (res.headers && typeof res.headers.get === 'function') ? res.headers.get('content-type') : null

  if (!res.ok) {
    return {
      ...base, robotsState, finalUrl, redirected, status: res.status, contentType,
      fetchState: 'failed', failureCategory: categorizeHttpStatus(res.status),
      failureDetail: `HTTP ${res.status}`
    }
  }

  if (requireHtml && !looksLikeHtmlContentType(contentType)) {
    return {
      ...base, robotsState, finalUrl, redirected, status: res.status, contentType,
      fetchState: 'failed', failureCategory: 'non_html', failureDetail: `Content-Type "${contentType}" does not look like HTML/text.`
    }
  }

  let text, truncated
  try {
    ;({ text, truncated } = await readBoundedText(res, maxBytes))
  } catch (err) {
    return {
      ...base, robotsState, finalUrl, redirected, status: res.status, contentType,
      fetchState: 'failed', failureCategory: 'network_failure', failureDetail: `Body could not be read: ${err.message || err}`
    }
  }

  return {
    ...base, robotsState, finalUrl, redirected, status: res.status, contentType,
    html: text, truncated, fetchState: 'success', failureCategory: null, failureDetail: null
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BYTES, DEFAULT_USER_AGENT, FAILURE_CATEGORIES,
  categorizeHttpStatus, looksLikeHtmlContentType,
  checkRobotsAllowed, readBoundedText,
  fetchWebPage
}
