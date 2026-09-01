// AI SOURCE & CITATION PRESENCE -- first real pillar built on top of the
// Phase 3 shared opportunity lifecycle (lib/opportunityLifecycle.js).
// Added 2026-08-18.
//
// WHAT THIS PILLAR ANSWERS (and does NOT answer -- see the approved spec):
//   Which third-party sources does AI actually rely on for this client's
//   commercially important topics? Is the client present on those sources?
//   Is the client present in the SPECIFIC content AI is actually citing?
//   Where does a legitimate, actionable source-presence opportunity exist?
// This is explicitly NOT a backlink checker, a directory checklist, a
// generic citation score, a competitor-presence filter, or an "everyone
// should be on Yelp" engine -- sources come from OBSERVED AI citation
// behavior, never a hardcoded list.
//
// DATA SOURCE OF TRUTH -- audited before writing any of this:
//   ai_visibility_tracked_runs (see lib/trackAiVisibility.js /
//   lib/checkers/ai-visibility-checker.js) is the ONLY real, live
//   per-response AI observation data in this project: client_id, engine,
//   run_at, brand_mentioned, sentiment, raw.prompt, raw.responseSnippet,
//   raw.sourceUrls, raw.ownDomainSourceUrls, raw.thirdPartySourceUrls,
//   raw.bestListCited. This module reads those rows as-is and does NOT
//   duplicate or reimplement that extraction -- it is the raw observation
//   layer this pillar is built on, per the approved spec's explicit
//   instruction to preserve raw observations as the source of truth and
//   extend only where necessary.
//
// KNOWN GAP, DISCLOSED RATHER THAN PAPERED OVER: the approved spec's
// SOURCE OBSERVATION MODEL asks for each observation to conceptually
// include TOPIC CLUSTER and PROMPT VARIATION. ai_visibility_tracked_runs
// has neither column -- it predates Phase 2's topic_clusters/
// prompt_variations tables and was never given a foreign key to either
// (confirmed directly: no topic_cluster_id/prompt_variation_id column
// exists on that table, and Phase 2's prompt_variations system is
// confirmed NOT YET wired into any real execution/tracking loop at all --
// see app/api/prompt-testing/due & mark-tested's own header comments,
// "operational and callable... the future tracking architecture will
// consume this"). This is a genuine architecture gap, not a "genuine
// technical contradiction" that blocks this implementation -- the fix
// chosen here is the smallest safe one: `topics_observed` on client_sources
// stores the raw free-text prompt strings actually observed (real
// evidence, honestly labeled as free text) rather than fabricating a topic-
// cluster linkage that doesn't exist in the underlying data. No new column
// was added to the live ai_visibility_tracked_runs table -- that table is
// real, live, weekly-cron-written production data (same care Phase 3 took
// with lib/opportunities.js) and doesn't need a schema change for this
// pillar to work correctly.
//
// SOURCE vs COMPETITOR, reused not reinvented: lib/nonCompetitorDomains.js
// already answers "is this domain a real third-party SOURCE (directory,
// review platform, press, social, aggregator) or a competing BUSINESS."
// This pillar's whole domain-classification boundary is exactly that
// existing function (isNonCompetitorDomain) -- a domain that already gets
// filtered OUT of competitor detection is exactly the shape of domain this
// pillar treats as a candidate SOURCE. lib/authorityDomains.js's curated
// list is reused too, as one input to relationship-type classification and
// as the only domain set this project can currently check real backlinks
// against (see lib/checkers/ahrefs.js#getAuthorityBacklinks) -- deliberately
// NOT extended with a new general "check backlinks from any specific
// domain" Ahrefs integration, since "specialized platform integrations"
// are explicitly out of MVP scope; presence detection for sources outside
// that curated list honestly falls back to 'unknown' rather than a new,
// unbuilt capability.
//
// MODULE SHAPE -- mirrors lib/opportunityLifecycle.js's own split:
// pure, DB-free functions first (independently unit-testable, no
// SUPABASE_SERVICE_ROLE_KEY required), then the I/O functions that read/
// write client_sources and drive the shared opportunity lifecycle.
//
// NO UNIVERSAL SCORE anywhere in this file. observed_importance,
// actionability, and effort are always {level, reasoning, evidenceRefs}
// -- qualitative, evidence-explained, never collapsed into one number.

const { getSupabaseServerClient } = require('./supabaseServer')
const { isNonCompetitorDomain, hostnameOf, normalizeDomain } = require('./nonCompetitorDomains')
const { getAuthorityBacklinks } = require('./checkers/ahrefs')
const {
  qualifyOpportunity, setPriorityTreatment, markStrengthProtect, rejectOpportunity,
  buildPriorityAssessment, prepareWork, submitForApproval,
  getPriorityDimensions, computeStatusTrack, PREPARED_WORK_TABLE
} = require('./opportunityLifecycle')
const { inspectCitedUrlsForClient, CITED_PAGE_INSPECTIONS_TABLE } = require('./citedPageInspection')

const CLIENT_SOURCES_TABLE = 'client_sources'

const RELATIONSHIP_TYPES = [
  'Profile / Listing', 'Review Page', 'Editorial Mention', 'Ranking / List',
  'Association Membership', 'Expert Contribution', 'Recommendation', 'Video', 'Other'
]

// EVIDENCE-STRENGTH CORRECTION (2026-08-17) -- PRESENCE_STATUSES/
// PRESENCE_CONFIDENCE below replace the original 5-status/3-confidence set.
// The original 'appears_in_cited_content' status was awarded from mere
// AI-RESPONSE CO-OCCURRENCE (client mentioned + source cited in the SAME
// response) -- that proves the two showed up together in one answer, not
// that the cited page itself contains the client. The name implied
// page-level verification it never actually had. This is now split into
// two honestly-distinct states:
//   - 'ai_response_co_occurrence' (weak, response-level -- what the old
//     'appears_in_cited_content' actually was)
//   - 'appears_in_cited_content_verified' (strong, page-level -- the ACTUAL
//     cited URL was fetched and the client entity was found on it; see
//     lib/citedPageInspection.js)
// 'client_owned_page_cited' is unchanged -- that was always a genuinely
// strong signal (a URL on the client's OWN domain being directly cited).
const PRESENCE_STATUSES = [
  'absent', 'source_presence_only', 'ai_response_co_occurrence',
  'appears_in_cited_content_verified', 'client_owned_page_cited', 'unknown'
]
const PRESENCE_CONFIDENCE = [
  'verified_by_page_fetch', 'inferred_from_ai_co_occurrence', 'inferred_from_backlink', 'unknown'
]
const IMPORTANCE_LEVELS = ['high', 'medium', 'low']

// Historical/back-compat aliases: some older persisted rows and any code
// that hasn't been migrated yet may still reference the pre-correction
// names. Kept purely as a reference map for that migration (see the
// `correct_source_citation_evidence_states` Supabase migration) -- NOT
// used anywhere in this file's own logic, which only ever produces/reads
// the corrected names above.
const PRE_CORRECTION_STATUS_RENAME = { appears_in_cited_content: 'ai_response_co_occurrence' }
const PRE_CORRECTION_CONFIDENCE_RENAME = { confirmed_by_ai_citation: 'inferred_from_ai_co_occurrence' }

// ---------------------------------------------------------------------
// PURE LOGIC -- no DB, no LLM. See lib/sourceCitation.pure.test.js.
// ---------------------------------------------------------------------

