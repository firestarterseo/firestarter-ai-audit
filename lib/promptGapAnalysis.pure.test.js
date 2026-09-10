// Pure tests for lib/promptGapAnalysis.js -- plain Node, no DB, no LLM, no
// network. Run with: node lib/promptGapAnalysis.pure.test.js

const assert = require('assert')
const {
  tokenize, overlapTerms, extractTitleAndH1, classifyEngineRow, classifyPromptOutcome,
  pickUrlForDomain, formatEngineOutcomes, bestEffortDomainName, containsHrefToDomain,
  computeContentGap, computeRelevanceGap, computeTechnicalGap,
  computeAuthorityGap, computeThirdPartyGap, partitionThirdPartySources,
  rankGaps, buildRecommendedActions
} = require('./promptGapAnalysis')

function log(msg) { console.log(msg) }

// --- tokenize / overlapTerms ---
{
  const t = tokenize('Best Window Replacement Company in Denver')
  assert.ok(t.has('window') && t.has('replacement') && t.has('denver'))
  assert.ok(!t.has('in') && !t.has('best'), 'stopwords should be excluded')
  const overlap = overlapTerms(t, tokenize('Denver Window Replacement Experts'))
  assert.ok(overlap.includes('window') && overlap.includes('denver'))
  log('PASS tokenize/overlapTerms')
}

// --- extractTitleAndH1 ---
{
  const html = '<html><head><title>Denver Window Co | Home</title></head><body><h1>Best Window Replacement in Denver</h1></body></html>'
  const { title, h1 } = extractTitleAndH1(html)
  assert.strictEqual(title, 'Denver Window Co | Home')
  assert.strictEqual(h1, 'Best Window Replacement in Denver')
  assert.deepStrictEqual(extractTitleAndH1(null), { title: null, h1: null })
  log('PASS extractTitleAndH1')
}

// --- classifyEngineRow ---
{
  const competitors = new Set(['competitor.com'])
  assert.strictEqual(classifyEngineRow(null, competitors).outcome, 'no_data')
  assert.strictEqual(classifyEngineRow({ ok: false, brand_mentioned: false, raw: {} }, competitors).outcome, 'no_data', 'a failed engine call is no_data, never no_signal')
  assert.strictEqual(classifyEngineRow({ error: 'timeout', brand_mentioned: false, raw: {} }, competitors).outcome, 'no_data')
  assert.strictEqual(classifyEngineRow({ brand_mentioned: null, raw: {} }, competitors).outcome, 'no_data', 'a null brand_mentioned is inconclusive, not no_signal')
  assert.strictEqual(classifyEngineRow({ brand_mentioned: true, raw: { thirdPartySourceUrls: [] } }, competitors).outcome, 'win')
  assert.strictEqual(classifyEngineRow({ brand_mentioned: true, raw: { thirdPartySourceUrls: ['https://competitor.com/x'] } }, competitors).outcome, 'tie')
  assert.strictEqual(classifyEngineRow({ brand_mentioned: false, raw: { thirdPartySourceUrls: ['https://competitor.com/x'] } }, competitors).outcome, 'loss')
  assert.strictEqual(classifyEngineRow({ brand_mentioned: false, raw: { thirdPartySourceUrls: ['https://untracked.com/x'] } }, competitors).outcome, 'no_signal')
  log('PASS classifyEngineRow')
}

