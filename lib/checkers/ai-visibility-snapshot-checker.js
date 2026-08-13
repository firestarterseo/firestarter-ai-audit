// AI & GEO Visibility SNAPSHOT checker -- the Lead Capture counterpart to
// ai-visibility-checker.js.
//
// ai-visibility-checker.js reads sourcehq's tracked, repeated-over-time
// runs for an EXISTING client. That has no answer for a brand-new lead who
// just submitted a URL: there's no history to read, because nothing has
// been tracking them. Per the 2026-08-07 decision, this tool now calls
// Cloro directly for that case -- one live, on-demand query per engine, at
// audit time, using its own API key (separate from whatever key sourcehq
// uses; same infra-separation principle as the dedicated PageSpeed key).
//
// This is deliberately a DIFFERENT, lighter measurement than the tracked
// pillar, and says so in its own output (`snapshot: true`): one moment in
// time, averaged across engines queried, not a trend averaged across many
// runs over weeks. It should never be presented as equivalent to a tracked
// score for the same client.
//
// STATUS (updated 2026-08-13): per direct client feedback ("if Forbes rates
// us the best SEO company this carries more weight than if I say I am the
// best SEO company"), citation scoring is no longer a plain "cited or not"
// boolean. Each mention now earns a 0/0.5/0.75/1 citation tier: nothing
// cited = 0, cited only via the business's own domain = 0.5, cited via an
// independent third-party source = 0.75, cited via a recognized authority
// domain (see lib/authorityDomains.js -- Forbes, G2, Yelp, etc.) = 1. A
// negative-sentiment mention earns no citation credit regardless of source.
// See citationTier() below.
//
// STATUS (updated 2026-08-11): per direct client feedback, engines are not
// weighted equally any more (Google/ChatGPT/Gemini matter more than
// Perplexity for this business -- see ENGINE_WEIGHTS below) and Copilot has
// been dropped from the default engine set entirely ("no one cares about
// copilot"). Mention/citation/sentiment/coverage shares are now weighted
// sums, not simple counts -- a Google non-mention costs more than a
// Perplexity one. Every engineResult also now carries a responseSnippet and
// sourceUrls so a strategist can manually re-run the same prompt on the
// same engine and confirm the checker isn't the one that's wrong.
//
// STATUS (updated 2026-08-10): verified against real live calls through
// Cloro's own Playground for ALL FIVE engines -- chatgpt, google, gemini,
// perplexity, and copilot (copilot since removed, see above) -- each using
// the exact prompt this module auto-generates for Denver Tax Advisor. The
// chatgpt/google pass caught two real bugs the documented-shape assumption
// missed:
//   1. Google's engine does NOT share the chatgpt/gemini/perplexity/copilot
//      shape (result.text + result.sources). It has no result.text at all;
//      citable content lives in result.organicResults[].link and
//      result.localResults[].links.website, plus an optional
//      result.aioverview. extractEngineSignal() below now branches on this.
//   2. The AI Overview field is `aioverview`, not `ai-overview` -- the
//      original hyphenated key would have silently matched nothing, on
//      every call, forever. Also confirmed it can be absent entirely
//      (not even `null`) even when explicitly requested -- treat it as
//      optional on every call, not just when Google has none to show.
// The follow-up pass against gemini, perplexity, and copilot confirmed all
// three follow the same "default" (non-Google) shape already fixed above --
// no additional shape bugs found. All five real captures also independently
// showed Denver Tax Advisor completely absent from every engine's answer
// for this generic query -- a consistent 5-for-5 real-world finding, not a
// checker bug. Real captures for all five engines live in
// fixtures/cloro-live-captures/; see run-ai-visibility-snapshot-test.js for
// how they're used.

const { isAuthorityDomain } = require('../authorityDomains')

function scoreToGrade(score) {
  if (score >= 97) return 'A+'
  if (score >= 93) return 'A'
  if (score >= 90) return 'A-'
  if (score >= 87) return 'B+'
  if (score >= 83) return 'B'
  if (score >= 80) return 'B-'
  if (score >= 77) return 'C+'
  if (score >= 73) return 'C'
  if (score >= 70) return 'C-'
  if (score >= 67) return 'D+'
  if (score >= 63) return 'D'
  if (score >= 60) return 'D-'
  return 'F'
}

const DEFAULT_ENGINES = ['chatgpt', 'gemini', 'perplexity', 'google']