// Heuristic-only relationship classification -- pattern matching against
// small, honest, evolvable domain sets (same "curated list, expand as real
// evidence surfaces it" philosophy as lib/authorityDomains.js), NEVER an
// LLM call. A source not matching any known pattern is 'Other' -- an
// honest "we don't know the relationship shape yet," not a guess.
const REVIEW_PLATFORM_DOMAINS = new Set(['yelp.com', 'trustpilot.com', 'g2.com', 'glassdoor.com', 'capterra.com', 'goodfirms.co', 'healthgrades.com', 'angi.com', 'homeadvisor.com', 'avvo.com'])
const RANKING_LIST_DOMAINS = new Set(['designrush.com', 'zoominfo.com', 'techfinder.net', 'agencies.semrush.com', 'expertise.com', 'clutch.co'])
const EDITORIAL_DOMAINS = new Set(['forbes.com', 'inc.com', 'entrepreneur.com', 'businessinsider.com', 'usnews.com', 'nytimes.com', 'wsj.com', 'bloomberg.com', 'reuters.com', 'techcrunch.com', 'fastcompany.com', 'coloradoan.com'])
const PROFILE_LISTING_DOMAINS = new Set(['linkedin.com', 'facebook.com', 'instagram.com', 'bbb.org', 'google.com', 'about.me'])
const VIDEO_DOMAINS = new Set(['youtube.com', 'tiktok.com'])
const ASSOCIATION_HINT_PATTERN = /association|chamber|society|institute|guild/i

function classifyRelationshipType(domain) {
  if (!domain) return 'Other'
  if (VIDEO_DOMAINS.has(domain)) return 'Video'
  if (REVIEW_PLATFORM_DOMAINS.has(domain)) return 'Review Page'
  if (RANKING_LIST_DOMAINS.has(domain)) return 'Ranking / List'
  if (EDITORIAL_DOMAINS.has(domain)) return 'Editorial Mention'
  if (PROFILE_LISTING_DOMAINS.has(domain)) return 'Profile / Listing'
  if (ASSOCIATION_HINT_PATTERN.test(domain)) return 'Association Membership'
  return 'Other'
}

// buildRowSourceView(row, {competitorDomains}) -> normalizes one
// ai_visibility_tracked_runs row into the shape every other pure function
// in this file consumes. competitorDomains is a Set of normalized
// competitor hostnames (client_competitors.domain) -- used ONLY to surface
// competitor co-citation as SUPPORTING evidence (never a qualification
// gate, per the approved spec).
function buildRowSourceView(row, { competitorDomains = new Set() } = {}) {
  const raw = row.raw || {}
  const ownUrls = Array.isArray(raw.ownDomainSourceUrls) ? raw.ownDomainSourceUrls : []
  const allUrls = Array.isArray(raw.sourceUrls) ? raw.sourceUrls : []
  const thirdPartyUrls = Array.isArray(raw.thirdPartySourceUrls)
    ? raw.thirdPartySourceUrls
    : allUrls.filter(u => !ownUrls.includes(u))

  // A "source" candidate is any third-party URL whose domain is NOT a real
  // competing business, per the existing, already-battle-tested
  // isNonCompetitorDomain() classification -- reused, not reinvented (see
  // module header). Anything isNonCompetitorDomain rejects is a candidate
  // competing business, which is competitorDetection.js's job, not this
  // pillar's.
  const sourceDomains = [...new Set(
    thirdPartyUrls.map(hostnameOf).filter(Boolean).filter(d => isNonCompetitorDomain(`https://${d}`))
  )]
  const competitorDomainsCited = [...new Set(
    thirdPartyUrls.map(hostnameOf).filter(Boolean).filter(d => competitorDomains.has(d))
  )]

  return {
    rowId: row.id,
    engine: row.engine,
    runAt: row.run_at,
    prompt: raw.prompt || null,
    responseSnippet: raw.responseSnippet || null,
    brandMentioned: !!row.brand_mentioned,
    sentiment: row.sentiment || null,
    bestListCited: !!raw.bestListCited,
    ownUrls,
    sourceDomains,
    sourceUrls: thirdPartyUrls,
    competitorDomainsCited
  }
}

// aggregateSourceObservations(rowViews) -> Map<domain, aggregate>. One
// entry per OBSERVED source domain -- a domain never seen isn't a row in
// this map at all (this pillar never invents a source from a curated list;
// see module header).
function aggregateSourceObservations(rowViews) {
  const byDomain = new Map()
  for (const rv of rowViews) {
    for (const domain of rv.sourceDomains) {
      if (!byDomain.has(domain)) {
        byDomain.set(domain, {
          domain, citationCount: 0, engines: new Set(), prompts: new Set(), urls: new Set(),
          firstObservedAt: rv.runAt, lastObservedAt: rv.runAt, anyBestList: false,
          rowViewsCiting: []
        })
      }
      const agg = byDomain.get(domain)
      agg.citationCount += 1
      agg.engines.add(rv.engine)
      if (rv.prompt) agg.prompts.add(rv.prompt)
      for (const u of rv.sourceUrls) { if (hostnameOf(u) === domain) agg.urls.add(u) }
      if (rv.runAt && (!agg.firstObservedAt || new Date(rv.runAt) < new Date(agg.firstObservedAt))) agg.firstObservedAt = rv.runAt
      if (rv.runAt && (!agg.lastObservedAt || new Date(rv.runAt) > new Date(agg.lastObservedAt))) agg.lastObservedAt = rv.runAt
      if (rv.bestListCited) agg.anyBestList = true
      agg.rowViewsCiting.push(rv)
    }
  }
  return byDomain
}

// computeObservedImportance(agg, {industryEvidence}) -> {level, reasoning,
// evidenceRefs}. Deliberately a small, EXPLICIT, documented rubric -- not a
// weighted formula -- per the approved spec's "do not finalize a universal
// numeric formula" instruction. Client-specific evidence is checked FIRST
// and is always the strongest signal; industry-level evidence (see
// computeIndustryEvidence below) only ever substitutes when the client's
// own sample is thin (agg is null/zero), never overrides real client
// evidence.
function computeObservedImportance(agg, { industryEvidence = null } = {}) {
  const citationCount = agg ? agg.citationCount : 0
  const engineBreadth = agg ? agg.engines.size : 0
  const promptBreadth = agg ? agg.prompts.size : 0
  const reasons = []
  let level

  if (citationCount >= 8 && engineBreadth >= 2) {
    level = 'high'
    reasons.push(`cited ${citationCount} time(s) across ${engineBreadth} AI engines and ${promptBreadth} distinct prompt(s) -- repeated, cross-engine client-specific evidence`)
  } else if (citationCount >= 3 || engineBreadth >= 2 || promptBreadth >= 2) {
    level = 'medium'
    reasons.push(`cited ${citationCount} time(s) across ${engineBreadth} engine(s) and ${promptBreadth} distinct prompt(s) -- real but not yet repeated/broad client-specific evidence`)
  } else if (citationCount >= 1) {
    level = 'low'
    reasons.push(`observed once, in ${engineBreadth} engine(s) -- thin client-specific evidence`)
  } else if (industryEvidence && industryEvidence.observedAcrossClients > 0) {
    level = 'medium'
    reasons.push(`no client-specific observation yet, but industry-level evidence substitutes: ${industryEvidence.note}`)
  } else {
    level = 'low'
    reasons.push('no client-specific or industry-level evidence observed for this source')
  }
  if (agg && agg.anyBestList) reasons.push('appeared in a best/top/recommended-list style AI answer at least once')

  return {
    level,
    reasoning: reasons.join('; ') + '.',
    evidenceRefs: {
      citationCount, engineCount: engineBreadth, promptCount: promptBreadth,
      bestListCited: !!(agg && agg.anyBestList),
      provenance: citationCount > 0 ? 'client_specific' : (industryEvidence && industryEvidence.observedAcrossClients > 0 ? 'industry_level' : 'none')
    }
  }
}