// --- classifyPromptOutcome: multi-engine, MIXED, and the exact JDI masking scenario ---
{
  const competitors = new Set(['303windows.com', 'ameritechwindows.com', 'windowworldcolorado.com'])
  const prompt = 'window replacement denver'
  const runAt = '2026-09-09T16:55:39.225+00:00'
  const rows = [
    { engine: 'chatgpt', run_at: runAt, brand_mentioned: false, raw: { prompt, thirdPartySourceUrls: ['https://www.consumeraffairs.com/x'] } },
    { engine: 'gemini', run_at: runAt, brand_mentioned: false, raw: { prompt, thirdPartySourceUrls: ['https://www.303windows.com/x', 'https://www.ameritechwindows.com/y'] } },
    { engine: 'perplexity', run_at: runAt, brand_mentioned: false, raw: { prompt, thirdPartySourceUrls: ['https://www.ecowatch.com/z'] } },
    { engine: 'google', run_at: runAt, brand_mentioned: false, raw: { prompt, thirdPartySourceUrls: ['https://www.reddit.com/x', 'https://www.windowworldcolorado.com/y'] } }
  ]
  const outcome = classifyPromptOutcome(rows, prompt, competitors)
  // ChatGPT alone would have been 'no_signal' (the old, single-row bug) --
  // the corrected engine must classify this prompt as a real LOSS/MIXED
  // because 2 of 4 engines show a genuine loss to a tracked competitor.
  assert.strictEqual(outcome.engineOutcomes.chatgpt, 'NO_SIGNAL')
  assert.strictEqual(outcome.engineOutcomes.gemini, 'LOSS')
  assert.strictEqual(outcome.engineOutcomes.google, 'LOSS')
  assert.strictEqual(outcome.status, 'MIXED', 'outcomes differ across engines (no_signal vs loss) -> MIXED, never silently just the first engine checked')
  assert.strictEqual(outcome.losingEngines.length, 2)
  assert.ok(outcome.competitorTally.length >= 2, 'competitor evidence must be pooled across every losing engine, not just one')
  const domains = outcome.competitorTally.map(t => t.domain)
  assert.ok(domains.includes('303windows.com') && domains.includes('windowworldcolorado.com'))

  // Uniform loss across every real-outcome engine -> plain LOSS, not MIXED.
  const uniformLossRows = [
    { engine: 'chatgpt', run_at: runAt, brand_mentioned: false, raw: { prompt, thirdPartySourceUrls: ['https://www.303windows.com/x'] } },
    { engine: 'gemini', run_at: runAt, brand_mentioned: false, raw: { prompt, thirdPartySourceUrls: ['https://www.303windows.com/x'] } }
  ]
  assert.strictEqual(classifyPromptOutcome(uniformLossRows, prompt, competitors).status, 'LOSS')

  // Zero matching rows at all -> genuine NO_DATA (this message is allowed
  // to say "no tracked run exists" -- it's actually true here).
  assert.strictEqual(classifyPromptOutcome(rows, 'a totally different prompt', competitors).status, 'NO_DATA')

  // Every engine's own row is itself no_data (all failed) even though the
  // batch is real -> prompt-level NO_DATA, distinct from the zero-rows case.
  const allFailedRows = [
    { engine: 'chatgpt', run_at: runAt, ok: false, raw: { prompt } },
    { engine: 'gemini', run_at: runAt, brand_mentioned: null, raw: { prompt } }
  ]
  const allFailedOutcome = classifyPromptOutcome(allFailedRows, prompt, competitors)
  assert.strictEqual(allFailedOutcome.status, 'NO_DATA')
  assert.strictEqual(Object.keys(allFailedOutcome.engineOutcomes).length, 2, 'per-engine outcomes must still be reported even when every one is NO_DATA')
  log('PASS classifyPromptOutcome (multi-engine, MIXED, masking regression)')
}

// --- pickUrlForDomain / formatEngineOutcomes ---
{
  const losingEngines = [
    { engine: 'perplexity', competitorHits: [{ domain: 'a.com', url: 'https://a.com/from-perplexity' }] },
    { engine: 'chatgpt', competitorHits: [{ domain: 'a.com', url: 'https://a.com/from-chatgpt' }] }
  ]
  const picked = pickUrlForDomain(losingEngines, 'a.com')
  assert.strictEqual(picked.engine, 'chatgpt', 'ENGINE_PRIORITY should prefer chatgpt over perplexity deterministically')
  assert.strictEqual(picked.url, 'https://a.com/from-chatgpt')
  assert.strictEqual(pickUrlForDomain(losingEngines, 'not-present.com'), null)
  assert.strictEqual(formatEngineOutcomes({ chatgpt: 'WIN', gemini: 'LOSS' }), 'chatgpt=WIN, gemini=LOSS')
  log('PASS pickUrlForDomain/formatEngineOutcomes')
}