// Not every engine matters equally to this business -- per direct feedback,
// Google/ChatGPT/Gemini results should count more toward the score than
// Perplexity's. This is a deliberate business call, not a technical one; if
// it needs to change again, this is the only place it lives. Any engine not
// listed here (e.g. if Grok is ever enabled) defaults to weight 1 via
// DEFAULT_ENGINE_WEIGHT below, same tier as Perplexity.
const ENGINE_WEIGHTS = { chatgpt: 2, google: 2, gemini: 2, perplexity: 1 }
const DEFAULT_ENGINE_WEIGHT = 1
function weightOf(engine) {
  return ENGINE_WEIGHTS[engine] ?? DEFAULT_ENGINE_WEIGHT
}

// sumWeight(list) -> total weight of a list of {engine} objects. The shared
// building block for every weighted share below -- mention/citation/
// sentiment/coverage are now "what fraction of weight," not "what fraction
// of count."
function sumWeight(list) {
  return list.reduce((sum, item) => sum + weightOf(item.engine), 0)
}

// weightedAverage(list, valueFn) -> weighted mean of valueFn(item) across
// list, weighted by each item's engine weight. Used for citation strength
// below, which is now a graduated 0-1 value (self-citation vs third-party
// vs authority) rather than a plain boolean share.
function weightedAverage(list, valueFn) {
  const totalWeight = sumWeight(list)
  if (totalWeight === 0) return 0
  const weightedSum = list.reduce((sum, item) => sum + valueFn(item) * weightOf(item.engine), 0)
  return weightedSum / totalWeight
}

// BEST_LIST_PATTERNS / hasBestListFraming(text) -- per direct client
// feedback (2026-08-13), being named in a "Top 10," "Best X in [city],"
// or "recommended" style list is the strongest citation signal of all,
// stronger than a recognized-authority domain alone. This is a text
// heuristic, not a guarantee: Cloro gives one combined answer string per
// engine call for chatgpt/gemini/perplexity (no per-source snippet), so
// "was THIS SPECIFIC citation part of a best-list" can't be verified --
// this checks whether the response AS A WHOLE uses best-list framing, and
// if so, credits whatever third-party citation(s) that response has.
// Google is the one engine where a per-result title/snippet exists, but
// this same whole-text check is applied uniformly for simplicity.
const BEST_LIST_PATTERNS = [
  /\btop\s*\d+\b/i,          // "top 10", "top 5"
  /\btop[- ]rated\b/i,
  /\bbest\b[\s\S]{0,30}\bin\b/i, // "best ... in ..." (e.g. "best SEO agency in Denver")
  /\brecommended\b/i,
  /\bhighly recommended\b/i,
  /\bmust[- ]try\b/i,
  /\bleading\b/i,
  /\bpremier\b/i
]
function hasBestListFraming(text) {
  if (!text) return false
  return BEST_LIST_PATTERNS.some(re => re.test(text))
}

// citationTier(row) -> 0 to 1, how strong this mention's citation was.
// Per direct client feedback: self-citation (3), plain third-party mention
// (2), and being named in a best/top/recommended list (4) are NOT equally
// valuable, and self-citation specifically outranks a plain third-party
// mention -- "if you own the mention you potentially get the click," a
// real practical benefit a passing third-party name-drop doesn't carry.
// Mapped onto this checker's 0-1 scale (4 as the ceiling): no citation = 0,
// plain third-party mention = 0.5, self-citation = 0.75, a citation from a
// recognized authority domain (lib/authorityDomains.js) OR one using
// best-list framing = 1 (either signal alone is enough -- a Forbes mention
// that doesn't literally say "best," and a small local blog's genuine
// "Top 10" post that isn't on the curated domain list, should both count).
// A negative-sentiment mention never earns citation credit here even with
// a source present -- e.g. a lawsuit writeup citing the business isn't an
// endorsement just because it's third-party (sentiment is already
// penalized on its own via the separate sentiment score component, so this
// isn't double-counting a bad outcome, just declining to reward it twice
// as a "citation" too).
function citationTier({ mentioned, ownCited, thirdPartyCited, authorityCited, bestListCited, sentiment }) {
  if (!mentioned) return 0
  if (sentiment === 'negative') return 0
  if (authorityCited || bestListCited) return 1
  if (ownCited) return 0.75
  if (thirdPartyCited) return 0.5
  return 0
}