// Cap on how many raw evidence entries determineClientPresence stores per
// source. Real data surfaced this: a frequently-cited source (e.g. 133
// separate tracked-run citations for one domain) would otherwise write an
// unbounded jsonb array on every sync. The full, uncapped history always
// stays queryable in ai_visibility_tracked_runs itself (the true raw
// source of truth per this file's header) -- this cap only bounds what
// client_sources/opportunities store as a representative drill-down
// sample, most-recent-first, with the true total count preserved alongside
// so nothing is silently hidden.
const MAX_STORED_PRESENCE_EVIDENCE = 10

// determineClientPresence({domain, rowViewsCiting, authorityBacklinkDomains,
// citedPageInspections}) -> {status, confidence, evidence,
// totalMatchingObservations, domainPresenceNote}. EVIDENCE-STRENGTH
// CORRECTION (2026-08-17): page-level VERIFIED presence is now checked
// FIRST and is the only path to the strong 'appears_in_cited_content_verified'
// state; mere response-level co-occurrence is demoted to its own, honestly
// weaker 'ai_response_co_occurrence' state and can never be promoted into
// the verified one. Never infers a confident state from a weak signal --
// see PRESENCE_CONFIDENCE and the module header's note on why
// backlink-based presence is capped at 'inferred_from_backlink'.
function determineClientPresence({ domain, rowViewsCiting = [], authorityBacklinkDomains = [], citedPageInspections = [] }) {
  const hasDomainBacklink = authorityBacklinkDomains.includes(domain)

  // State (strongest): an actual cited URL was fetched and inspected (see
  // lib/citedPageInspection.js) and the client entity was genuinely found
  // on the page. This is the ONLY way to reach this state -- co-occurrence
  // in an AI response is never enough on its own, no matter how many times
  // it's observed.
  const verifiedPresent = citedPageInspections.filter(i => i.verificationStatus === 'verified_present')
  if (verifiedPresent.length > 0) {
    const mostRecentFirst = [...verifiedPresent].sort((a, b) => new Date(b.checkedAt) - new Date(a.checkedAt))
    return {
      status: 'appears_in_cited_content_verified',
      confidence: 'verified_by_page_fetch',
      totalMatchingObservations: verifiedPresent.length,
      evidence: mostRecentFirst.slice(0, MAX_STORED_PRESENCE_EVIDENCE).map(i => ({
        url: i.url, relationshipType: i.relationshipType || null, snippet: i.snippet || null, checkedAt: i.checkedAt
      })),
      domainPresenceNote: null
    }
  }

  // State (weaker, disclosed as such): a response that mentioned the client
  // ALSO cited this source. Caveat (disclosed, not hidden): this is
  // club-level evidence ("this source appeared in an answer that also
  // named the client"), NOT page-level proof that the cited content is
  // SPECIFICALLY about the client -- that is exactly the distinction this
  // correction exists to make honest. The raw prompt/response snippet is
  // preserved on every returned evidence entry specifically so an AM can
  // drill down and confirm; full, uncapped history remains queryable in
  // ai_visibility_tracked_runs.
  const citedWhileDiscussingClient = rowViewsCiting.filter(rv => rv.brandMentioned)
  if (citedWhileDiscussingClient.length > 0) {
    const mostRecentFirst = [...citedWhileDiscussingClient].sort((a, b) => new Date(b.runAt) - new Date(a.runAt))
    const anyVerifiedAbsent = citedPageInspections.some(i => i.verificationStatus === 'verified_absent')
    return {
      status: 'ai_response_co_occurrence',
      confidence: 'inferred_from_ai_co_occurrence',
      totalMatchingObservations: citedWhileDiscussingClient.length,
      evidence: mostRecentFirst.slice(0, MAX_STORED_PRESENCE_EVIDENCE).map(rv => ({ engine: rv.engine, runAt: rv.runAt, prompt: rv.prompt, responseSnippet: rv.responseSnippet })),
      domainPresenceNote: hasDomainBacklink
        ? 'Client has separate domain-level presence on this source (a real backlink was found), but the specific content AI is citing has not been confirmed to contain the client.'
        : (anyVerifiedAbsent ? 'The specific cited page was fetched and inspected, and did not contain the client -- this remains response-level co-occurrence only, not verified presence.' : null)
    }
  }

  if (hasDomainBacklink) {
    return {
      status: 'source_presence_only',
      confidence: 'inferred_from_backlink',
      totalMatchingObservations: 0,
      evidence: [{ note: 'A real backlink from this domain was found via Ahrefs, but no tracked AI response mentioning this client also cited it.' }],
      domainPresenceNote: 'Client has source presence on this domain (e.g. a directory profile), but observed AI citations -- if any -- reference other content on this domain, not the page(s) establishing that presence.'
    }
  }

  // Genuinely don't know -- never asserted as 'absent' just because we
  // didn't find positive evidence; only a real, explicit negative check
  // (not built for arbitrary domains in this MVP -- see module header)
  // would justify 'absent'.
  return { status: 'unknown', confidence: 'unknown', totalMatchingObservations: 0, evidence: [], domainPresenceNote: null }
}

// estimateEffort(relationshipType) -> {level, reasoning}. AM/business
// effort to pursue this source -- INDEPENDENT of execution_capability
// (a RED, manually-executed action can still be low effort -- see
// determineTreatment below).
function estimateEffort(relationshipType) {
  if (relationshipType === 'Profile / Listing' || relationshipType === 'Review Page' || relationshipType === 'Association Membership') {
    return { level: 'low', reasoning: 'A profile/listing submission is typically a straightforward, one-time form.' }
  }
  if (relationshipType === 'Ranking / List') {
    return { level: 'medium', reasoning: 'Getting included in a curated ranking/list typically requires outreach or an application, not just a self-serve form.' }
  }
  if (relationshipType === 'Editorial Mention' || relationshipType === 'Expert Contribution') {
    return { level: 'high', reasoning: 'Earning editorial coverage or a contributed byline typically requires a real pitch and relationship-building, not a form submission.' }
  }
  return { level: 'medium', reasoning: 'Effort not well characterized for this relationship type yet -- treated as medium by default.' }
}

// determineExecutionCapability() -> {capability, reasoning}. ALWAYS 'red'
// today -- per the approved spec, GREEN is never used by default for
// third-party public actions, and YELLOW requires a REAL, currently-
// supported submission mechanism/API, which this project does not have for
// any directory/profile/editorial/association source today (confirmed via
// the audit: no directory/submission integration exists anywhere in this
// repo -- lib/wpPublish.js only ever publishes to the CLIENT'S OWN
// WordPress site, which is a different action entirely). Kept as a
// function (not a bare constant) so a future phase that DOES build a real
// submission integration for some specific source has one place to add
// the YELLOW branch, without this pillar inventing a fake one now.
function determineExecutionCapability() {
  return {
    capability: 'red',
    reasoning: 'No real, supported third-party submission/API integration exists in this project today for directory/profile/editorial/association actions -- GREEN is never used by default for third-party public actions, and YELLOW requires a genuine submission mechanism this pillar does not have yet. Human/external handoff only.'
  }
}