// --- computeContentGap (now discovery-status-aware) ---
{
  const competitorPage = { url: 'https://competitor.com/x', wordCount: 1200, fetchFailed: false }
  const noPageFound = computeContentGap({ competitorPage, clientPage: null, clientPageDiscovery: { status: 'no_relevant_page' } })
  assert.strictEqual(noPageFound.status, 'gap')
  assert.strictEqual(noPageFound.clientPageStatus, 'no_relevant_page')

  const uncertainSitemap = computeContentGap({ competitorPage, clientPage: null, clientPageDiscovery: { status: 'uncertain', uncertainReason: 'sitemap_unreachable' } })
  assert.strictEqual(uncertainSitemap.status, 'insufficient_data', 'unreachable sitemap must never be treated as "no page"')

  const uncertainRanksButUnfetchable = computeContentGap({ competitorPage, clientPage: null, clientPageDiscovery: { status: 'uncertain', uncertainReason: 'ranks_but_unfetchable' } })
  assert.strictEqual(uncertainRanksButUnfetchable.status, 'insufficient_data', 'a page that ranks but could not be fetched must stay uncertain, never "no page" and never a gap')

  const existsNotRanking = computeContentGap({
    competitorPage,
    clientPage: { url: 'https://client.com/x', wordCount: 300, fetchFailed: false },
    clientPageDiscovery: { status: 'relevant_nonranking_page' }
  })
  assert.strictEqual(existsNotRanking.status, 'gap')
  assert.strictEqual(existsNotRanking.clientPageStatus, 'relevant_nonranking_page')
  assert.ok(existsNotRanking.evidence.some(e => e.includes('exists but is not ranking')))

  // A page that genuinely RANKS must never be discarded just because it's
  // shorter than the competitor's -- it's still evaluated as a real page,
  // not treated as absent.
  const ranksAndLonger = computeContentGap({
    competitorPage,
    clientPage: { url: 'https://client.com/', wordCount: 4000, fetchFailed: false },
    clientPageDiscovery: { status: 'relevant_ranking_page' }
  })
  assert.strictEqual(ranksAndLonger.status, 'no_gap')
  assert.ok(ranksAndLonger.evidence.some(e => e.includes('RANKS live')))

  assert.strictEqual(computeContentGap({ competitorPage: { fetchFailed: true }, clientPage: null, clientPageDiscovery: null }).status, 'insufficient_data')

  // Intent-mismatch case: candidates existed (keyword overlap) but none
  // satisfied the classified intent -- must be worded distinctly from
  // "no candidates at all," per the explicit "say so" requirement.
  const noIntentMatch = computeContentGap({
    competitorPage,
    clientPage: null,
    clientPageDiscovery: { status: 'no_relevant_page', noPageReason: 'no_candidate_satisfies_intent', candidatesConsidered: 2, intent: 'local_commercial_service' }
  })
  assert.strictEqual(noIntentMatch.status, 'gap')
  assert.strictEqual(noIntentMatch.noPageReason, 'no_candidate_satisfies_intent')
  assert.ok(noIntentMatch.evidence.some(e => e.includes('no appropriate client page exists')))
  log('PASS computeContentGap')
}

