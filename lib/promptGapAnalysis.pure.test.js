// Pure tests for lib/promptGapAnalysis.js -- plain Node, no DB, no LLM, no
// network. Run with: node lib/promptGapAnalysis.pure.test.js

const assert = require('assert')
const {
  tokenize, overlapTerms, fuzzyOverlapTerms, rankShortlistCandidates, extractPromptLocation,
  extractTitleAndH1, extractHeadings, extractInternalLinks,
  classifyEngineRow, classifyPromptOutcome,
  pickUrlForDomain, formatEngineOutcomes, bestEffortDomainName, containsHrefToDomain,
  computeContentGap, computeRelevanceGap, computeTechnicalGap,
  computeAuthorityGap, computeThirdPartyGap, partitionThirdPartySources,
  tallyRecurringCoCitations, mergeHostnameInspections,
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

// --- fuzzyOverlapTerms / rankShortlistCandidates: REAL REGRESSION (2026-09-11)
// -- JDI's real, first-party "Custom Replacement Windows" page
// (/denver-custom-window-replacement/) was excluded from client-page
// discovery's sitemap shortlist for the prompt "custom windows denver",
// even though it was present in the sitemap and is exactly the right page.
// Root cause, reproduced exactly here with the real candidate set: (1)
// tokenize()/overlapTerms() did no singular/plural normalization, so the
// prompt's "windows" never matched the page's URL-slug "window", costing
// it a full overlap point against blog-article slugs that happened to
// contain the literal plural; (2) ties on overlap count broke on arbitrary
// sitemap order, with no preference for a commercial page type over an
// Article. Both combined meant two informational blog posts won the only
// two other shortlist slots ahead of the real commercial page, which was
// never fetched, never intent-evaluated, and never considered -- the
// system then concluded "no relevant page exists" and proposed creating a
// duplicate page instead of improving the real one. ---
{
  const promptText = 'custom windows denver'
  const realJdiCandidatePages = [
    { path: '/denver-custom-window-replacement/', type: 'Other' }, // the real, missed commercial page
    { path: '/4-great-options-custom-windows-denver/', type: 'Article' },
    { path: '/new-year-new-custom-windows/', type: 'Article' },
    { path: '/denver-garden-windows/', type: 'Article' },
    { path: '/denver-picture-windows/', type: 'Article' },
    { path: '/windows-100-series/', type: 'Other' }
  ]

  // The narrow singular/plural equivalence itself: "windows" (prompt) must
  // recognize "window" (page slug) as the same term.
  const fuzzy = fuzzyOverlapTerms(tokenize('custom windows denver'), tokenize('denver-custom-window-replacement other'))
  assert.deepStrictEqual(fuzzy.sort(), ['custom', 'denver', 'windows'], 'the prompt\'s "windows" must match the page slug\'s singular "window"')
  // A short, unrelated word must never be mangled by the >=5-char guard.
  assert.deepStrictEqual(fuzzyOverlapTerms(tokenize('gas fill'), tokenize('gas')), ['gas'], 'short words like "gas" must not be stripped/mismatched by the plural heuristic')

  const ranked = rankShortlistCandidates(promptText, realJdiCandidatePages)
  const top3Paths = ranked.slice(0, 3).map(r => r.page.path)
  assert.ok(top3Paths.includes('/denver-custom-window-replacement/'), 'the real commercial page must win a shortlist slot, not be silently excluded')
  assert.strictEqual(ranked[0].page.path, '/denver-custom-window-replacement/', 'tied on overlap count with an Article, the real commercial (non-Article) page must rank first')
  assert.strictEqual(ranked[0].overlap.length, 3, 'must get full credit for all three prompt terms, including "windows" via the page slug\'s "window"')
  log('PASS fuzzyOverlapTerms/rankShortlistCandidates (real JDI "custom windows denver" existing-page-miss regression)')
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

// --- extractHeadings / extractInternalLinks ---
{
  const html = '<h1>Ignored</h1><h2>Sliding Patio Doors</h2><p>text</p><h3>Colors</h3>'
  const headings = extractHeadings(html)
  assert.strictEqual(headings.length, 2, 'H1 must be excluded -- extractTitleAndH1 already owns that signal')
  assert.deepStrictEqual(headings[0], { level: 'H2', text: 'Sliding Patio Doors' })

  const linkHtml = '<a href="/locations/denver-sliding-doors">Denver Sliding Doors</a><a href="https://other.com/x">Other site</a><a href="/about">About</a>'
  const links = extractInternalLinks(linkHtml, 'jdiwindows.com')
  assert.strictEqual(links.length, 2, 'only same-domain/relative hrefs count as internal')
  assert.ok(links.some(l => l.anchorText === 'Denver Sliding Doors'))
  assert.strictEqual(extractInternalLinks(linkHtml, null).length, 0)
  log('PASS extractHeadings/extractInternalLinks')
}

// --- computeRelevanceGap (DEEPENED, 2026-09-11): real JDI "sliding patio
// doors denver" motivating case -- title/H1-only overlap used to conclude
// "no gap beyond title/H1," when the page is really missing dedicated
// heading coverage, body mentions, location structure, and internal links
// the competitor has. ---
{
  const promptText = 'sliding patio doors denver'
  const competitorPage = {
    url: 'https://windowworldcolorado.com/doors',
    title: 'Sliding Patio Doors Denver', h1: 'Sliding Patio Doors in Denver, CO', fetchFailed: false,
    html: `<html><body><h1>Sliding Patio Doors in Denver, CO</h1>
      <h2>Sliding Patio Door Installation in Denver</h2><p>We install sliding patio doors across Denver.</p>
      <a href="/locations/denver-sliding-doors">Denver Sliding Doors</a>
      </body></html>`
  }
  const clientPageWeak = {
    url: 'https://jdiwindows.com/doors/',
    // NOTE: title deliberately does NOT contain "Denver" -- the prompt's
    // real target location (see extractPromptLocation) -- so this fixture
    // still genuinely exercises location_not_structural post-fix, rather
    // than accidentally satisfying it via a title-token bleed-through.
    title: 'Patio Doors - JDI Windows', h1: 'Altius Windows and Doors', fetchFailed: false,
    html: `<html><body><h1>Altius Windows and Doors</h1>
      <h2>Altius I Patio Door</h2><p>Sliding patio doors can be built up to 16 feet wide, popular with Denver homeowners. Mentions Littleton once.</p>
      </body></html>`
  }
  const client = { domain: 'jdiwindows.com', city: 'Littleton', region: 'Colorado' }
  const clientPageDiscovery = {
    intent: 'local_commercial_service', intentSource: 'heuristic',
    pageType: 'commercial service/location page', matchConfidence: 'low',
    competitorIntentMatch: { page_type: 'commercial service/location page', satisfies_intent: true }
  }

  const result = computeRelevanceGap({ promptText, competitorPage, clientPage: clientPageWeak, client, clientPageDiscovery })
  assert.strictEqual(result.status, 'gap')
  const deficitTypes = result.deficits.map(d => d.type)
  assert.ok(deficitTypes.includes('title_h1_terms'), 'client title/H1 is missing "sliding"')
  assert.ok(deficitTypes.includes('heading_terms'), 'client has no H2/H3 built around "sliding"/"denver" -- only a product-model heading')
  assert.ok(deficitTypes.includes('page_intent_mismatch'), 'competitor page satisfies the classified intent at high confidence; client page is only low-confidence')
  const locationDeficit = result.deficits.find(d => d.type === 'location_not_structural')
  assert.ok(locationDeficit, 'Denver -- the prompt\'s own target location -- is mentioned once in body copy but has no heading built around it')
  assert.deepStrictEqual(locationDeficit.terms, ['denver'], 'the target location must be Denver (derived from the prompt), never Littleton (the client\'s registered city, not named in this prompt)')
  assert.ok(deficitTypes.includes('internal_link_support'), 'competitor links to a relevant location page; client page has no comparable internal link')
  assert.ok(!deficitTypes.includes('body_topic_coverage'), '"sliding" IS present in the client body copy -- this tier must not double-flag what heading_terms already caught')
  log('PASS computeRelevanceGap (deepened: heading/body/intent/location/internal-link signals, real JDI motivating case)')
}

// --- computeRelevanceGap: location_absent (the prompt's target location
// never mentioned at all, anywhere on the page) ---
{
  const promptText = 'sliding patio doors denver'
  const competitorPage = { url: 'https://c.com/x', title: 'Sliding Patio Doors Denver', h1: 'Sliding Patio Doors Denver', fetchFailed: false, html: '<h1>Sliding Patio Doors Denver</h1>' }
  // "Denver" (the prompt's real target -- not the client's registered
  // Littleton) never appears anywhere on this client page.
  const clientPage = { url: 'https://jdiwindows.com/doors/', title: 'Sliding Patio Doors - JDI Windows', h1: 'Sliding Patio Doors', fetchFailed: false, html: '<html><body><h1>Sliding Patio Doors</h1><p>We install sliding patio doors with quality craftsmanship.</p></body></html>' }
  const client = { domain: 'jdiwindows.com', city: 'Littleton', region: 'Colorado' }
  const result = computeRelevanceGap({ promptText, competitorPage, clientPage, client })
  const locationDeficit = result.deficits.find(d => d.type === 'location_absent')
  assert.ok(locationDeficit, 'the prompt\'s target location (Denver) never appears anywhere on the page')
  assert.deepStrictEqual(locationDeficit.terms, ['denver'], 'must flag the prompt\'s own target location, never the client\'s registered Littleton, which this prompt never names')
  log('PASS computeRelevanceGap (location_absent for the prompt\'s own target location, never the client\'s registered city)')
}

// --- computeRelevanceGap: no_gap when client matches or exceeds every signal ---
{
  const promptText = 'sliding patio doors denver'
  const sharedHtml = '<h1>Sliding Patio Doors in Denver, Littleton CO</h1><h2>Sliding Patio Door Installation in Denver</h2><a href="/locations/denver">Denver</a>'
  const competitorPage = { url: 'https://c.com/x', title: 'Sliding Patio Doors Denver', h1: 'Sliding Patio Doors in Denver, Littleton CO', fetchFailed: false, html: sharedHtml }
  const clientPage = { url: 'https://jdiwindows.com/doors/', title: 'Sliding Patio Doors Denver', h1: 'Sliding Patio Doors in Denver, Littleton CO', fetchFailed: false, html: sharedHtml }
  const client = { domain: 'jdiwindows.com', city: 'Littleton', region: 'Colorado' }
  const result = computeRelevanceGap({ promptText, competitorPage, clientPage, client })
  assert.strictEqual(result.status, 'no_gap')
  assert.strictEqual(result.deficits.length, 0)
  log('PASS computeRelevanceGap (no_gap when client matches every signal -- never fabricates a deficit)')
}

// --- extractPromptLocation: unit coverage ---
{
  const client = { city: 'Littleton', region: 'Colorado' }

  const denverPrompt = extractPromptLocation('custom windows denver', client)
  assert.deepStrictEqual(denverPrompt, { tokens: ['denver'], source: 'prompt_derived' }, 'the prompt names Denver -- never substitute the client\'s registered Littleton')

  const littletonPrompt = extractPromptLocation('replacement windows littleton co', client)
  assert.deepStrictEqual(littletonPrompt, { tokens: ['littleton'], source: 'client_location_named_in_prompt' }, 'the prompt names the client\'s own city -- correctly recognized as the prompt\'s target')

  const noLocationPrompt = extractPromptLocation('custom windows', client)
  assert.strictEqual(noLocationPrompt, null, 'no non-generic token remains -- no clear location expressed')

  assert.strictEqual(extractPromptLocation('', client), null)
  log('PASS extractPromptLocation (Denver vs. Littleton vs. no-location prompts)')
}

// --- computeRelevanceGap CASE A (real JDI regression, 2026-09-11): prompt
// "custom windows denver", client registered in Littleton. The client's
// real page (/denver-custom-window-replacement/) has "Denver" structurally
// in an H2 ("Custom Replacement Windows in Denver") but never mentions
// Littleton in any heading. Before the fix, this produced a false
// location_not_structural deficit off Littleton alone. After the fix, the
// prompt's own target (Denver) is what's evaluated, and Denver IS
// structurally present -- no location deficit at all. ---
{
  const promptText = 'custom windows denver'
  const competitorPage = {
    url: 'https://www.windowworldcolorado.com/windows/custom/',
    title: 'Custom Windows Denver', h1: 'Custom Windows', fetchFailed: false,
    html: '<html><body><h1>Custom Windows</h1><h2>Custom Windows in Denver</h2><p>Custom windows for Denver homes.</p></body></html>'
  }
  const clientPage = {
    url: 'https://jdiwindows.com/denver-custom-window-replacement/',
    title: 'Custom Replacement Windows Denver - JDI Windows', h1: 'Custom Replacement Windows', fetchFailed: false,
    html: `<html><body><h1>Custom Replacement Windows</h1>
      <h2>Custom Replacement Windows in Denver</h2>
      <p>JDI Windows is based in Littleton, Colorado and serves the greater Denver metro area with custom windows.</p>
      </body></html>`
  }
  const client = { domain: 'jdiwindows.com', city: 'Littleton', region: 'Colorado' }
  const result = computeRelevanceGap({ promptText, competitorPage, clientPage, client })
  const deficitTypes = result.deficits.map(d => d.type)
  assert.ok(!deficitTypes.includes('location_not_structural') && !deficitTypes.includes('location_absent'),
    'Denver (the prompt\'s target) is structurally present in an H2 -- Littleton (the client\'s registered city, not named in this prompt) must never be required')
  log('PASS computeRelevanceGap CASE A ("custom windows denver" -- Littleton is not required)')
}

// --- computeRelevanceGap CASE B (real JDI regression): prompt "replacement
// windows littleton co", client registered in Littleton. Littleton IS the
// prompt's own target here (requirement 3's first exception), so
// Littleton-specific structural relevance must still be evaluated
// normally -- this is not a blanket "never check Littleton" fix. ---
{
  const promptText = 'replacement windows littleton co'
  const competitorPage = {
    url: 'https://competitor.com/littleton',
    title: 'Replacement Windows Littleton CO', h1: 'Replacement Windows in Littleton, CO', fetchFailed: false,
    html: '<html><body><h1>Replacement Windows in Littleton, CO</h1><h2>Littleton Window Replacement Services</h2><p>We replace windows throughout Littleton.</p></body></html>'
  }
  const clientPageNoHeading = {
    url: 'https://jdiwindows.com/denver-window-replacement/',
    title: 'Replacement Windows Denver Colorado - JDI Windows', h1: 'Replacement Windows', fetchFailed: false,
    html: '<html><body><h1>Replacement Windows</h1><h2>Our Replacement Window Process</h2><p>We serve Littleton and the greater Denver metro area.</p></body></html>'
  }
  const client = { domain: 'jdiwindows.com', city: 'Littleton', region: 'Colorado' }
  const resultNoHeading = computeRelevanceGap({ promptText, competitorPage, clientPage: clientPageNoHeading, client })
  const locationDeficit = resultNoHeading.deficits.find(d => d.type === 'location_not_structural')
  assert.ok(locationDeficit, 'Littleton IS this prompt\'s own target location -- it must still be evaluated, and here it\'s body-only, not structural')
  assert.deepStrictEqual(locationDeficit.terms, ['littleton'])

  // Same prompt, but the client page DOES structure itself around Littleton -- no deficit.
  const clientPageWithHeading = {
    url: 'https://jdiwindows.com/littleton-window-company/',
    title: 'Littleton Window Company - JDI Windows', h1: 'Replacement Windows in Littleton, Colorado', fetchFailed: false,
    html: '<html><body><h1>Replacement Windows in Littleton, Colorado</h1><h2>Littleton Window Replacement Services</h2><p>We replace windows throughout Littleton.</p></body></html>'
  }
  const resultWithHeading = computeRelevanceGap({ promptText, competitorPage, clientPage: clientPageWithHeading, client })
  assert.ok(!resultWithHeading.deficits.some(d => d.type === 'location_not_structural' || d.type === 'location_absent'), 'Littleton is already structural (H1) -- no location deficit')
  log('PASS computeRelevanceGap CASE B ("replacement windows littleton co" -- Littleton-specific relevance still evaluated normally)')
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
  // relevance action text is now built from every real deficit
  // computeRelevanceGap found, not just title/heading terms.
  const relevanceDims = { relevance: { status: 'gap', competitorMatchedTerms: ['sliding'], deficits: [
    { type: 'title_h1_terms', terms: ['sliding'], detail: 'Missing "sliding" in title/H1.' },
    { type: 'location_not_structural', terms: ['littleton'], detail: 'Littleton is only in body copy, not a heading.' }
  ] } }
  const relevanceAction = buildRecommendedActions('relevance', null, relevanceDims)
  assert.ok(relevanceAction[0].action.includes('Missing "sliding"') && relevanceAction[0].action.includes('Littleton is only in body copy'), 'must concatenate every real deficit, not just title/heading terms')

  const relevanceNoDeficits = buildRecommendedActions('relevance', null, { relevance: { status: 'gap', competitorMatchedTerms: ['sliding'], deficits: [] } })
  assert.ok(relevanceNoDeficits[0].action.includes('Retarget'), 'falls back to the original title/heading phrasing when no structured deficits are present')
  log('PASS rankGaps/buildRecommendedActions')
}

// --- tallyRecurringCoCitations: the off-site/entity deepening's candidate
// source #1 -- a domain co-cited with this SAME competitor across 2+
// DIFFERENT prompts is a recurring pattern; a domain seen alongside the
// competitor for only ONE prompt is not (that's the same-response check's
// job, not this one's). ---
{
  const competitorDomain = '303windows.com'
  const excludeDomains = new Set([])
  const rows = [
    { raw: { prompt: 'custom windows denver', thirdPartySourceUrls: ['https://www.303windows.com/a', 'https://directoryA.com/303windows'] } },
    { raw: { prompt: 'window replacement denver', thirdPartySourceUrls: ['https://www.303windows.com/b', 'https://directoryA.com/listing'] } },
    { raw: { prompt: 'replacement windows denver', thirdPartySourceUrls: ['https://www.303windows.com/c', 'https://oneoffsite.com/x'] } },
    // A row citing directoryA.com WITHOUT the competitor must never count
    // toward the tally -- only co-citation WITH this competitor matters.
    { raw: { prompt: 'unrelated prompt', thirdPartySourceUrls: ['https://directoryA.com/other'] } }
  ]
  const recurring = tallyRecurringCoCitations(rows, competitorDomain, excludeDomains)
  const directoryA = recurring.find(r => r.hostname === 'directorya.com')
  assert.ok(directoryA, 'directoryA.com co-cited with the competitor across 2 distinct prompts must surface')
  assert.strictEqual(directoryA.promptCount, 2)
  assert.ok(!recurring.some(r => r.hostname === 'oneoffsite.com'), 'a domain co-cited for only 1 prompt must not count as recurring')
  assert.ok(!recurring.some(r => r.hostname === competitorDomain), 'the competitor\'s own domain must never appear in its own tally')

  // excludeDomains (e.g. the client's own domain) must be filtered out too.
  const withExclusion = tallyRecurringCoCitations(rows, competitorDomain, new Set(['directorya.com']))
  assert.ok(!withExclusion.some(r => r.hostname === 'directorya.com'))
  log('PASS tallyRecurringCoCitations')
}

// --- mergeHostnameInspections ---
{
  const merged = mergeHostnameInspections(
    [{ hostname: 'a.com', status: 'insufficient_data', reason: 'fetch failed' }],
    [{ hostname: 'a.com', status: 'verified_present', reason: 'mentions competitor' }, { hostname: 'b.com', status: 'verified_absent' }]
  )
  assert.strictEqual(merged.length, 2)
  const a = merged.find(m => m.hostname === 'a.com')
  assert.strictEqual(a.status, 'verified_present', 'a later verified_present result must win over an earlier insufficient_data one for the same hostname')
  log('PASS mergeHostnameInspections')
}

// --- computeThirdPartyGap: discovery-method-annotated evidence (recurring
// cross-prompt pattern vs. a high-importance client_sources gap) ---
{
  const clientSourcesByDomain = new Map([['directorya.com', { client_presence_status: 'absent' }]])
  const result = computeThirdPartyGap({
    hostnameInspections: [{ hostname: 'directorya.com', status: 'verified_present', discoveryMethod: 'recurring_co_citation', promptCount: 3 }],
    clientSourcesByDomain, sourcesEverSynced: true
  })
  assert.strictEqual(result.status, 'gap')
  assert.ok(result.evidence.some(e => e.includes('recurring') && e.includes('3 different prompts')))
  log('PASS computeThirdPartyGap discovery-method annotations')
}

log('ALL PASS')