// determineTreatment({importance, presence, effort}) -> {treatment,
// reasoning}. Uses the Phase 3 shared vocabulary (highest_impact/easy_win/
// strength_protect/null) -- never a formula, always a stored reason.
//
// EVIDENCE-STRENGTH CORRECTION (2026-08-17): strength_protect used to
// trigger on the old 'appears_in_cited_content' status, which was itself
// only ever mere AI-response co-occurrence -- meaning a source could be
// marked "durable strength, not an action item" from nothing stronger than
// "an AI answer happened to mention both the client and this source." That
// is corrected here: strength_protect now requires either genuine
// page-level verified presence (the cited URL was actually fetched and the
// client was found on it) or a client-owned page being directly cited --
// never response-level co-occurrence alone.
function determineTreatment({ importance, presence, effort }) {
  if ((presence.status === 'appears_in_cited_content_verified' || presence.status === 'client_owned_page_cited') && importance.level !== 'low') {
    return {
      treatment: 'strength_protect',
      reasoning: `Client already ${presence.status === 'client_owned_page_cited' ? 'has an owned page cited' : 'has VERIFIED presence in the actual cited content (the cited page was fetched and inspected)'} for a source with ${importance.level} observed AI importance (${importance.reasoning}) -- durable strength, not an action item.`
    }
  }
  if (importance.level === 'high') {
    return {
      treatment: 'highest_impact',
      reasoning: `High observed AI importance (${importance.reasoning}) combined with a real client gap (${presence.status}, confidence: ${presence.confidence}).`
    }
  }
  if (importance.level === 'medium' && effort.level === 'low') {
    return {
      treatment: 'easy_win',
      reasoning: `${effort.reasoning} Combined with medium observed AI importance (${importance.reasoning}) and a real client gap (${presence.status}), this is a strong effort-to-impact ratio -- independent of execution capability, which is separately RED (manual) for this pillar today.`
    }
  }
  if (importance.level === 'medium') {
    return { treatment: null, reasoning: `Meaningful observed importance (${importance.reasoning}) but higher effort (${effort.level}) -- tracked as an ordinary opportunity, not fast-tracked.` }
  }
  return { treatment: null, reasoning: `Below the bar for a labeled treatment (${importance.reasoning}) -- tracked as an ordinary, unlabeled opportunity.` }
}

// classifySourceDisposition({importance, presence, effort, treatment}) ->
// {disposition, reason}. EVIDENCE-STRENGTH CORRECTION (2026-08-17): this
// replaces the original qualifiesAsOpportunity()/doNothingReason() pair and
// consolidates the strength_protect gate into one place, adding a 4th
// outcome -- 'observational' -- for sources whose evidence genuinely
// doesn't establish a verified gap one way or the other. An 'observational'
// source gets NO opportunity row created at all: it is reported (so an AM
// can see it exists and why it's inconclusive) but never forced into either
// an action item or a formal rejection. This directly answers the
// correction's instruction: "Do not automatically turn an unverified
// source into an opportunity either... leave the source
// observational/insufficient evidence."
function classifySourceDisposition({ importance, presence, effort, treatment }) {
  // Strength/Protect -- decided by determineTreatment's (now corrected)
  // gate above; never re-derived here.
  if (treatment && treatment.treatment === 'strength_protect') {
    return { disposition: 'strength_protect', reason: null }
  }

  // 1. Observed AI importance -- must have SOME real evidence (client-
  // specific or industry-level), not zero.
  if (!importance || importance.evidenceRefs.provenance === 'none') {
    return { disposition: 'do_nothing', reason: 'weak_evidence' }
  }
  // 2. Commercial relevance -- MVP proxy: every tracked prompt run through
  // trackAiVisibility.js is already one of this client's real, curated
  // recommendation-style test prompts, so any client-specific citation
  // evidence already clears this bar. Only pure industry-level evidence
  // with a low-confidence source gets treated as commercially thin.
  if (importance.evidenceRefs.provenance === 'industry_level' && importance.level === 'low') {
    return { disposition: 'do_nothing', reason: 'low_commercial_relevance' }
  }

  // A verified strong presence that didn't clear strength_protect's
  // importance bar (e.g. importance is 'low') is still not a gap -- the
  // client is already adequately represented, just not strategically
  // significant enough to flag as a protect-worthy strength.
  const verifiedPresence = presence.status === 'client_owned_page_cited' || presence.status === 'appears_in_cited_content_verified'
  if (verifiedPresence) {
    return { disposition: 'do_nothing', reason: 'already_adequately_represented' }
  }

  // 3. Client gap -- ONLY a verified negative (absent) or a confirmed
  // domain-level-but-not-cited-content gap (source_presence_only) counts as
  // an established gap. 'unknown' and 'ai_response_co_occurrence' do NOT
  // establish a gap -- we genuinely don't know whether the client appears
  // in the specific cited content, and per the correction, that ambiguity
  // must not be resolved in either direction by default.
  const verifiedGap = presence.status === 'absent' || presence.status === 'source_presence_only'
  if (verifiedGap) {
    // 4. Actionability -- MVP: every relationship type this pillar
    // recognizes has SOME legitimate path.
    if (effort && effort.level === 'no_legitimate_path') return { disposition: 'do_nothing', reason: 'no_legitimate_intervention' }
    if (importance.level === 'low' && effort && effort.level !== 'low') return { disposition: 'do_nothing', reason: 'effort_outweighs_impact' }
    // 5. Eligibility -- MVP: assume plausibly eligible unless a future
    // check says otherwise.
    return { disposition: 'qualifies', reason: null }
  }

  // Insufficient evidence to establish the client gap either way -- stays
  // observational. No opportunity row is created for this source (see
  // qualifySourceOpportunities).
  return { disposition: 'observational', reason: 'unverified_presence' }
}

// buildPreparedWorkPayload({client, source, relationshipType}) -> the
// artifact payload for opportunityLifecycle.prepareWork(). Built ENTIRELY
// from real fields already on the `clients` row (Phase 1a business profile
// data) -- no LLM call, no network call, so preparing this work never
// blocks on an external dependency and (per the spec's MVP scope) can run
// synchronously. Even for a RED opportunity, this is prepared as fully as
// possible so a human never has to re-research it from scratch.
function buildPreparedWorkPayload({ client, source, relationshipType }) {
  const businessFacts = {
    name: client.name || null,
    domain: client.domain || client.url || null,
    phone: client.phone || null,
    street_address: client.street_address || null,
    city: client.city || null,
    region: client.region || null,
    postal_code: client.postal_code || null,
    category: client.category || null,
    description: client.description || null
  }
  const sourceUrl = `https://${source.domain}`
  const recommendedDescription = businessFacts.description
    || `${businessFacts.name || 'This business'}${businessFacts.category ? ` -- ${businessFacts.category}` : ''} serving ${[businessFacts.city, businessFacts.region].filter(Boolean).join(', ') || 'its market'}.`

  const base = {
    sourceUrl,
    relationshipType,
    eligibility: 'Plausibly eligible -- not independently confirmed. Verify this source actually accepts businesses in this category/region before submitting.',
    businessFacts,
    targetTopicAssociation: Array.isArray(source.topicsObserved) ? source.topicsObserved.slice(0, 5) : [],
    provenance: 'Generated from this client\'s own confirmed business-profile fields -- no LLM/network call was made to prepare this work.'
  }

  if (relationshipType === 'Editorial Mention' || relationshipType === 'Expert Contribution' || relationshipType === 'Ranking / List') {
    return {
      ...base,
      artifactType: 'outreach_pitch',
      targetPublication: source.domain,
      topicAngle: (Array.isArray(source.topicsObserved) && source.topicsObserved[0]) || businessFacts.category || 'this business\'s core service',
      whyClientQualifies: `${businessFacts.name || 'This business'} has real, tracked AI-visibility evidence tying it to this topic area (see attached evidence); a pitch should lead with that observed relevance, not a generic company overview.`,
      pitch: `${businessFacts.name || 'This business'} is a ${businessFacts.category || 'business'} based in ${[businessFacts.city, businessFacts.region].filter(Boolean).join(', ') || 'its market'}. We'd welcome the opportunity to contribute perspective or be considered for coverage on ${source.domain} related to ${(Array.isArray(source.topicsObserved) && source.topicsObserved[0]) || 'this topic area'}.`,
      supportingProof: base.targetTopicAssociation,
      implementationInstructions: `Identify the correct editorial/submissions contact at ${sourceUrl} and send the pitch above, customized with specific supporting evidence. This pillar cannot submit or pitch on your behalf (RED execution capability -- no real integration exists for this).`
    }
  }

  if (relationshipType === 'Association Membership') {
    return {
      ...base,
      artifactType: 'source_submission',
      membershipUrl: sourceUrl,
      proposedProfileCopy: recommendedDescription,
      evidence: base.targetTopicAssociation,
      implementationInstructions: `Visit ${sourceUrl}, review membership eligibility criteria, and apply using the business facts and proposed profile copy above. This pillar cannot submit an application on your behalf (RED execution capability).`
    }
  }

  return {
    ...base,
    artifactType: 'directory_profile_update',
    recommendedCategory: businessFacts.category,
    recommendedDescription,
    requiredFieldsKnown: 'Not independently verified -- confirm the exact submission form/fields at the source URL.',
    implementationInstructions: `Visit ${sourceUrl}, locate the business listing/profile submission flow, and submit using the business facts and recommended description above. This pillar cannot submit on your behalf (RED execution capability -- no supported API exists for this source).`
  }
}