// --- computeRelevanceGap / computeTechnicalGap / computeAuthorityGap (unchanged contracts) ---
{
  const promptText = 'best window replacement company in denver'
  const competitorPage = { title: 'Denver Window Replacement Experts', h1: 'Window Replacement in Denver', fetchFailed: false }
  const clientPageWeak = { title: 'Acme Home Services', h1: 'Welcome', fetchFailed: false }
  assert.strictEqual(computeRelevanceGap({ promptText, competitorPage, clientPage: clientPageWeak }).status, 'gap')

  const withSchema = { html: '<script type="application/ld+json">{"@type":"LocalBusiness","name":"X","address":"Y"}</script>', fetchFailed: false }
  const withoutSchema = { html: '<html><body>no schema here</body></html>', fetchFailed: false }
  assert.strictEqual(computeTechnicalGap({ competitorPage: withSchema, clientPage: withoutSchema }).status, 'gap')

  const clientAuthority = { authorityReferringDomains: [{ domain: 'forbes.com' }], error: null }
  const competitorAuthority = { authorityReferringDomains: [{ domain: 'forbes.com' }, { domain: 'inc.com' }], error: null }
  assert.strictEqual(computeAuthorityGap({ clientAuthority, competitorAuthority }).status, 'gap')
  log('PASS computeRelevanceGap/computeTechnicalGap/computeAuthorityGap')
}

// --- containsHrefToDomain / bestEffortDomainName ---
{
  assert.strictEqual(containsHrefToDomain('<a href="https://303windows.com/x">Visit their site</a>', '303windows.com'), true, 'must detect a link even when the anchor text itself never mentions the domain')
  assert.strictEqual(containsHrefToDomain('<a href="https://othersite.com/x">Visit their site</a>', '303windows.com'), false)
  assert.strictEqual(containsHrefToDomain(null, '303windows.com'), false)
  assert.strictEqual(bestEffortDomainName('303windows.com'), '303windows')
  assert.strictEqual(bestEffortDomainName(null), null)
  log('PASS containsHrefToDomain/bestEffortDomainName')
}

// --- partitionThirdPartySources / computeThirdPartyGap (now verification-
// based: only hostnames VERIFIED to actually mention/link the competitor
// count as evidence -- a hostname cited in the same AI response but with no
// real association is EXCLUDED, not silently kept) ---
{
  const clientSourcesByDomain = new Map([
    ['g2.com', { client_presence_status: 'absent' }],
    ['clutch.co', { client_presence_status: 'appears_in_cited_content_verified' }]
  ])

  const partitioned = partitionThirdPartySources([
    { hostname: 'g2.com', status: 'verified_present', reason: 'mentions competitor' },
    { hostname: 'unrelated.com', status: 'verified_absent', reason: 'no mention' },
    { hostname: 'blocked.com', status: 'insufficient_data', reason: 'robots blocked' }
  ])
  assert.strictEqual(partitioned.associated.length, 1)
  assert.strictEqual(partitioned.excluded.length, 1)
  assert.strictEqual(partitioned.insufficient.length, 1)

  const gapResult = computeThirdPartyGap({
    hostnameInspections: [
      { hostname: 'g2.com', status: 'verified_present', reason: 'mentions competitor' },
      { hostname: 'unrelated.com', status: 'verified_absent', reason: 'cited for unrelated info' }
    ],
    clientSourcesByDomain, sourcesEverSynced: true
  })
  assert.strictEqual(gapResult.status, 'gap')
  assert.deepStrictEqual(gapResult.absentSources, ['g2.com'])
  assert.ok(gapResult.evidence.some(e => e.includes('unrelated.com') && e.includes('Excluded')), 'the unassociated source must be reported as explicitly excluded, not silently dropped')

  const noGapResult = computeThirdPartyGap({ hostnameInspections: [{ hostname: 'clutch.co', status: 'verified_present' }], clientSourcesByDomain, sourcesEverSynced: true })
  assert.strictEqual(noGapResult.status, 'no_gap')

  // Every candidate source turned out to be verified_absent (not actually
  // associated with the competitor) -- must NOT be reported as a gap.
  const allExcluded = computeThirdPartyGap({ hostnameInspections: [{ hostname: 'unrelated.com', status: 'verified_absent' }], clientSourcesByDomain, sourcesEverSynced: true })
  assert.strictEqual(allExcluded.status, 'insufficient_data', 'a source cited for unrelated info must never count as Third-Party Proof')

  const couldNotSync = computeThirdPartyGap({ hostnameInspections: [{ hostname: 'g2.com', status: 'verified_present' }], clientSourcesByDomain: new Map(), sourcesEverSynced: false })
  assert.strictEqual(couldNotSync.status, 'insufficient_data')

  const insufficient = computeThirdPartyGap({ hostnameInspections: [], clientSourcesByDomain: new Map(), sourcesEverSynced: true })
  assert.strictEqual(insufficient.status, 'insufficient_data')
  log('PASS partitionThirdPartySources/computeThirdPartyGap')
}

