// SCHEMA PAGE PRIORITIZATION -- Phase A of the Schema page-workflow
// redesign (2026-09-02). Pure, network-free, zero dependencies (same
// discipline as lib/sitemapDiscovery.js and lib/urlIdentity.js).
//
// WHY THIS FILE EXISTS: lib/sitemapDiscovery.js's job ends at "here is a
// bounded, classified candidate universe of real pages." Deciding WHICH of
// those candidates an account manager should actually look at first is a
// separate concern -- one that needs the client's own confirmed business
// facts (primary/secondary services, geography), not just a URL. Keeping
// this a separate module (rather than folding it into sitemapDiscovery.js
// or checker.js) means: (a) sitemapDiscovery.js stays a pure page-discovery
// primitive with no Supabase/client-profile dependency at all; (b) this
// file is trivially unit-testable with plain fixtures, no network, no DB;
// (c) checker.js / runAudit.js / pillar_scores scoring are completely
// untouched by this phase -- prioritization runs entirely client-side in
// SchemaWizard.js against data it already has (the persisted candidate
// list) plus one already-existing API call (GET .../profile-fields) that
// this phase does not need to create.
//
// CATEGORICAL TIERS, NOT A NUMERIC SCORE -- deliberate. A hidden composite
// score (e.g. "0.73") invites false precision when most of the underlying
// signals are pattern-matches and heuristics, not measurements. Every page
// gets a named tier (CORE/COMMERCIAL/PROOF/CONTENT/LOW_PRIORITY/OTHER) plus
// a list of plain-English reasons -- an account manager can see exactly
// why a page landed where it did, and disagree with a specific reason
// rather than an opaque number.
//
// NO TRAFFIC/RANKING SIGNALS -- deliberate, not an oversight. This
// codebase has no page-level traffic, impressions, CTR, or ranking data
// anywhere (confirmed via a full repo audit: Ahrefs integration here is
// domain-aggregate only, and there is no Google Search Console
// integration at all). Faking a "search opportunity" number from
// domain-level data would misrepresent it as page-specific. This file
// only ever uses signals that are genuinely real and genuinely
// page-attributable: page type (from classification), sitemap-source
// evidence, and conservative slug matches against the client's own
// AM-CONFIRMED profile fields.
//
// "LIKELY," NEVER "CONFIRMED" -- client-intelligence matching here is
// slug/path token matching against confirmed business facts, not page
// content. A match is real prioritization signal, not proof of the page's
// actual subject -- every match reason says "Likely matches," never
// "confirmed primary service page." Stronger, content-based evidence
// (fetching the page's own HTML/title) is explicitly a later phase.

const PRIORITY_TIERS = ['CORE', 'COMMERCIAL', 'PROOF', 'CONTENT', 'LOW_PRIORITY', 'OTHER']

// tierForType(type) -> one of PRIORITY_TIERS. Deterministic, page-type ->
// tier mapping -- no scoring, no ambiguity. Location pages default to
// COMMERCIAL: this classifier's Location pattern
// (/locations?|service-areas?|areas-we-serve/) inherently matches
// service-area LANDING pages (a commercial SEO construct), not a single
// canonical "our HQ address" entity page -- that latter concept isn't
// separately distinguishable from the URL alone today, so it isn't
// invented here. Worth revisiting once page content is actually read.
// 'Product' and 'Landing Page' added 2026-09-02 alongside the sitemap-
// provenance classification fix (lib/sitemapDiscovery.js's ROOT CAUSE #3):
// both are commercially-oriented page types, same tier as Service/Location.
const TIER_BY_TYPE = {
  Home: 'CORE',
  About: 'CORE',
  Contact: 'CORE',
  Service: 'COMMERCIAL',
  Location: 'COMMERCIAL',
  Product: 'COMMERCIAL',
  'Landing Page': 'COMMERCIAL',
  'Case Study': 'PROOF',
  Article: 'CONTENT',
  'Utility/Legal': 'LOW_PRIORITY',
  Other: 'OTHER'
}

