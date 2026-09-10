// Pure tests for lib/promptGapAnalysis.js -- plain Node, no DB, no LLM, no
// network. Run with: node lib/promptGapAnalysis.pure.test.js

const assert = require('assert')
const {
  tokenize, overlapTerms, extractTitleAndH1, classifyPromptOutcome,
  computeContentGap, computeRelevanceGap, computeTechnicalGap,
  computeAuthorityGap, computeThirdPartyGap, rankGaps, buildRecommendedActions
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

// --- classifyPromptOutcome ---
{
  const competitorDomains = new Set(['competitor.com'])
  const rows = [
    {
      run_at: '2026-09-01T00:00:00Z', brand_mentioned: false,
      raw: { prompt: 'best window replacement company in denver', thirdPartySourceUrls: ['https://competitor.com/denver-windows'], sourceUrls: ['https://competitor.com/denver-windows'] }
    },
    {
      run_at: '2026-08-01T00:00:00Z', brand_mentioned: true,
      raw: { prompt: 'best window replacement company in denver', thirdPartySourceUrls: [] }
    }
  ]
  const outcome = classifyPromptOutcome(rows, 'best window replacement company in denver', competitorDomains)
  assert.strictEqual(outcome.status, 'losing', 'most recent row should be used, not the older winning one')
  assert.strictEqual(outcome.competitorHits.length, 1)
  assert.strictEqual(outcome.competitorHits[0].domain, 'competitor.com')

  const noData = classifyPromptOutcome(rows, 'a totally different prompt', competitorDomains)
  assert.strictEqual(noData.status, 'no_data')

  const winning = classifyPromptOutcome([{ run_at: '2026-09-01T00:00:00Z', brand_mentioned: true, raw: { prompt: 'p', thirdPartySourceUrls: [] } }], 'p', competitorDomains)
  assert.strictEqual(winning.status, 'winning')

  const noSignal = classifyPromptOutcome([{ run_at: '2026-09-01T00:00:00Z', brand_mentioned: false, raw: { prompt: 'p', thirdPartySourceUrls: [] } }], 'p', competitorDomains)
  assert.strictEqual(noSignal.status, 'no_signal')
  log('PASS classifyPromptOutcome')
}

// --- computeContentGap ---
{
  const competitorPage = { url: 'https://competitor.com/x', wordCount: 1200, fetchFailed: false }
  assert.strictEqual(computeContentGap({ competitorPage, clientPage: null }).status, 'gap')
  assert.strictEqual(computeContentGap({ competitorPage: { fetchFailed: true }, clientPage: null }).status, 'insufficient_data')
  assert.strictEqual(computeContentGap({ competitorPage, clientPage: { url: 'https://client.com/x', wordCount: 1000, fetchFailed: false } }).status, 'no_gap')
  assert.strictEqual(computeContentGap({ competitorPage, clientPage: { url: 'https://client.com/x', wordCount: 300, fetchFailed: false } }).status, 'gap')
  log('PASS computeContentGap')
}

// --- computeRelevanceGap ---
{
  const promptText = 'best window replacement company in denver'
  const competitorPage = { title: 'Denver Window Replacement Experts', h1: 'Window Replacement in Denver', fetchFailed: false }
  const clientPageStrong = { title: 'Denver Window Replacement | Acme', h1: 'Window Replacement Denver', fetchFailed: false }
  const clientPageWeak = { title: 'Acme Home Services', h1: 'Welcome', fetchFailed: false }
  assert.strictEqual(computeRelevanceGap({ promptText, competitorPage, clientPage: clientPageWeak }).status, 'gap')
  assert.strictEqual(computeRelevanceGap({ promptText, competitorPage, clientPage: clientPageStrong }).status, 'no_gap')
  assert.strictEqual(computeRelevanceGap({ promptText, competitorPage: null, clientPage: clientPageStrong }).status, 'insufficient_data')
  log('PASS computeRelevanceGap')
}

// --- computeTechnicalGap ---
{
  const withSchema = { html: '<script type="application/ld+json">{"@type":"LocalBusiness","name":"X","address":"Y"}</script>', fetchFailed: false }
  const withoutSchema = { html: '<html><body>no schema here</body></html>', fetchFailed: false }
  assert.strictEqual(computeTechnicalGap({ competitorPage: withSchema, clientPage: withoutSchema }).status, 'gap')
  assert.strictEqual(computeTechnicalGap({ competitorPage: withSchema, clientPage: withSchema }).status, 'no_gap')
  assert.strictEqual(computeTechnicalGap({ competitorPage: withSchema, clientPage: null }).status, 'insufficient_data')
  log('PASS computeTechnicalGap')
}

// --- computeAuthorityGap ---
{
  const clientAuthority = { authorityReferringDomains: [{ domain: 'forbes.com' }], error: null }
  const competitorAuthority = { authorityReferringDomains: [{ domain: 'forbes.com' }, { domain: 'inc.com' }], error: null }
  assert.strictEqual(computeAuthorityGap({ clientAuthority, competitorAuthority }).status, 'gap')
  assert.strictEqual(computeAuthorityGap({ clientAuthority: competitorAuthority, competitorAuthority }).status, 'no_gap')
  assert.strictEqual(computeAuthorityGap({ clientAuthority: { error: { message: 'no key' } }, competitorAuthority }).status, 'insufficient_data')
  log('PASS computeAuthorityGap')
}

// --- computeThirdPartyGap ---
{
  const clientSourcesByDomain = new Map([
    ['g2.com', { client_presence_status: 'absent' }],
    ['clutch.co', { client_presence_status: 'appears_in_cited_content_verified' }]
  ])
  const gapResult = computeThirdPartyGap({
    thirdPartyHostnames: ['g2.com', 'clutch.co', 'competitor.com'],
    excludeDomains: new Set(['competitor.com']),
    clientSourcesByDomain
  })
  assert.strictEqual(gapResult.status, 'gap')
  assert.deepStrictEqual(gapResult.absentSources, ['g2.com'])

  const noGapResult = computeThirdPartyGap({
    thirdPartyHostnames: ['clutch.co'],
    excludeDomains: new Set(),
    clientSourcesByDomain
  })
  assert.strictEqual(noGapResult.status, 'no_gap')

  const insufficient = computeThirdPartyGap({ thirdPartyHostnames: [], excludeDomains: new Set(), clientSourcesByDomain })
  assert.strictEqual(insufficient.status, 'insufficient_data')

  const noSync = computeThirdPartyGap({ thirdPartyHostnames: ['g2.com'], excludeDomains: new Set(), clientSourcesByDomain: new Map() })
  assert.strictEqual(noSync.status, 'insufficient_data')
  log('PASS computeThirdPartyGap')
}

// --- rankGaps / buildRecommendedActions ---
{
  const dims = {
    third_party: { status: 'gap', absentSources: ['g2.com'] },
    content: { status: 'gap', clientWordCount: 300, competitorWordCount: 1200 },
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

  const none = rankGaps({ third_party: { status: 'no_gap' }, content: { status: 'insufficient_data' } })
  assert.strictEqual(none.primary, null)
  assert.strictEqual(none.confidence, 'insufficient_data')
  log('PASS rankGaps/buildRecommendedActions')
}

log('ALL PASS')
