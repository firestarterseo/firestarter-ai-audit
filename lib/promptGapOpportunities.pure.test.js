// Pure tests for lib/promptGapOpportunities.js -- plain Node, no DB. The
// I/O functions (qualifyStandardGapOpportunity, qualifyTechnicalGapOpportunity,
// processGapOpportunities) are exercised live against real Supabase, same
// convention as every other qualifyOpportunity caller in this codebase
// (lib/sourceCitation.js, lib/schemaOpportunity.js have no unit tests for
// their own I/O layers either).

const assert = require('assert')
const {
  normalizePageKey, buildOpportunityFingerprint, mergeSupportingPrompts, buildOpportunityTitle
} = require('./promptGapOpportunities')

function log(msg) { console.log(msg) }

// --- normalizePageKey ---
{
  assert.strictEqual(normalizePageKey('https://www.jdiwindows.com/doors/'), 'jdiwindows.com/doors')
  assert.strictEqual(normalizePageKey('https://jdiwindows.com/doors'), 'jdiwindows.com/doors', 'trailing slash must not create a distinct key')
  assert.strictEqual(normalizePageKey('https://JDIWindows.com/Doors/'), 'jdiwindows.com/Doors', 'host is lowercased; path case is preserved (a real path can be case-sensitive)')
  log('PASS normalizePageKey')
}

// --- buildOpportunityFingerprint: the actual dedup mechanism ---
{
  // The exact motivating example: two different prompts, same underlying
  // page -> the SAME fingerprint, so they collapse into ONE opportunity.
  const fp1 = buildOpportunityFingerprint('relevance', { clientPageUrl: 'https://jdiwindows.com/' })
  const fp2 = buildOpportunityFingerprint('relevance', { clientPageUrl: 'https://jdiwindows.com' })
  assert.strictEqual(fp1, fp2, 'the same page must produce the same fingerprint regardless of trailing slash')
  assert.ok(fp1.startsWith('promptgap:relevance:'))

  // A genuinely different page must produce a different fingerprint.
  const fp3 = buildOpportunityFingerprint('relevance', { clientPageUrl: 'https://jdiwindows.com/doors/' })
  assert.notStrictEqual(fp1, fp3)

  // content, no page found -> keyed by topic, not by prompt text verbatim.
  const contentNoPageA = buildOpportunityFingerprint('content', { noPageTopicKey: 'custom-denver-windows' })
  const contentNoPageB = buildOpportunityFingerprint('content', { noPageTopicKey: 'custom-denver-windows' })
  assert.strictEqual(contentNoPageA, contentNoPageB)
  assert.strictEqual(buildOpportunityFingerprint('content', {}), null, 'no page and no topic key -> no fabricated fingerprint')

  // authority / third_party -- keyed by competitor + sorted domain set,
  // order-independent.
  const authA = buildOpportunityFingerprint('authority', { competitorDomain: '303windows.com', authorityDomains: ['forbes.com', 'inc.com'] })
  const authB = buildOpportunityFingerprint('authority', { competitorDomain: '303windows.com', authorityDomains: ['inc.com', 'forbes.com'] })
  assert.strictEqual(authA, authB, 'domain order must not affect the fingerprint')
  assert.strictEqual(buildOpportunityFingerprint('authority', { competitorDomain: '303windows.com', authorityDomains: [] }), null)

  const tp = buildOpportunityFingerprint('third_party', { competitorDomain: '303windows.com', absentSources: ['g2.com'] })
  assert.ok(tp.startsWith('promptgap:third_party:303windows.com:'))

  assert.strictEqual(buildOpportunityFingerprint('technical', {}), null, 'technical is handled entirely separately -- never a standard fingerprint')
  log('PASS buildOpportunityFingerprint (dedup mechanism)')
}

// --- mergeSupportingPrompts ---
{
  const existing = [{ prompt_text: 'replacement windows littleton co', first_detected_at: '2026-09-01T00:00:00Z', last_detected_at: '2026-09-01T00:00:00Z' }]
  const merged = mergeSupportingPrompts(existing, { prompt_text: 'best replacement windows littleton', first_detected_at: '2026-09-11T00:00:00Z', last_detected_at: '2026-09-11T00:00:00Z' })
  assert.strictEqual(merged.length, 2, 'a genuinely different prompt must be appended, not replace the array')

  const reobserved = mergeSupportingPrompts(merged, { prompt_text: 'replacement windows littleton co', first_detected_at: '2026-09-11T12:00:00Z', last_detected_at: '2026-09-11T12:00:00Z' })
  assert.strictEqual(reobserved.length, 2, 're-observing the SAME prompt must update in place, not duplicate')
  const reobservedEntry = reobserved.find(p => p.prompt_text === 'replacement windows littleton co')
  assert.strictEqual(reobservedEntry.first_detected_at, '2026-09-01T00:00:00Z', 'first_detected_at must never move on re-observation')
  assert.strictEqual(reobservedEntry.last_detected_at, '2026-09-11T12:00:00Z', 'last_detected_at must advance')
  log('PASS mergeSupportingPrompts')
}

// --- buildOpportunityTitle ---
{
  assert.ok(buildOpportunityTitle('content', { promptText: 'custom windows denver' }).includes('create a page'))
  assert.ok(buildOpportunityTitle('relevance', { clientPageUrl: 'https://jdiwindows.com/' }).includes('/'))
  assert.ok(buildOpportunityTitle('authority', { competitorDomain: '303windows.com', authorityDomains: ['forbes.com'] }).includes('forbes.com'))
  log('PASS buildOpportunityTitle')
}

log('ALL PASS')