// analyzeOwnSiteCitations(rowViews, {topicClusters}) -> Step 3 data. Every
// number here is real and derived; no causality is asserted (see module
// header's "OBSERVED DIFFERENCE / SUPPORTED HYPOTHESIS / INSUFFICIENT
// EVIDENCE" language requirement -- this pillar does not diagnose the
// site-side cause, only surfaces the observation for routing).
function analyzeOwnSiteCitations(rowViews, { topicClusters = [] } = {}) {
  const ownPathCounts = new Map()
  for (const rv of rowViews) {
    for (const u of rv.ownUrls) {
      let path
      try { path = new URL(u).pathname || '/' } catch (e) { path = u }
      ownPathCounts.set(path, (ownPathCounts.get(path) || 0) + 1)
    }
  }
  const citedOwnPages = [...ownPathCounts.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count)

  const importantTopics = (topicClusters || []).filter(t => t.status === 'benchmark' || t.business_priority === 'strategic')
  const topicsWithoutCitedEvidence = importantTopics.filter(t => {
    const nameWords = (t.name || '').toLowerCase().split(/\W+/).filter(w => w.length > 3)
    return !citedOwnPages.some(p => nameWords.some(w => p.path.toLowerCase().includes(w)))
  }).map(t => ({ topicClusterId: t.id, name: t.name }))

  const competitorCitedInstead = rowViews
    .filter(rv => rv.ownUrls.length === 0 && rv.competitorDomainsCited.length > 0)
    .map(rv => ({ prompt: rv.prompt, engine: rv.engine, runAt: rv.runAt, competitorDomains: rv.competitorDomainsCited, evidenceStatus: 'OBSERVED DIFFERENCE -- this pillar does not diagnose the site-side cause; INSUFFICIENT EVIDENCE to assert why.' }))

  return { citedOwnPages, topicsWithoutCitedEvidence, competitorCitedInstead }
}

// computeIndustryEvidence(domain, {clientId, clientCategory, allRows}) ->
// {observedAcrossClients, note} | null. `allRows` is every OTHER client's
// (client_id != clientId, same category) recent ai_visibility_tracked_runs
// rows. Returns null (never a fabricated placeholder) when there isn't
// real cross-client data to learn from -- per the approved spec, industry
// classification only ever creates a CANDIDATE prior; observed evidence
// establishes actual importance. No hardcoded "X industry -> Y source"
// mapping exists anywhere in this file.
function computeIndustryEvidence(domain, { clientCategory, otherClientRowViews = [] } = {}) {
  if (!clientCategory || otherClientRowViews.length === 0) return null
  const citingClients = new Set()
  let citationCount = 0
  for (const rv of otherClientRowViews) {
    if (rv.sourceDomains.includes(domain)) {
      citingClients.add(rv.clientId)
      citationCount++
    }
  }
  if (citingClients.size === 0) return null
  return {
    observedAcrossClients: citingClients.size,
    citationCount,
    industryCategory: clientCategory,
    note: `Observed for ${citingClients.size} other "${clientCategory}" client(s) (${citationCount} citation(s) total) -- not this client's own data.`
  }
}

// ---------------------------------------------------------------------
// I/O ORCHESTRATION -- reads ai_visibility_tracked_runs/client_competitors/
// clients/topic_clusters, upserts client_sources, and drives the Phase 3
// shared opportunity lifecycle (lib/opportunityLifecycle.js). Every
// function below is real: no mocked data, no fabricated success. Errors
// from optional dependencies (Ahrefs, cross-client industry data) degrade
// to an honest empty/null result -- same convention as every other checker
// in this project -- rather than blocking the whole sync.
// ---------------------------------------------------------------------

const AI_RUNS_TABLE = 'ai_visibility_tracked_runs'
const COMPETITORS_TABLE = 'client_competitors'
const CLIENTS_TABLE = 'clients'
const TOPIC_CLUSTERS_TABLE = 'topic_clusters'

// fetchCompetitorDomainSet(clientId) -> Set<normalizedDomain> of this
// client's own qualified/topic-relevant competitors (client_competitors is
// already the current competitive model -- reused directly, not
// reinvented, per the approved spec's "use only qualified/topic-relevant
// competitors from the current competitive model" instruction).
async function fetchCompetitorDomainSet(supabase, clientId) {
  const { data, error } = await supabase.from(COMPETITORS_TABLE).select('domain').eq('client_id', clientId).eq('active', true)
  if (error) throw error
  return new Set((data || []).map(r => normalizeDomain(r.domain)).filter(Boolean))
}

// fetchRowViews(clientId) -> every real ai_visibility_tracked_runs row for
// this client, normalized via buildRowSourceView. This is the raw
// observation source of truth -- no separate extraction is reimplemented.
async function fetchRowViews(supabase, clientId, { competitorDomains = new Set() } = {}) {
  const { data, error } = await supabase.from(AI_RUNS_TABLE).select('*').eq('client_id', clientId).order('run_at', { ascending: true })
  if (error) throw error
  return (data || []).map(row => buildRowSourceView(row, { competitorDomains }))
}

// fetchAuthorityBacklinkDomains(clientDomain) -> array of authority domains
// with a REAL confirmed backlink to this client (see lib/checkers/ahrefs.js
// -- the only per-domain backlink check this project has). Degrades to []
// (never fabricated) if AHREFS_API_KEY is missing or the call errors --
// determineClientPresence then honestly falls back to 'unknown' rather than
// a false 'absent'.
async function fetchAuthorityBacklinkDomains(clientDomain) {
  if (!clientDomain) return []
  const result = await getAuthorityBacklinks(clientDomain, { apiKey: process.env.AHREFS_API_KEY }).catch(() => null)
  if (!result || !Array.isArray(result.authorityReferringDomains)) return []
  return result.authorityReferringDomains.map(r => r.domain).filter(Boolean)
}

// fetchOtherClientRowViews(clientId, clientCategory) -> rowViews (each
// tagged with its own clientId) for every OTHER tracked client sharing this
// client's category -- the real cross-client sample computeIndustryEvidence
// needs. Returns [] (never fabricated) when there is no category or no
// other clients -- confirmed via real data that, as of this implementation,
// exactly ONE client (Firestarter SEO) exists in this database, so this
// will honestly return [] in production today. Kept real/wired anyway so it
// starts working the moment a second client with a matching category is
// added, with zero further code changes.
async function fetchOtherClientRowViews(supabase, clientId, clientCategory) {
  if (!clientCategory) return []
  const { data: otherClients, error } = await supabase
    .from(CLIENTS_TABLE).select('id').eq('category', clientCategory).neq('id', clientId)
  if (error) throw error
  const otherIds = (otherClients || []).map(c => c.id)
  if (otherIds.length === 0) return []

  const { data: rows, error: rowsError } = await supabase.from(AI_RUNS_TABLE).select('*').in('client_id', otherIds)
  if (rowsError) throw rowsError
  return (rows || []).map(row => ({ ...buildRowSourceView(row), clientId: row.client_id }))
}