// Cloro's documented per-engine sync endpoints. `google` takes `query`
// instead of `prompt` per their docs; everything else takes `prompt`.
// Grok is listed in their docs as currently unavailable, so it's excluded
// from DEFAULT_ENGINES above rather than included and expected to fail.
async function defaultCloroCaller(engine, promptText, { apiKey, country = 'US', fetcher = fetch } = {}) {
  const bodyKey = engine === 'google' ? 'query' : 'prompt'
  const res = await fetcher(`https://api.cloro.dev/v1/monitor/${engine}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ [bodyKey]: promptText, country })
  })
  if (!res.ok) {
    return { success: false, error: `HTTP ${res.status}` }
  }
  return res.json()
}

const POSITIVE_WORDS = ['excellent', 'trusted', 'recommended', 'highly rated', 'top-rated', 'top rated', 'great', 'reliable', 'best', 'reputable', 'professional', 'outstanding', 'well-reviewed']
const NEGATIVE_WORDS = ['avoid', 'complaint', 'poor reviews', 'scam', 'unreliable', 'unprofessional', 'negative reviews', 'warning', 'bad reviews', 'lawsuit']

function guessSentiment(text) {
  const lower = text.toLowerCase()
  const positiveHits = POSITIVE_WORDS.filter(w => lower.includes(w)).length
  const negativeHits = NEGATIVE_WORDS.filter(w => lower.includes(w)).length
  if (positiveHits === 0 && negativeHits === 0) return null // undetermined -- no signal either way
  if (positiveHits > negativeHits) return 'positive'
  if (negativeHits > positiveHits) return 'negative'
  return 'neutral'
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch (e) {
    return null
  }
}

// Normalizes a raw Cloro response into { text, sourceUrls }, regardless of
// engine. VERIFIED 2026-08-10 against real live calls (see
// fixtures/cloro-live-captures/ -- one real ChatGPT capture, one real
// Google capture, prompt "best accounting and tax service in Denver, CO"):
//
// - chatgpt/gemini/perplexity/copilot share one shape: result.text (a
//   flowing answer) + result.sources[] (each with a .url). Confirmed live
//   against ChatGPT -- this part of the original assumption was correct.
// - google is structurally different, NOT a smaller variant of the above:
//   there is no result.text and no result.sources at all. Citable content
//   lives in result.organicResults[].link and result.localResults[].
//   links.website, and Google's AI Overview -- when present -- is
//   result.aioverview (no hyphen; the original code looked for
//   'ai-overview' and would have silently found nothing, always). Confirmed
//   live: this specific query returned no aioverview at all (field absent,
//   not even null), so treat it as optional on every call, not just an
//   edge case.
function extractEngineSignal(engine, raw) {
  if (engine === 'google') {
    const organic = Array.isArray(raw.result.organicResults) ? raw.result.organicResults : []
    const local = Array.isArray(raw.result.localResults) ? raw.result.localResults : []
    const aiOverview = raw.result.aioverview || null

    const textParts = []
    organic.forEach(r => textParts.push(r.title || '', r.snippet || ''))
    local.forEach(r => textParts.push(r.title || '', r.description || ''))
    if (aiOverview && aiOverview.text) textParts.push(aiOverview.text)

    const sourceUrls = []
    organic.forEach(r => { if (r.link) sourceUrls.push(r.link) })
    local.forEach(r => { if (r.links && r.links.website) sourceUrls.push(r.links.website) })
    if (aiOverview && Array.isArray(aiOverview.citationPills)) {
      aiOverview.citationPills.forEach(c => { if (c.url) sourceUrls.push(c.url) })
    }

    return { text: textParts.join(' ').trim(), sourceUrls }
  }

  // Default shape (chatgpt, gemini, perplexity, copilot).
  const text = raw.result.text || ''
  const sourceUrls = Array.isArray(raw.result.sources) ? raw.result.sources.map(s => s.url || s) : []
  return { text, sourceUrls }
}

// checkAiVisibilitySnapshot(profile, opts) -> shared pillar output contract
// + { snapshot: true, engineResults: [...] }
//
// profile: { name, domain, ... } from business-profile.js's
//   extractBusinessProfile(), plus the prompt(s) from generatePrompts().
// opts.caller: (engine, promptText, callOpts) -> Promise<{ success, result?, error? }>
//   Defaults to defaultCloroCaller. Injected so tests can replay
//   documented/captured responses without a live network call -- same
//   dependency-injection pattern as `fetcher` in the other checkers.
async function checkAiVisibilitySnapshot(profile, prompts, { caller = defaultCloroCaller, engines = DEFAULT_ENGINES, apiKey, now = new Date() } = {}) {
  if (!profile || !profile.name) {
    return {
      grade: 'F',
      score: 0,
      snapshot: true,
      finding: 'Not enough business information was found on this page (no name/category from structured data) to generate a meaningful AI-visibility snapshot.',
      recommendation: 'Add or fix Organization/LocalBusiness schema (see the Schema & Structure pillar) so a snapshot check has a business name and location to query for.',
      evidence: [],
      _raw: { profile, engineResults: [], engineWeights: ENGINE_WEIGHTS }
    }
  }
  if (!prompts || prompts.length === 0) {
    prompts = [`best ${profile.category || 'business'}${profile.city ? ` in ${profile.city}` : ''}`]
  }

  const evidence = []
  const findings = []
  const recommendations = []

  // A grade computed from ONE guessed phrase is not a meaningful signal --
  // verified in practice: for the same business on the same day, "best
  // Digital Marketing in Denver, Colorado" (auto-generated) came back 0/5
  // engines, while "Denver SEO" (a real, human phrasing) came back 3/5.
  // Query every prompt provided against every engine and aggregate across
  // the full prompt x engine matrix, so one unlucky/generic phrase can't
  // single-handedly produce a false "not visible at all" grade.
  evidence.push(`Live snapshot as of ${now.toISOString().slice(0, 10)} across ${prompts.length} prompt(s) x ${engines.length} engine(s): ${prompts.map(p => `"${p}"`).join(', ')}.`)

  const tasks = []
  prompts.forEach(promptText => {
    engines.forEach(engine => {
      tasks.push({ promptText, engine })
    })
  })

  // All prompt x engine combinations are independent -- run every one of
  // them concurrently rather than prompt-by-prompt or engine-by-engine.
  // Wall-clock stays roughly "slowest single call," not "sum of all calls,"
  // no matter how many prompts get added to a client's test set.
  const engineResults = await Promise.all(tasks.map(async ({ promptText, engine }) => {
    let raw
    try {
      raw = await caller(engine, promptText, { apiKey })
    } catch (e) {
      raw = { success: false, error: e.message }
    }

    if (!raw || raw.success === false || !raw.result) {
      return { prompt: promptText, engine, ok: false, weight: weightOf(engine), error: (raw && raw.error) || 'no result' }
    }

    const { text: combinedText, sourceUrls } = extractEngineSignal(engine, raw)

    // `sourceUrls` is every source the ENGINE cited for its whole answer to
    // this prompt -- for a broad query like "Denver SEO" that's usually
    // dominated by competitor/directory pages, not this business. Only the
    // subset that actually resolves to this business's own domain counts as
    // "cited" -- everything else is just what the answer pointed to
    // instead, which is real, useful competitive context but must never be
    // labeled as if it were citing this business (that was confusing
    // strategists into thinking the checker had mixed up whose sources were
    // whose).
    const uniqueSourceUrls = Array.from(new Set(sourceUrls))
    const ownDomainSourceUrls = profile.domain
      ? uniqueSourceUrls.filter(url => hostnameOf(url) === profile.domain)
      : []
    // Everything cited that ISN'T the business's own domain -- an
    // independent third party, not self-promotion. See citationTier()
    // above for why this matters more than ownDomainSourceUrls alone.
    const thirdPartySourceUrls = uniqueSourceUrls.filter(url => !ownDomainSourceUrls.includes(url))
    const authoritySourceUrls = thirdPartySourceUrls.filter(isAuthorityDomain)

    // "Mentioned" was originally text-only (does the visible answer repeat
    // the business's own name). Real bug found in production: for Google's
    // organic-results shape, a result's title/snippet often DOESN'T repeat
    // the business name verbatim (e.g. a page titled "Denver SEO Company |
    // Top Search Engine Optimization Agency" with no "Firestarter SEO" in
    // the visible text) even though that exact page -- on the business's own
    // domain -- is sitting right there in the result set. That's a real
    // appearance, arguably a stronger one than a text mention (the business
    // literally ranked for the query), and it was being scored as a total
    // miss. Count either signal: the name appearing in the text, OR the
    // business's own domain appearing anywhere in the cited sources.
    const nameInText = !!(profile.name && combinedText.toLowerCase().includes(profile.name.toLowerCase()))
    const mentioned = nameInText || ownDomainSourceUrls.length > 0
    const ownCited = mentioned && ownDomainSourceUrls.length > 0
    const thirdPartyCited = mentioned && thirdPartySourceUrls.length > 0
    const authorityCited = mentioned && authoritySourceUrls.length > 0
    // Best-list framing only credits a THIRD-PARTY citation -- the
    // business's own site describing itself as "top-rated" doesn't count
    // as an independent "best list" placement, that's still self-referral.
    const bestListCited = mentioned && thirdPartyCited && hasBestListFraming(combinedText)
    // `cited` kept as "cited by anything, self or third-party" for
    // backward-compatible display/finding logic below -- the new
    // self/third-party/authority/best-list distinction is what actually
    // drives scoring now (see citationTier above).
    const cited = ownCited || thirdPartyCited
    const sentiment = mentioned ? guessSentiment(combinedText) : null
    const citation = citationTier({ mentioned, ownCited, thirdPartyCited, authorityCited, bestListCited, sentiment })

    // Kept for manual spot-checking -- a strategist who's skeptical of a
    // score should be able to see roughly what the engine actually said and
    // where it pointed, and re-run the exact same prompt themselves if
    // something looks off. Capped short (this is a verification aid, not a
    // transcript) and deduped since the same URL can appear from multiple
    // citation slots.
    return {
      prompt: promptText,
      engine,
      ok: true,
      weight: weightOf(engine),
      mentioned,
      cited,
      ownCited,
      thirdPartyCited,
      authorityCited,
      bestListCited,
      citationTier: citation,
      sentiment,
      responseSnippet: combinedText ? combinedText.slice(0, 400) : '',
      ownDomainSourceUrls: ownDomainSourceUrls.slice(0, 3),
      thirdPartySourceUrls: thirdPartySourceUrls.slice(0, 3),
      sourceUrls: uniqueSourceUrls.slice(0, 5)
    }
  }))

  const responded = engineResults.filter(e => e.ok)
  const totalQueried = engineResults.length
  const mentionedList = responded.filter(e => e.mentioned)
  const citedList = mentionedList.filter(e => e.cited)
  const sentimentDetermined = mentionedList.filter(e => e.sentiment)
  const positiveList = sentimentDetermined.filter(e => e.sentiment === 'positive')

  // Per-prompt summary (not per prompt x engine -- that gets noisy fast
  // once a client has more than one or two saved prompts).
  prompts.forEach(promptText => {
    const forThisPrompt = responded.filter(e => e.prompt === promptText)
    const mentionedForThisPrompt = forThisPrompt.filter(e => e.mentioned)
    const failedForThisPrompt = totalQueried > 0 ? engineResults.filter(e => e.prompt === promptText && !e.ok).length : 0
    const failedNote = failedForThisPrompt > 0 ? ` (${failedForThisPrompt} call(s) failed)` : ''
    evidence.push(`"${promptText}": mentioned by ${mentionedForThisPrompt.length}/${forThisPrompt.length} responding engine(s)${failedNote}.`)
  })

  // Weighted, not simple counts: per ENGINE_WEIGHTS above, a Google/ChatGPT/
  // Gemini result moves these shares more than a Perplexity one. E.g. if
  // Firestarter SEO is mentioned by chatgpt+gemini+google (weight 2 each)
  // but not perplexity (weight 1), mentionShare is 6/7 (~86%), not the
  // unweighted 3/4 (75%) -- reflecting that the three engines that matter
  // most all found it.
  const mentionShare = responded.length > 0 ? sumWeight(mentionedList) / sumWeight(responded) : 0
  // citationShare is now a weighted AVERAGE of each mention's citation tier
  // (0/0.5/0.75/1 -- see citationTier above), not a simple "was it cited at
  // all" share. A client cited only via their own site tops out at 75% of
  // this component; one whose mentions are backed by a best/top/recommended
  // list or a recognized authority source can reach 100%.
  const citationShare = mentionedList.length > 0 ? weightedAverage(mentionedList, e => e.citationTier) : 0
  const sentimentShare = sentimentDetermined.length > 0 ? sumWeight(positiveList) / sumWeight(sentimentDetermined) : 0
  const coverageShare = totalQueried > 0 ? sumWeight(responded) / sumWeight(engineResults) : 0

  // Bucketed by the SAME tier the score actually uses (citationTier), not
  // re-derived from the individual boolean flags -- own-citation and
  // third-party-citation aren't mutually exclusive on a given row, and the
  // tier value is what determines which bucket a row "counts as" once both
  // are present.
  const bestOrAuthorityMentions = mentionedList.filter(e => e.citationTier === 1).length
  const ownReferralMentions = mentionedList.filter(e => e.citationTier === 0.75).length
  const thirdPartyOnlyMentions = mentionedList.filter(e => e.citationTier === 0.5).length
  const noCitationMentions = mentionedList.filter(e => e.citationTier === 0).length
  if (mentionedList.length > 0) {
    evidence.push(`Citation mix among mentions: ${bestOrAuthorityMentions} from a best/top/recommended list or recognized authority source, ${ownReferralMentions} self-referral (own site cited), ${thirdPartyOnlyMentions} from a plain third-party mention, ${noCitationMentions} with no citation credit (no citation at all, or negative sentiment).`)
  }

  // Per-engine summary -- same purpose as the per-prompt one above, just
  // sliced the other way. This is what actually answers "why is this score
  // lower than I expected" when the answer is "one high-weight engine is a
  // blind spot," not "the checker is broken."
  const byEngine = {}
  responded.forEach(e => {
    if (!byEngine[e.engine]) byEngine[e.engine] = []
    byEngine[e.engine].push(e)
  })
  Object.entries(byEngine).forEach(([engine, results]) => {
    const mentionedCount = results.filter(r => r.mentioned).length
    const tier = weightOf(engine) >= 2 ? 'high priority' : 'lower priority'
    evidence.push(`${engine} (${tier}): mentioned in ${mentionedCount}/${results.length} prompt(s) queried.`)
  })

  const mentionEarned = Math.round(mentionShare * 40)
  const citationEarned = Math.round(citationShare * 25)
  const sentimentEarned = Math.round(sentimentShare * 20)
  const coverageEarned = Math.round(coverageShare * 15)
  const score = mentionEarned + citationEarned + sentimentEarned + coverageEarned

  if (responded.length < totalQueried) {
    findings.push(`${totalQueried - responded.length} of ${totalQueried} prompt x engine call(s) failed -- this snapshot is based on partial coverage.`)
    recommendations.push('Re-run the snapshot if engine call failures were transient; if they persist, check the Cloro API key/quota before trusting this result.')
  }
  if (prompts.length === 1) {
    findings.push('Only one prompt was tested -- a single phrasing is a weak signal on its own (the same business can score very differently on different real search phrasings). Use the prompt tester to find a few more realistic phrasings and save them to this client to strengthen this grade.')
    recommendations.push('Add 2-4 more realistic search phrasings to this client\'s test prompt set (via the prompt tester on this page) so this grade reflects a spread of real queries, not one guess.')
  }
  if (mentionShare < 0.5) {
    findings.push(`Not mentioned in ${Math.round((1 - mentionShare) * 100)}% of prompt x engine checks in this live snapshot.`)
    recommendations.push('This is a one-time snapshot, not a trend -- if this client is worth pursuing, add them to ongoing AI-visibility tracking to see whether this holds up over multiple runs before drawing conclusions.')
  }
  if (mentionedList.length > 0 && citationShare === 0) {
    findings.push('Mentioned by name but not cited/sourced by any engine in this snapshot -- engines know the business exists but aren\'t treating it as a citable source.')
    recommendations.push('Strengthen third-party citations and authoritative on-site content (see Content Authority and Schema & Structure pillars) to improve citability, not just name recognition.')
  } else if (ownReferralMentions > 0 && bestOrAuthorityMentions === 0 && thirdPartyOnlyMentions === 0) {
    findings.push(`Cited in ${ownReferralMentions} mention(s), but only via the business's own site -- no independent third-party source is backing up these mentions yet.`)
    recommendations.push('Pursue third-party citations and best/top/recommended-list placements -- press mentions, review platforms (Yelp/G2/Trustpilot), industry publications -- since independent validation carries more weight with AI engines than the business citing itself.')
  }

  const finding = findings.length > 0
    ? findings.join(' ')
    : `Mentioned and cited across all prompts and engines queried in this live snapshot as of ${now.toISOString().slice(0, 10)}.`
  const recommendation = recommendations.length > 0
    ? recommendations.join(' ')
    : 'No action needed from this snapshot alone -- revisit with tracked, repeated queries before treating this as a stable result.'

  return {
    grade: scoreToGrade(score),
    score,
    snapshot: true,
    finding: `[Snapshot, not tracked] ${finding}`,
    recommendation,
    evidence,
    _raw: { profile, promptsUsed: prompts, engineResults, mentionShare, citationShare, sentimentShare, coverageShare, engineWeights: ENGINE_WEIGHTS }
  }
}

module.exports = { checkAiVisibilitySnapshot, defaultCloroCaller, scoreToGrade, DEFAULT_ENGINES, ENGINE_WEIGHTS }