function tierForType(type) {
  return TIER_BY_TYPE[type] || 'OTHER'
}

// BASE_REASON_BY_TYPE -- the one always-present "page_type" reason. Every
// page gets exactly one of these, regardless of any client-intelligence
// match, so a page never shows zero reasons.
const BASE_REASON_BY_TYPE = {
  Home: 'Homepage',
  About: 'Core entity page (About)',
  Contact: 'Core entity page (Contact)',
  Service: 'Commercial service page',
  Location: 'Commercial location / service-area page',
  Product: 'Commercial product page',
  'Landing Page': 'Commercial landing page',
  'Case Study': 'Case study / proof page',
  Article: 'Article / content page',
  'Utility/Legal': 'Utility or legal page (low priority)',
  Other: 'Page type not resolved'
}

// -----------------------------------------------------------------------
// CLIENT-INTELLIGENCE MATCHING -- conservative, deterministic, phrase-level
// (never single generic-token) slug matching against a client's AM-
// CONFIRMED primary/secondary services and geography markets (Phase 1b's
// client_profile_fields, reused as-is -- see lib/clientIndustryIntelligence.js).
// -----------------------------------------------------------------------

// A short, genuinely generic stopword list -- filtered out of BOTH the
// confirmed phrase and the page path before matching, so neither side can
// produce a false match purely off a word like "services" or "the". This
// is intentionally short (never a broad heuristic) -- same discipline as
// lib/urlIdentity.js's KNOWN_TRACKING_PARAM_NAMES list.
const STOPWORDS = new Set(['and', 'the', 'of', 'for', 'a', 'an', 'in', 'on', 'at', 'to', 'with', 'services', 'service'])
const MIN_TOKEN_LENGTH = 3

// tokenize(str) -> string[] of lowercase, stopword-and-short-token-filtered
// words. Splits ONLY on non-alphanumeric boundaries -- "webinar" is never
// treated as containing "web" (no substring/fuzzy matching anywhere in
// this file), which is exactly what keeps a confirmed service like "Web
// Design" from false-matching a page like /webinar-design-tips/.
function tokenize(str) {
  return String(str || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(t))
}

function pageTokens(page) {
  return tokenize(String(page?.path || '').replace(/[/]/g, ' '))
}

// phraseMatchesPage(phraseTokens, pageTokenSet) -> boolean. Requires EVERY
// significant token of the confirmed phrase to appear in the page's token
// set -- a full-phrase subset match, not "any one token overlaps." This is
// the actual false-positive guard: a confirmed geography "Denver, CO"
// (tokens: ['denver'] once the 2-char 'co' is filtered) matching a page
// about "/denver-events-calendar/" is accepted (the one remaining token IS
// present) since a single-word confirmed value has nothing stronger to
// require: but a confirmed service "Denver SEO" (tokens: ['denver','seo'])
// correctly REJECTS "/denver-events-calendar/" (no 'seo' token present),
// and a confirmed service "Web Design" never matches "/webinar-design/"
// (no whole 'web' token present, only 'webinar'). An empty token list
// (e.g. a confirmed value of just "Services") is never matchable at all --
// nothing distinctive to require.
function phraseMatchesPage(phraseTokens, pageTokenSet) {
  if (phraseTokens.length === 0) return false
  return phraseTokens.every(t => pageTokenSet.has(t))
}

// matchClientIntelligence(page, clientProfile) -> reason[] (0 or more)
// clientProfile: { primaryServices: string[], secondaryServices: string[],
//   geographies: string[] } -- plain confirmed-value strings; the caller
// (SchemaWizard.js) is responsible for fetching and filtering these to
// AM-CONFIRMED entries only (confirmation_status === 'confirmed') before
// calling in -- this file has no Supabase/network dependency and trusts
// whatever it's given, same as every other pure module in this project.
function matchClientIntelligence(page, clientProfile = {}) {
  const pageTokenSet = new Set(pageTokens(page))
  const reasons = []

  function checkList(list, matchType, label) {
    for (const phrase of list || []) {
      if (!phrase) continue
      const tokens = tokenize(phrase)
      if (phraseMatchesPage(tokens, pageTokenSet)) {
        reasons.push({
          kind: 'client_intelligence',
          matchType,
          confidence: 'likely',
          text: `Likely matches ${label}: ${phrase}`
        })
      }
    }
  }

  checkList(clientProfile.primaryServices, 'primary_service', 'primary service')
  checkList(clientProfile.secondaryServices, 'secondary_service', 'secondary service')
  checkList(clientProfile.geographies, 'geography', 'primary geography')

  return reasons
}