// bestEffortSourceName(domain) -> a readable label derived from the domain
// itself (e.g. "clutch.co" -> "Clutch"). Purely cosmetic/best-effort -- no
// LLM call, no external lookup -- real source names (e.g. from a directory
// API) can replace this later without changing the schema.
function bestEffortSourceName(domain) {
  if (!domain) return null
  const base = domain.replace(/\.[a-z.]+$/i, '').split('.').pop()
  return base.charAt(0).toUpperCase() + base.slice(1)
}

// syncClientSources(clientId, {inspectPages}) -> { bySource: Map<domain,
// {...}>, client, rowViews }. Reads real data, computes every pure-logic
// field for each OBSERVED source domain, and upserts client_sources (keyed
// by (client_id, domain) -- the durable Source Entity model). Returns the
// computed-but-not-yet-lifecycle-processed data so qualifySourceOpportunities
// (below) doesn't have to re-derive it from the persisted jsonb.
//
// EVIDENCE-STRENGTH CORRECTION (2026-08-17): this is now the ONE place
// cited-page inspection (lib/citedPageInspection.js) actually runs -- real
// audit/research processing, never the wizard's render path (see that
// module's header). `inspectPages` defaults to true for real production
// syncs; pass `{inspectPages: false}` to skip it entirely (used by fast
// pure/unit tests that don't want real network calls, and safe to do since
// determineClientPresence simply falls back to the weaker
// 'ai_response_co_occurrence'/'unknown' states when no inspections exist --
// it never fabricates a verified state).
async function syncClientSources(clientId, { inspectPages = true, fetcher, inspectionOptions = {}, backlinkDomainsOverride } = {}) {
  const supabase = getSupabaseServerClient()

  const { data: client, error: clientError } = await supabase.from(CLIENTS_TABLE).select('*').eq('id', clientId).single()
  if (clientError) throw clientError

  // backlinkDomainsOverride is TEST-ONLY -- lets lib/sourceCitation.test.js
  // exercise the 'source_presence_only' (real domain-level presence, no
  // AHREFS_API_KEY required) path deterministically. Production callers
  // never pass this; the real Ahrefs-backed lookup always runs otherwise.
  const [competitorDomains, backlinkDomains] = await Promise.all([
    fetchCompetitorDomainSet(supabase, clientId),
    Array.isArray(backlinkDomainsOverride) ? Promise.resolve(backlinkDomainsOverride) : fetchAuthorityBacklinkDomains(normalizeDomain(client.domain || client.url))
  ])

  const rowViews = await fetchRowViews(supabase, clientId, { competitorDomains })
  const agg = aggregateSourceObservations(rowViews)
  const otherClientRowViews = await fetchOtherClientRowViews(supabase, clientId, client.category)

  // Cited-page inspection -- bounded, deduped, persisted (see
  // lib/citedPageInspection.js). Degrades to an empty Map (never blocks the
  // rest of the sync) if it errors for any reason -- same "data gap, not
  // fatal" convention as fetchAuthorityBacklinkDomains above.
  let inspectionsByDomain = new Map()
  if (inspectPages) {
    const urlsByDomain = new Map([...agg.entries()].map(([domain, sourceAgg]) => [domain, sourceAgg.urls]))
    inspectionsByDomain = await inspectCitedUrlsForClient(supabase, {
      clientId, client, urlsByDomain,
      classifyRelationshipType,
      ...(fetcher ? { fetcher } : {}),
      ...inspectionOptions
    }).catch(() => new Map())
  }

  const bySource = new Map()
  const upsertRows = []
  const nowIso = new Date().toISOString()

  for (const [domain, sourceAgg] of agg.entries()) {
    const industryEvidence = computeIndustryEvidence(domain, { clientCategory: client.category, otherClientRowViews })
    const importance = computeObservedImportance(sourceAgg, { industryEvidence })
    const citedPageInspections = inspectionsByDomain.get(domain) || []
    const presence = determineClientPresence({ domain, rowViewsCiting: sourceAgg.rowViewsCiting, authorityBacklinkDomains: backlinkDomains, citedPageInspections })
    const relationshipType = classifyRelationshipType(domain)
    const effort = estimateEffort(relationshipType)
    const executionCapability = determineExecutionCapability()
    const treatment = determineTreatment({ importance, presence, effort })
    const dispositionResult = classifySourceDisposition({ importance, presence, effort, treatment })

    const competitorPresenceEvidence = {
      competitorDomainsCoCited: [...new Set(sourceAgg.rowViewsCiting.flatMap(rv => rv.competitorDomainsCited))],
      note: 'Supporting evidence only -- never a qualification gate. A source can be highly cited with zero competitors present and still be a legitimate first-mover opportunity.'
    }

    const pageInspectionSummary = {
      urlsInspected: citedPageInspections.length,
      verifiedPresentCount: citedPageInspections.filter(i => i.verificationStatus === 'verified_present').length,
      verifiedAbsentCount: citedPageInspections.filter(i => i.verificationStatus === 'verified_absent').length,
      unverifiableCount: citedPageInspections.filter(i => i.verificationStatus === 'unverifiable').length
    }

    const entry = {
      domain, source: sourceAgg, importance, presence, relationshipType, effort,
      executionCapability, treatment, disposition: dispositionResult, industryEvidence,
      citedPageInspections, pageInspectionSummary,
      topicsObserved: [...sourceAgg.prompts].slice(0, 10)
    }
    bySource.set(domain, entry)

    upsertRows.push({
      client_id: clientId,
      domain,
      source_name: bestEffortSourceName(domain),
      source_type: relationshipType,
      relationship_types: [relationshipType],
      first_observed_at: sourceAgg.firstObservedAt || nowIso,
      last_observed_at: sourceAgg.lastObservedAt || nowIso,
      engines_observed: [...sourceAgg.engines],
      topics_observed: entry.topicsObserved,
      client_specific_observation_count: sourceAgg.citationCount,
      observed_importance: importance,
      client_presence_status: presence.status,
      client_presence_confidence: presence.confidence,
      client_presence_evidence: presence.evidence,
      domain_presence_note: presence.domainPresenceNote || null,
      page_inspection_summary: pageInspectionSummary,
      competitor_presence_evidence: competitorPresenceEvidence,
      industry_evidence: industryEvidence,
      actionability: { effort, executionCapability, disposition: dispositionResult, treatment },
      provenance: { evidenceProvenance: importance.evidenceRefs.provenance, generatedAt: nowIso },
      raw_citation_urls: [...sourceAgg.urls],
      updated_at: nowIso
    })
  }

  if (upsertRows.length > 0) {
    const { data: upserted, error: upsertError } = await supabase
      .from(CLIENT_SOURCES_TABLE)
      .upsert(upsertRows, { onConflict: 'client_id,domain' })
      .select()
    if (upsertError) throw upsertError
    for (const row of upserted || []) {
      const entry = bySource.get(row.domain)
      if (entry) entry.dbRow = row
    }
  }

  return { client, bySource, rowViews }
}

