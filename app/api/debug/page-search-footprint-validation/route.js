const { getSupabaseServerClient } = require('../../../../lib/supabaseServer')
const { fetchSitemapPages } = require('../../../../lib/sitemapDiscovery')
const { getOrganicKeywords } = require('../../../../lib/checkers/ahrefs')
const { buildPageSearchFootprint, UNMATCHED_REASONS } = require('../../../../lib/pageSearchFootprint')

// ============================================================================
// TEMPORARY VALIDATION-ONLY ROUTE -- added 2026-09-02, NOT permanent product
// surface. Delete this file (and this directory) once the one-off
// real-client validation of lib/pageSearchFootprint.js is complete.
//
// WHY THIS EXISTS: the requested real-client validation needs a real
// AHREFS_API_KEY + SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY and real network
// access to api.ahrefs.com. This project's owner does not run a local dev
// environment with those credentials -- Vercel Production/Preview already
// has them, so this route runs the exact same validation server-side there.
//
// READ-ONLY / SIDE-EFFECT-FREE, same discipline as the ONEOFF validation
// script this route mirrors (ONEOFF-validate-page-search-footprint.js,
// never committed):
//   - Reads from the `clients` table only (a single .select(), no writes).
//   - Calls lib/sitemapDiscovery.js#fetchSitemapPages -- GET requests to the
//     client's own public sitemap.xml only.
//   - Calls lib/checkers/ahrefs.js#getOrganicKeywords -- the exact same
//     Ahrefs call the app already makes elsewhere, unmodified, read-only.
//   - Calls lib/pageSearchFootprint.js#buildPageSearchFootprint -- pure,
//     in-memory, no I/O of its own.
// Does not write to Supabase, call runAudit(), touch SchemaWizard/
// schemaPagePriority/opportunity logic, or create any new product behavior.
//
// NO AUTH GATE (deliberate, by explicit owner request): this route is
// UNPROTECTED on the public production domain. Anyone who finds this exact
// URL can trigger it -- each hit calls the real, paid Ahrefs API and
// returns real client ranking data in the JSON response. This is meant to
// exist for MINUTES, not days: run the validation once, capture the
// output, then delete this file (and this directory) in a follow-up
// commit immediately after. Do not leave this deployed.
//
// USAGE: GET /api/debug/page-search-footprint-validation
//        GET /api/debug/page-search-footprint-validation?client=<domainOrIdOrUrlFragment>
// With no `client` param, evaluates up to MAX_CANDIDATES_TO_EVALUATE clients
// (to bound real Ahrefs API cost) and picks whichever has the most
// page-attributable ranking evidence.

const maxDuration = 120

const MAX_CANDIDATES_TO_EVALUATE = 5

function normalizeUrl(url) {
  let u = url.trim()
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  return u.replace(/\/$/, '')
}