// buildPageDossier(page, clientProfile) -> { ...page, tier, reasons[] }
// `reasons` always has at least one entry (the base page-type reason);
// sitemap-source evidence and client-intelligence matches are appended
// when present. Every reason is honest about its own confidence -- never
// "confirmed" for anything derived from slug matching alone.
function buildPageDossier(page, clientProfile = {}) {
  const tier = tierForType(page.type)
  const reasons = [{
    kind: 'page_type',
    confidence: page.classificationConfidence || 'low',
    text: BASE_REASON_BY_TYPE[page.type] || 'Page type not resolved'
  }]

  if (page.classificationSource === 'sitemap_name' && page.classificationReason) {
    reasons.push({ kind: 'sitemap_evidence', confidence: page.classificationConfidence || 'low', text: page.classificationReason })
  }

  reasons.push(...matchClientIntelligence(page, clientProfile))

  return { ...page, tier, reasons }
}

function hasClientIntelligenceMatch(dossier) {
  return dossier.reasons.some(r => r.kind === 'client_intelligence')
}

const TIER_RANK = { CORE: 0, COMMERCIAL: 1, PROOF: 2, CONTENT: 3, LOW_PRIORITY: 4, OTHER: 5 }

// computeRecommendedSet(pages, clientProfile, opts) ->
//   { recommended: dossier[], all: dossier[], targetMin, targetMax }
//
// `all` is every discovered candidate, classified and dossier'd, in a
// stable deterministic order (tier, then client-intelligence match first,
// then path -- never random, never "as discovered"). `recommended` is a
// SUBSET of `all`, built by walking that same deterministic order and
// taking pages worth surfacing:
//   - CORE, COMMERCIAL, PROOF pages are always eligible.
//   - CONTENT (Article) pages are eligible ONLY when they carry a real
//     reason beyond just "this is an article" -- i.e. a client-
//     intelligence match. A generic blog post with no such match is never
//     added just to pad the list toward targetMax (per explicit product
//     direction: "Do not fill the recommendation set with random blog
//     posts just to hit 15").
//   - LOW_PRIORITY and OTHER pages are never recommended.
// The walk simply STOPS once nothing eligible remains -- fewer than
// targetMin legitimate recommendations is a real, valid, expected outcome
// for a small site, never padded to reach it.
function computeRecommendedSet(pages, clientProfile = {}, { targetMin = 10, targetMax = 15 } = {}) {
  const dossiers = (pages || []).map(p => buildPageDossier(p, clientProfile))

  const sorted = [...dossiers].sort((a, b) => {
    const tierDiff = TIER_RANK[a.tier] - TIER_RANK[b.tier]
    if (tierDiff !== 0) return tierDiff
    const aMatch = hasClientIntelligenceMatch(a) ? 0 : 1
    const bMatch = hasClientIntelligenceMatch(b) ? 0 : 1
    if (aMatch !== bMatch) return aMatch - bMatch
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  })

  const recommended = []
  for (const dossier of sorted) {
    if (recommended.length >= targetMax) break
    if (dossier.tier === 'LOW_PRIORITY' || dossier.tier === 'OTHER') continue
    if (dossier.tier === 'CONTENT' && !hasClientIntelligenceMatch(dossier)) continue
    recommended.push(dossier)
  }

  return { recommended, all: sorted, targetMin, targetMax }
}

module.exports = {
  PRIORITY_TIERS,
  tierForType,
  tokenize,
  matchClientIntelligence,
  buildPageDossier,
  computeRecommendedSet
}