// qualifySourceOpportunities(clientId, syncResult, {auditRunId, actor}) ->
// drives the real Phase 3 shared lifecycle for every observed source,
// using the exact functions Phase 3 built for every future pillar to call
// (qualifyOpportunity/setPriorityTreatment/markStrengthProtect/
// rejectOpportunity/prepareWork) -- no parallel lifecycle invented here.
// Every observed source becomes a durable opportunity row (fingerprint
// `source:<domain>`, idempotent/re-observation-safe via qualifyOpportunity
// itself) so the outcome -- qualified/highest_impact/easy_win/do_nothing/
// strength_protect -- is preserved and auditable, exactly mirroring how
// lib/opportunities.js treats every real candidate for Competitive
// Position rather than silently dropping the ones that don't qualify.
async function qualifySourceOpportunities(clientId, syncResult, { auditRunId = null, actor = 'system' } = {}) {
  const { client, bySource } = syncResult
  const results = []

  for (const [domain, entry] of bySource.entries()) {
    const { importance, presence, relationshipType, effort, executionCapability, treatment, disposition } = entry
    const fingerprint = `source:${domain}`
    const title = `${bestEffortSourceName(domain)} (${domain}) -- ${relationshipType}`
    const detail = {
      domain,
      relationshipType,
      observedImportance: importance,
      clientPresence: presence,
      industryEvidence: entry.industryEvidence,
      topicsObserved: entry.topicsObserved,
      pageInspectionSummary: entry.pageInspectionSummary,
      note: presence.status === 'appears_in_cited_content_verified'
        ? 'Client appearance in the actual cited content was VERIFIED -- the cited page was fetched and inspected directly.'
        : presence.status === 'ai_response_co_occurrence'
          ? 'An AI response mentioned the client and cited this source in the same response -- this is response-level co-occurrence only; the specific cited page has not been confirmed to contain the client.'
          : presence.status === 'source_presence_only'
            ? (presence.domainPresenceNote || 'Client has source presence, but observed AI citations reference other content (or no AI citation of the client via this source has been observed yet).')
            : presence.status === 'client_owned_page_cited'
              ? 'A client-owned URL is directly cited by AI for this source.'
              : presence.status === 'absent'
                ? 'No client presence observed on this source.'
                : 'Client presence on this source is not yet known -- no confirmed AI citation or backlink evidence either way.'
    }
    // Evidence items always carry {text, source} -- the shape
    // OpportunityCard.js (Phase 3's shared card component) renders directly
    // -- alongside the raw engine/runAt/prompt/responseSnippet fields for
    // deeper drill-down UI. Built from real presence.evidence /
    // rowViewsCiting entries only -- never fabricated.
    const rawEvidenceEntries = [
      ...presence.evidence.map(e => ({ ...e, _kind: 'presence' })),
      ...entry.source.rowViewsCiting.slice(0, 5).map(rv => ({ engine: rv.engine, runAt: rv.runAt, prompt: rv.prompt, responseSnippet: rv.responseSnippet, _kind: 'citation' }))
    ]
    const evidence = rawEvidenceEntries.map(e => ({
      text: e.prompt
        ? `"${e.prompt}"${e.engine ? ` (${e.engine})` : ''}${e.responseSnippet ? `: ${e.responseSnippet}` : ''}`
        : (e.note || `Observed via ${e.engine || 'an AI engine'}.`),
      source: e.engine || 'ahrefs',
      engine: e.engine || null,
      runAt: e.runAt || null,
      prompt: e.prompt || null,
      responseSnippet: e.responseSnippet || null
    }))

    // EVIDENCE-STRENGTH CORRECTION (2026-08-17): an 'observational' source
    // gets NO opportunity row at all -- not qualified, not rejected, not
    // strength-protected. The evidence genuinely doesn't establish a
    // client gap one way or the other (see classifySourceDisposition), so
    // forcing it into any of those three outcomes would assert something
    // the evidence doesn't support. It's still reported here (an AM can
    // see the source exists and why it's inconclusive), just with no
    // durable opportunity created for it.
    if (disposition.disposition === 'observational') {
      results.push({
        domain, treatment: treatment.treatment, disposition: 'observational',
        reason: disposition.reason, opportunityId: null, action: 'skipped_insufficient_evidence'
      })
      continue
    }

    const priorityAssessment = buildPriorityAssessment({
      impact: { level: importance.level, reasoning: importance.reasoning },
      effort,
      evidenceStrength: { level: presence.confidence === 'verified_by_page_fetch' ? 'high' : presence.confidence === 'inferred_from_ai_co_occurrence' ? 'medium' : presence.confidence === 'inferred_from_backlink' ? 'medium' : 'low', reasoning: `Presence confidence: ${presence.confidence}.` },
      commercialRelevance: { level: importance.evidenceRefs.provenance === 'client_specific' ? 'high' : importance.evidenceRefs.provenance === 'industry_level' ? 'medium' : 'low', reasoning: `Evidence provenance: ${importance.evidenceRefs.provenance}.` },
      treatmentReasoning: treatment.reasoning,
      treatmentEvidence: [...entry.source.urls].slice(0, 10)
    })

    const { opportunityId, action } = await qualifyOpportunity({
      clientId,
      auditRunId,
      owningPillar: 'ai_source_citation_presence',
      originatingPillar: 'ai_source_citation_presence',
      opportunityType: 'citation_target',
      fingerprint,
      title,
      detail,
      evidence,
      priorityAssessment,
      priorityTreatment: treatment.treatment,
      executionCapability: executionCapability.capability,
      actor
    })

    let outcome = { opportunityId, action, treatment: treatment.treatment, domain }

    if (disposition.disposition === 'strength_protect') {
      await markStrengthProtect(opportunityId, { reasoning: treatment.reasoning, evidenceRefs: priorityAssessment.treatment_evidence, actor })
      outcome.disposition = 'strength_protect'
    } else if (disposition.disposition === 'qualifies') {
      await setPriorityTreatment(opportunityId, {
        treatment: treatment.treatment,
        impact: { level: importance.level, reasoning: importance.reasoning },
        effort,
        executionCapability: executionCapability.capability,
        reasoning: treatment.reasoning,
        evidenceRefs: priorityAssessment.treatment_evidence,
        actor
      })
      const preparedWork = await prepareWork({
        opportunityId,
        artifactType: buildPreparedWorkPayload({ client, source: { domain, topicsObserved: entry.topicsObserved }, relationshipType }).artifactType,
        payload: buildPreparedWorkPayload({ client, source: { domain, topicsObserved: entry.topicsObserved }, relationshipType }),
        generationMethod: 'system_generated',
        evidenceContext: evidence,
        supportsAutomatedExecution: false,
        createdBy: 'system',
        actor
      })
      // Submit for AM approval regardless of execution capability -- the
      // approve/reject decision point in the shared FINDING -> ... ->
      // APPROVE -> EXECUTE/HANDOFF -> VERIFY sequence isn't exclusive to
      // YELLOW (see OpportunityCard.js's header): a RED opportunity's
      // prepared pitch/profile copy still benefits from an AM reviewing
      // (and optionally editing) it before it's handed off to a human.
      // validateExecutionGate's RED/YELLOW execution gating is unaffected
      // by this -- RED still can never auto-execute regardless of
      // approval_status.
      await submitForApproval(opportunityId, { preparedWorkId: preparedWork.preparedWorkId, actor })
      outcome.disposition = 'qualified'
      outcome.preparedWorkId = preparedWork.preparedWorkId
    } else {
      const reason = disposition.reason || 'weak_evidence'
      await rejectOpportunity(opportunityId, { reason, detail: { reasoning: treatment.reasoning, dispositionReason: disposition.reason }, actor })
      outcome.disposition = 'do_nothing'
      outcome.reason = reason
    }

    results.push(outcome)
  }

  return results
}

