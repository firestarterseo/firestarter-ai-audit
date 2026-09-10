// Pure tests for lib/pageIntentMatch.js -- plain Node, no network. The
// heuristic layer is fully covered here; the Anthropic-backed refinement
// path itself is exercised live (same convention as lib/keywordRelevance.js,
// which has no unit test either -- callAnthropicTool has no injectable
// fetcher), not by a mocked unit test.

const assert = require('assert')
const { classifyPromptIntentHeuristic, heuristicPageFit, evaluatePageIntentMatch, safePathFromUrl } = require('./pageIntentMatch')

function log(msg) { console.log(msg) }

// --- classifyPromptIntentHeuristic ---
{
  assert.strictEqual(classifyPromptIntentHeuristic('window world vs 303 windows').intent, 'comparison')
  assert.strictEqual(classifyPromptIntentHeuristic('how much do replacement windows cost in denver').intent, 'pricing')
  assert.strictEqual(classifyPromptIntentHeuristic('how to measure your windows for replacement').intent, 'informational_how_to')
  assert.strictEqual(classifyPromptIntentHeuristic('best window replacement company denver').intent, 'reputation_best_provider')
  assert.strictEqual(classifyPromptIntentHeuristic('replacement windows denver').intent, 'local_commercial_service')
  assert.strictEqual(classifyPromptIntentHeuristic('sliding patio doors').intent, 'product_service_category')
  log('PASS classifyPromptIntentHeuristic')
}

// --- heuristicPageFit: the exact motivating JDI case ---
{
  const howToArticle = { url: 'https://jdiwindows.com/how-to-measure-your-windows-for-replacement-the-complete-denver-homeowners-guide/', path: '/how-to-measure-your-windows-for-replacement-the-complete-denver-homeowners-guide/', type: 'Article' }
  const commercialPage = { url: 'https://jdiwindows.com/denver-window-replacement/', path: '/denver-window-replacement/', type: 'Service' }

  const howToFit = heuristicPageFit(howToArticle, 'local_commercial_service', 0)
  assert.strictEqual(howToFit.satisfies_intent, false, 'a how-to article must not satisfy a local_commercial_service intent, even with strong title overlap')
  assert.strictEqual(howToFit.page_type, 'how-to / informational article')

  const commercialFit = heuristicPageFit(commercialPage, 'local_commercial_service', 1)
  assert.strictEqual(commercialFit.satisfies_intent, true)
  assert.strictEqual(commercialFit.page_type, 'commercial service/location page')

  // The same how-to article SHOULD satisfy an informational_how_to intent.
  assert.strictEqual(heuristicPageFit(howToArticle, 'informational_how_to', 0).satisfies_intent, true)
  log('PASS heuristicPageFit (motivating JDI how-to-vs-commercial case)')
}

// --- evaluatePageIntentMatch: fallback path (no API key -> heuristic, never blocks) ---
{
  (async () => {
    const candidates = [
      { url: 'https://jdiwindows.com/how-to-measure-your-windows-for-replacement-the-complete-denver-homeowners-guide/', path: '/how-to-measure-your-windows-for-replacement-the-complete-denver-homeowners-guide/', type: 'Article', source: 'sitemap' },
      { url: 'https://jdiwindows.com/denver-window-replacement/', path: '/denver-window-replacement/', type: 'Service', source: 'sitemap' }
    ]
    const result = await evaluatePageIntentMatch({ promptText: 'replacement windows denver', competitorPage: { url: 'https://competitor.com/x', title: 'Denver Window Replacement', h1: 'Windows' }, candidates, apiKey: null })
    assert.strictEqual(result.llmUsed, false)
    assert.strictEqual(result.intentSource, 'heuristic')
    assert.strictEqual(result.intent, 'local_commercial_service')
    assert.strictEqual(result.bestIndex, 1, 'must pick the commercial page (index 1), not the how-to article (index 0), even with a missing API key')

    const noCandidates = await evaluatePageIntentMatch({ promptText: 'x', competitorPage: null, candidates: [], apiKey: null })
    assert.strictEqual(noCandidates.bestIndex, null)
    log('PASS evaluatePageIntentMatch (heuristic fallback, no API key)')
  })().catch(e => { console.error('FAIL evaluatePageIntentMatch fallback:', e); process.exitCode = 1 })
}

// --- safePathFromUrl ---
{
  assert.strictEqual(safePathFromUrl('https://example.com/about/'), '/about/')
  assert.strictEqual(safePathFromUrl('not a url'), 'not a url')
  log('PASS safePathFromUrl')
}

log('ALL PASS (sync portion; async fallback test logs its own PASS/FAIL above)')