async function GET(request) {
  try {
    const apiKey = process.env.AHREFS_API_KEY
    if (!apiKey) {
      return Response.json({ error: 'AHREFS_API_KEY is not set on this environment.' }, { status: 500 })
    }

    const supabase = getSupabaseServerClient()
    const { data: clients, error } = await supabase.from('clients').select('id, name, domain, url')
    if (error) return Response.json({ error: `Supabase error reading clients table: ${error.message}` }, { status: 500 })
    if (!clients || clients.length === 0) return Response.json({ error: 'No clients found in the clients table.' }, { status: 404 })

    const { searchParams } = new URL(request.url)
    const wanted = searchParams.get('client')
    let candidates = clients.filter(c => c.url || c.domain)
    let note = null
    if (wanted) {
      candidates = candidates.filter(c => c.domain === wanted || c.id === wanted || (c.url || '').includes(wanted))
      if (candidates.length === 0) return Response.json({ error: `No client matched "${wanted}".` }, { status: 404 })
    } else if (candidates.length > MAX_CANDIDATES_TO_EVALUATE) {
      note = `No client specified -- evaluated only the first ${MAX_CANDIDATES_TO_EVALUATE} of ${candidates.length} clients to bound real Ahrefs API cost. Pass ?client=domainOrIdOrFragment to target a specific client instead.`
      candidates = candidates.slice(0, MAX_CANDIDATES_TO_EVALUATE)
    }

    const evaluated = []
    let best = null
    for (const client of candidates) {
      const url = client.url || `https://${client.domain}`
      const domain = client.domain || (() => { try { return new URL(normalizeUrl(url)).hostname } catch (e) { return null } })()
      const entry = { name: client.name || null, domain: domain || null }
      if (!domain) { entry.skipped = 'no usable domain'; evaluated.push(entry); continue }

      let sitemapResult = null
      try {
        sitemapResult = await fetchSitemapPages(`${normalizeUrl(url)}/sitemap.xml`)
      } catch (e) {
        entry.sitemapError = e.message
      }
      if (!sitemapResult) { entry.skipped = entry.sitemapError ? `sitemap fetch threw: ${entry.sitemapError}` : 'no usable sitemap found at /sitemap.xml'; evaluated.push(entry); continue }
      entry.sitemapPageCount = sitemapResult.pages.length
      entry.sitemapRealTotal = sitemapResult.count
      entry.sitemapTruncated = sitemapResult.truncated

      let keywordRows = []
      try {
        keywordRows = await getOrganicKeywords(domain, { apiKey, limit: 100 })
      } catch (e) {
        entry.ahrefsError = e.message
      }
      const withUrl = keywordRows.filter(r => r.rankingUrl)
      entry.ahrefsRowCount = keywordRows.length
      entry.ahrefsRowsWithRankingUrl = withUrl.length
      evaluated.push(entry)

      if (!best || withUrl.length > best.withUrlCount) {
        best = { client, domain, sitemapResult, keywordRows, withUrlCount: withUrl.length }
      }
    }

    if (!best || best.withUrlCount === 0) {
      return Response.json({
        error: 'No candidate client had BOTH a usable sitemap AND Ahrefs organic-keyword rows carrying a rankingUrl. Cannot validate without real page-attributable evidence for at least one client.',
        evaluated,
        note
      }, { status: 422 })
    }

    const { sitemapResult, keywordRows } = best
    const footprint = buildPageSearchFootprint({ sitemapPages: sitemapResult.pages, organicKeywordRows: keywordRows })

    const rowsWithUrl = keywordRows.filter(r => r.rankingUrl)
    const uniqueRankingUrls = new Set(rowsWithUrl.map(r => r.rankingUrl))
    const matchedUniqueUrls = new Set()
    for (const page of footprint.pages) for (const obs of page.rankingObservations) if (obs.rankingUrl) matchedUniqueUrls.add(obs.rankingUrl)

    const reasonCounts = {}
    for (const reasonKey of Object.values(UNMATCHED_REASONS)) reasonCounts[reasonKey] = 0
    for (const u of footprint.unmatchedRankingEvidence) reasonCounts[u.reason] = (reasonCounts[u.reason] || 0) + 1

    const matchedPages = footprint.pages
      .filter(p => p.hasObservedRankings)
      .sort((a, b) => b.keywordCount - a.keywordCount)
      .slice(0, 10)
      .map(p => ({
        path: p.path,
        url: p.url,
        keywordCount: p.keywordCount,
        strongestPosition: p.strongestPosition,
        positionBand: p.positionBand,
        observedVolume: p.observedVolume,
        exampleKeywords: p.rankingObservations.slice(0, 5).map(o => ({ keyword: o.keyword, position: o.position, volume: o.volume }))
      }))

    const noRankingPages = footprint.pages
      .filter(p => !p.hasObservedRankings)
      .slice(0, 10)
      .map(p => ({ path: p.path, url: p.url, positionBand: p.positionBand }))

    const sampleNotInSitemap = footprint.unmatchedRankingEvidence
      .filter(u => u.reason === UNMATCHED_REASONS.NOT_IN_SITEMAP)
      .slice(0, 10)

    return Response.json({
      note,
      evaluated,
      selectedClient: { name: best.client.name || null, domain: best.domain },
      B_totalSitemapPagesDiscovered: sitemapResult.pages.length,
      sitemapRealTotal: sitemapResult.count,
      sitemapTruncated: sitemapResult.truncated,
      C_totalAhrefsOrganicKeywordRows: keywordRows.length,
      D_rowsWithBestPositionUrl: rowsWithUrl.length,
      E_uniqueRankingUrls: uniqueRankingUrls.size,
      F_matchedRowCount: footprint.meta.matchedRowCount,
      F_uniqueMatchedRankingUrls: matchedUniqueUrls.size,
      G_unmatchedByReason: reasonCounts,
      H_rankingRowMatchRate: `${footprint.meta.matchedRowCount} / ${rowsWithUrl.length}`,
      H_uniqueRankingUrlMatchRate: `${matchedUniqueUrls.size} / ${uniqueRankingUrls.size}`,
      I_sampleNotInSitemap: sampleNotInSitemap,
      J_representativeMatchedPages: matchedPages,
      K_representativeNoObservedRankingsPages: noRankingPages,
      meta: footprint.meta
    })
  } catch (err) {
    return Response.json({ error: err.message, stack: err.stack }, { status: 500 })
  }
}

module.exports = { GET, maxDuration }
