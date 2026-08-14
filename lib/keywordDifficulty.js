// Real, live Ahrefs Keyword Difficulty (KD) evidence for keyword-
// opportunity candidates -- the actual answer to "how hard would this be
// to rank for," computed by Ahrefs from the real backlink profiles of the
// pages currently ranking, on the same 0-100 scale as domain rating.
//
// Added 2026-08-15 as the direct fix for a fair complaint: even after the
// SERP-landscape and domain-rating fixes shipped the same day,
// realistic_tier was still fundamentally an LLM's read of domain names,
// not a number anyone could check. See lib/keywordRelevance.js's
// computeRealisticTier for how KD gets combined with the client's own
// domain rating into an actual formula.
//
// One Ahrefs call for the WHOLE candidate list (capped at
// MAX_KEYWORD_OPPORTUNITIES, 15) -- Keywords Explorer's overview endpoint
// accepts a comma-separated list of keywords, so this does not scale per
// keyword the way the SERP-landscape Cloro check does.
//
// Fails safe, same convention as every other optional enrichment here: a
// failed call just leaves every candidate's keywordDifficulty as null,
// and lib/keywordRelevance.js's computeRealisticTier falls back to the
// LLM's own judgment when it's missing -- never blocks the opportunity or
// the audit run.

const { getKeywordDifficulty } = require('./checkers/ahrefs')

// annotateWithKeywordDifficulty(keywordOpportunities, opts) -> Promise<Array<
//   opportunity & { keywordDifficulty: number | null, keywordDifficultyChecked: boolean }
// >>
async function annotateWithKeywordDifficulty(keywordOpportunities, { apiKey, country = 'us' } = {}) {
  if (!Array.isArray(keywordOpportunities) || keywordOpportunities.length === 0) return keywordOpportunities || []

  const keywords = keywordOpportunities.map(o => o.keyword).filter(Boolean)
  const { results, error } = await getKeywordDifficulty(keywords, { apiKey, country })

  if (error) {
    return keywordOpportunities.map(o => ({ ...o, keywordDifficulty: null, keywordDifficultyChecked: false, keywordDifficultyError: error.message }))
  }

  const byKeyword = new Map(results.map(r => [r.keyword.toLowerCase().trim(), r.difficulty]))
  return keywordOpportunities.map(o => {
    const key = String(o.keyword || '').toLowerCase().trim()
    const difficulty = byKeyword.has(key) ? byKeyword.get(key) : null
    return { ...o, keywordDifficulty: difficulty, keywordDifficultyChecked: byKeyword.has(key) }
  })
}

module.exports = { annotateWithKeywordDifficulty }