// --- rankGaps / buildRecommendedActions ---
{
  const dims = {
    third_party: { status: 'gap', absentSources: ['g2.com'] },
    content: { status: 'gap', clientWordCount: 300, competitorWordCount: 1200, clientPageStatus: 'relevant_ranking_page' },
    authority: { status: 'no_gap' },
    relevance: { status: 'insufficient_data' },
    technical: { status: 'no_gap' }
  }
  const { primary, secondary, confidence } = rankGaps(dims)
  assert.strictEqual(primary, 'third_party')
  assert.strictEqual(secondary, 'content')
  assert.strictEqual(confidence, 'high')

  const actions = buildRecommendedActions(primary, secondary, dims)
  assert.strictEqual(actions.length, 2)
  assert.ok(actions[0].action.includes('g2.com'))
  assert.ok(actions[1].action.includes('Expand'))

  const existsNotRankingDims = { content: { status: 'gap', clientWordCount: 300, competitorWordCount: 1200, clientPageStatus: 'relevant_nonranking_page' } }
  const existsAction = buildRecommendedActions('content', null, existsNotRankingDims)
  assert.ok(existsAction[0].action.includes('already has a relevant page'), 'must not recommend creating a page that already exists')

  const noPageDims = { content: { status: 'gap', clientWordCount: null, competitorWordCount: 1200, clientPageStatus: 'no_relevant_page' } }
  const createAction = buildRecommendedActions('content', null, noPageDims)
  assert.ok(createAction[0].action.includes('Create a page'))

  const noIntentMatchDims = { content: { status: 'gap', clientWordCount: null, competitorWordCount: 1200, clientPageStatus: 'no_relevant_page', noPageReason: 'no_candidate_satisfies_intent' } }
  const wrongTypeAction = buildRecommendedActions('content', null, noIntentMatchDims)
  assert.ok(wrongTypeAction[0].action.includes('right TYPE of page'), 'must distinguish "wrong page type exists" from "no page exists at all"')

  const none = rankGaps({ third_party: { status: 'no_gap' }, content: { status: 'insufficient_data' } })
  assert.strictEqual(none.primary, null)
  assert.strictEqual(none.confidence, 'insufficient_data')

  // Page-matching uncertainty must never surface as a content gap, and
  // therefore can never become primary_gap -- computeContentGap already
  // guarantees 'uncertain' maps to insufficient_data (tested above); this
  // confirms rankGaps has no separate path that could override that.
  const uncertainDims = { content: computeContentGap({ competitorPage: { url: 'https://c.com', wordCount: 900, fetchFailed: false }, clientPage: null, clientPageDiscovery: { status: 'uncertain', uncertainReason: 'sitemap_unreachable' } }) }
  const uncertainRank = rankGaps(uncertainDims)
  assert.strictEqual(uncertainRank.primary, null, 'uncertain page-matching must never default primary_gap to content')
  log('PASS rankGaps/buildRecommendedActions')
}

log('ALL PASS')