// syncSourceCitationPillar(client, {auditRunId, actor}) -> the single
// entry point runAudit.js calls, mirroring the existing
// `syncOpportunities({...pillar:'competitive_position'...})` call's own
// non-blocking `.catch(() => null)` convention at its call site. Does the
// full real pipeline: sync client_sources, then qualify/sync every source
// through the real Phase 3 lifecycle. Never writes a pillar_scores row
// (this pillar has no 0-100 score) and never touches any other pillar's
// data.
async function syncSourceCitationPillar(client, { auditRunId = null, actor = 'system', inspectPages = true, fetcher, inspectionOptions = {}, backlinkDomainsOverride } = {}) {
  const syncResult = await syncClientSources(client.id, { inspectPages, fetcher, inspectionOptions, backlinkDomainsOverride })
  const opportunities = await qualifySourceOpportunities(client.id, syncResult, { auditRunId, actor })
  const observational = opportunities.filter(o => o.disposition === 'observational')
  return { sourcesObserved: syncResult.bySource.size, opportunities, observationalCount: observational.length }
}

// analyzeOwnSiteCitationsForClient(clientId) -> real Step 3 data, reading
// the same rowViews syncClientSources already computes (recomputed here
// independently so this can be called standalone from a Server Component
// read path, e.g. getSourceLandscape below, without requiring a sync to
// have just run).
async function analyzeOwnSiteCitationsForClient(clientId) {
  const supabase = getSupabaseServerClient()
  const rowViews = await fetchRowViews(supabase, clientId, { competitorDomains: await fetchCompetitorDomainSet(supabase, clientId) })
  const { data: topicClusters, error } = await supabase.from(TOPIC_CLUSTERS_TABLE).select('*').eq('client_id', clientId)
  if (error) throw error
  return analyzeOwnSiteCitations(rowViews, { topicClusters: topicClusters || [] })
}

// getSourceLandscape(clientId) -> the full read model the five-step wizard
// renders from (a Server Component data fetch -- NO LLM/API call happens
// here, only real, already-computed reads of client_sources/opportunities/
// opportunity_prepared_work/ai_visibility_tracked_runs/topic_clusters).
// Diagnosis is intentionally descriptive-only: real counts and a
// headline, never a synthesized score.
//
// PHASE 1.1 ENRICHMENT (2026-09-01): each returned opportunity now
// carries priorityDimensions/statusTrack/preparedWork, the shape
// OpportunityCard.js/StatusTrack.js already expect (this was previously
// claimed by SourceCitationWizard.js's own header comment but never
// actually implemented -- see that file's corrected comment). Uses the
// existing Phase 3 helpers directly rather than recomputing anything:
// getPriorityDimensions/computeStatusTrack are pure/derived from the
// opportunity row itself (no extra query), and prepared work is fetched
// with ONE batched query across every opportunity for this client
// (`.in('opportunity_id', ids)`) rather than one lib/opportunityLifecycle.js
// #getPreparedWork() call per opportunity -- a client can have dozens of
// Source & Citation opportunities, so a per-opportunity query here would
// be an obvious N+1 against a Server Component data fetch.
async function getSourceLandscape(clientId) {
  const supabase = getSupabaseServerClient()

  const { data: sources, error: sourcesError } = await supabase
    .from(CLIENT_SOURCES_TABLE).select('*').eq('client_id', clientId)
  if (sourcesError) throw sourcesError

  const { data: rawOpportunities, error: oppError } = await supabase
    .from('opportunities').select('*').eq('client_id', clientId).eq('pillar', 'ai_source_citation_presence')
  if (oppError) throw oppError

  const opportunityIds = (rawOpportunities || []).map(o => o.id)
  const preparedWorkByOpportunityId = new Map()
  if (opportunityIds.length > 0) {
    const { data: preparedWorkRows, error: preparedWorkError } = await supabase
      .from(PREPARED_WORK_TABLE)
      .select('*')
      .in('opportunity_id', opportunityIds)
      .order('artifact_type')
      .order('version', { ascending: false })
    if (preparedWorkError) throw preparedWorkError
    for (const pw of preparedWorkRows || []) {
      if (!preparedWorkByOpportunityId.has(pw.opportunity_id)) preparedWorkByOpportunityId.set(pw.opportunity_id, [])
      preparedWorkByOpportunityId.get(pw.opportunity_id).push(pw)
    }
  }

  // priorityDimensions/statusTrack are pure/derived -- no DB access -- so
  // graceful handling of "no data yet" falls straight out of what
  // getPriorityDimensions/computeStatusTrack already do for a sparse row;
  // preparedWork defaults to [] for an opportunity with no prepared-work
  // rows yet (OpportunityCard.js already handles an empty array).
  const opportunities = (rawOpportunities || []).map(o => ({
    ...o,
    priorityDimensions: getPriorityDimensions(o),
    statusTrack: computeStatusTrack(o),
    preparedWork: preparedWorkByOpportunityId.get(o.id) || []
  }))

  const importanceRank = { high: 3, medium: 2, low: 1 }
  const rankedSources = [...(sources || [])].sort((a, b) => {
    const rankDiff = (importanceRank[b.observed_importance?.level] || 0) - (importanceRank[a.observed_importance?.level] || 0)
    if (rankDiff !== 0) return rankDiff
    return (b.client_specific_observation_count || 0) - (a.client_specific_observation_count || 0)
  })

  // EVIDENCE-STRENGTH CORRECTION (2026-08-17): the corrected 6-value status
  // set -- 'appears_in_cited_content' no longer exists as a status; it is
  // split into the weaker 'ai_response_co_occurrence' and the strong,
  // page-level-verified 'appears_in_cited_content_verified'.
  const presenceCounts = {
    absent: 0, source_presence_only: 0, ai_response_co_occurrence: 0,
    appears_in_cited_content_verified: 0, client_owned_page_cited: 0, unknown: 0
  }
  for (const s of sources || []) { if (presenceCounts[s.client_presence_status] != null) presenceCounts[s.client_presence_status]++ }

  const ownSiteCitations = await analyzeOwnSiteCitationsForClient(clientId).catch(() => null)

  const diagnosis = {
    totalSourcesObserved: (sources || []).length,
    highImportanceCount: (sources || []).filter(s => s.observed_importance?.level === 'high').length,
    presenceCounts,
    strengthProtectCount: (opportunities || []).filter(o => o.priority_treatment === 'strength_protect').length,
    highestImpactCount: (opportunities || []).filter(o => o.priority_treatment === 'highest_impact' && o.status === 'open').length,
    easyWinCount: (opportunities || []).filter(o => o.priority_treatment === 'easy_win' && o.status === 'open').length,
    doNothingCount: (opportunities || []).filter(o => o.status === 'dismissed' && o.priority_treatment === 'do_nothing').length,
    observationalCount: (sources || []).filter(s => s.actionability?.disposition?.disposition === 'observational').length,
    ownDomainCitedPageCount: ownSiteCitations ? ownSiteCitations.citedOwnPages.length : null,
    industryEvidenceAvailableCount: (sources || []).filter(s => s.industry_evidence != null).length
  }

  return { sources: rankedSources, opportunities: opportunities || [], ownSiteCitations, diagnosis }
}

module.exports = {
  RELATIONSHIP_TYPES, PRESENCE_STATUSES, PRESENCE_CONFIDENCE, IMPORTANCE_LEVELS,
  PRE_CORRECTION_STATUS_RENAME, PRE_CORRECTION_CONFIDENCE_RENAME,
  CLIENT_SOURCES_TABLE, CITED_PAGE_INSPECTIONS_TABLE,
  // pure logic
  classifyRelationshipType, buildRowSourceView, aggregateSourceObservations,
  computeObservedImportance, determineClientPresence, estimateEffort,
  determineExecutionCapability, determineTreatment, classifySourceDisposition,
  buildPreparedWorkPayload, analyzeOwnSiteCitations, computeIndustryEvidence,
  // I/O orchestration
  syncClientSources, qualifySourceOpportunities, syncSourceCitationPillar,
  analyzeOwnSiteCitationsForClient, getSourceLandscape
}
