// Pure tests for lib/discoveryObservation.js -- plain Node, no network,
// no DB. Run with: node lib/discoveryObservation.pure.test.js
//
// Phase 2B ("Discovery Observation + URL Identity Primitives", 2026-09-02).
// Includes explicit Source & Citation COMPATIBILITY tests (section below)
// that build ai_visibility_tracked_runs rows the same way
// lib/sourceCitation.pure.test.js's own rowView() helper does, WITHOUT
// importing or modifying lib/sourceCitation.js itself -- proving
// buildAiCitationObservations works against the real row shape that file
// consumes, without touching it or its 30 pure tests.

const assert = require('assert')
const {
  SUBJECT_TYPES, CHANNELS,
  buildDiscoveryObservation, buildAiCitationObservations, groupObservationsByPageIdentity
} = require('./discoveryObservation')

function log(msg) { console.log(msg) }

// trackedRunRow(overrides) -- shaped exactly like
// lib/sourceCitation.pure.test.js's own rowView()-feeding fixtures: a real
// ai_visibility_tracked_runs row, not a simplified stand-in.
function trackedRunRow(overrides = {}) {
  return {
    id: overrides.id || 'run-1',
    engine: overrides.engine || 'chatgpt',
    run_at: overrides.run_at || '2026-08-14T00:00:00Z',
    brand_mentioned: overrides.brand_mentioned ?? true,
    sentiment: overrides.sentiment ?? null,
    raw: {
      prompt: overrides.prompt || 'best seo agency in denver',
      responseSnippet: overrides.responseSnippet || 'Try Clutch.co to compare agencies.',
      sourceUrls: overrides.sourceUrls || ['https://clutch.co/profile/firestarter'],
      ownDomainSourceUrls: overrides.ownDomainSourceUrls,
      thirdPartySourceUrls: overrides.thirdPartySourceUrls,
      bestListCited: overrides.bestListCited || false
    }
  }
}

function run() {
  // ---------------------------------------------------------------------
  // 1. DISCOVERY OBSERVATION PRIMITIVE
  // ---------------------------------------------------------------------

  {
    const obs = buildDiscoveryObservation({
      clientId: 'client-1', subjectType: 'client', subjectId: 'client-1',
      channel: 'manual', rawUrl: 'https://example.com/about', discoveredAt: '2026-09-01T00:00:00Z',
      rawContext: { note: 'AM found this manually' }
    })
    assert.strictEqual(obs.clientId, 'client-1')
    assert.strictEqual(obs.subjectType, 'client')
    assert.strictEqual(obs.channel, 'manual')
    assert.strictEqual(obs.rawUrl, 'https://example.com/about')
    assert.deepStrictEqual(SUBJECT_TYPES, ['client', 'competitor'])
    assert.deepStrictEqual(CHANNELS, ['ai_citation', 'serp', 'backlink', 'known_profile', 'manual'])
    log('TEST 1 (buildDiscoveryObservation accepts a valid observation and returns the documented shape) PASSED')
  }

  // Shape validation only -- rejects a structurally broken observation...
  {
    assert.throws(() => buildDiscoveryObservation({ subjectType: 'client', subjectId: 'c1', channel: 'manual', rawUrl: 'https://x.com' }), /clientId/)
    assert.throws(() => buildDiscoveryObservation({ clientId: 'c1', subjectType: 'alien', subjectId: 'c1', channel: 'manual', rawUrl: 'https://x.com' }), /subjectType/)
    assert.throws(() => buildDiscoveryObservation({ clientId: 'c1', subjectType: 'client', subjectId: 'c1', channel: 'telepathy', rawUrl: 'https://x.com' }), /channel/)
    assert.throws(() => buildDiscoveryObservation({ clientId: 'c1', subjectType: 'client', subjectId: '', channel: 'manual', rawUrl: 'https://x.com' }), /subjectId/)
    assert.throws(() => buildDiscoveryObservation({ clientId: 'c1', subjectType: 'client', subjectId: 'c1', channel: 'manual', rawUrl: '' }), /rawUrl/)
    // ...but NEVER rejects a malformed-as-a-URL rawUrl -- that's
    // lib/urlIdentity.js's job, checked later, never here.
    const withGarbageUrl = buildDiscoveryObservation({
      clientId: 'c1', subjectType: 'client', subjectId: 'c1', channel: 'manual', rawUrl: 'not a url at all'
    })
    assert.strictEqual(withGarbageUrl.rawUrl, 'not a url at all')
    log('TEST 2 (buildDiscoveryObservation validates SHAPE only -- it throws on a broken subjectType/channel/id, but a malformed-as-a-URL rawUrl is accepted as a legitimate raw observation) PASSED')
  }

  // ---------------------------------------------------------------------
  // 2. AI CITATION OBSERVATION BUILDER
  // ---------------------------------------------------------------------

  // Valid AI citation observation conversion.
  {
    const row = trackedRunRow({ sourceUrls: ['https://clutch.co/profile/firestarter'], ownDomainSourceUrls: [] })
    const observations = buildAiCitationObservations(row, { clientId: 'client-1' })
    assert.strictEqual(observations.length, 1)
    const [obs] = observations
    assert.strictEqual(obs.subjectType, 'client')
    assert.strictEqual(obs.subjectId, 'client-1')
    assert.strictEqual(obs.channel, 'ai_citation')
    assert.strictEqual(obs.rawUrl, 'https://clutch.co/profile/firestarter')
    assert.strictEqual(obs.discoveredAt, '2026-08-14T00:00:00Z')
    assert.strictEqual(obs.rawContext.trackedRunId, 'run-1')
    assert.strictEqual(obs.rawContext.engine, 'chatgpt')
    assert.strictEqual(obs.rawContext.prompt, 'best seo agency in denver')
    assert.strictEqual(obs.rawContext.observedOwnership, 'third_party')
    log('TEST 3 (a real ai_visibility_tracked_runs row converts to a discovery observation preserving run id, engine, prompt, timestamp, and ownership) PASSED')
  }

  // Multiple URLs from one tracked AI observation.
  {
    const row = trackedRunRow({
      sourceUrls: ['https://clutch.co/profile/firestarter', 'https://designrush.com/agency/firestarter', 'https://firestarterseo.com/about'],
      ownDomainSourceUrls: ['https://firestarterseo.com/about']
    })
    const observations = buildAiCitationObservations(row, { clientId: 'client-1' })
    assert.strictEqual(observations.length, 3)
    const byUrl = new Map(observations.map(o => [o.rawUrl, o]))
    assert.strictEqual(byUrl.get('https://clutch.co/profile/firestarter').rawContext.observedOwnership, 'third_party')
    assert.strictEqual(byUrl.get('https://designrush.com/agency/firestarter').rawContext.observedOwnership, 'third_party')
    assert.strictEqual(byUrl.get('https://firestarterseo.com/about').rawContext.observedOwnership, 'own_domain')
    log('TEST 4 (one tracked run citing 3 URLs produces 3 distinct observations, each correctly classified own-domain vs third-party) PASSED')
  }

  // Ownership 'unknown' when the own/third-party split was never recorded
  // on the row at all -- never guessed as third_party by default.
  {
    const row = trackedRunRow({ sourceUrls: ['https://example.com/page'], ownDomainSourceUrls: undefined })
    const [obs] = buildAiCitationObservations(row, { clientId: 'client-1' })
    assert.strictEqual(obs.rawContext.observedOwnership, 'unknown')
    log('TEST 5 (when a row never recorded an own/third-party split at all, ownership is honestly "unknown" -- never fabricated as third_party) PASSED')
  }

  // A row with no sourceUrls at all produces zero observations -- never
  // fabricated from own+thirdParty, mirroring buildRowSourceView's own
  // real precedent exactly. Built as a raw literal (not via trackedRunRow,
  // whose own `||` defaulting would otherwise mask a genuinely-absent
  // sourceUrls key).
  {
    const row = { id: 'run-2', engine: 'chatgpt', run_at: '2026-08-14T00:00:00Z', raw: { prompt: 'x' } }
    const observations = buildAiCitationObservations(row, { clientId: 'client-1' })
    assert.deepStrictEqual(observations, [])
    log('TEST 6 (a row with no raw.sourceUrls array produces zero observations, matching buildRowSourceView\'s own real fallback rather than inventing a different one) PASSED')
  }

  // No clientId / no row -> empty, never throws.
  {
    assert.deepStrictEqual(buildAiCitationObservations(trackedRunRow(), {}), [])
    assert.deepStrictEqual(buildAiCitationObservations(null, { clientId: 'client-1' }), [])
    log('TEST 7 (a missing clientId or row degrades to an empty observation list rather than throwing) PASSED')
  }

  // ---------------------------------------------------------------------
  // SOURCE & CITATION COMPATIBILITY (no import of lib/sourceCitation.js --
  // proves the shape is compatible via an identically-shaped fixture, per
  // the approved Phase 2B instruction to leave that file untouched).
  // ---------------------------------------------------------------------
  {
    // Same row shape lib/sourceCitation.pure.test.js's correctionTest3/4
    // fixtures use, cited via a real thirdPartySourceUrls field (the
    // "newer row" shape, distinct from the ownDomainSourceUrls-only shape
    // exercised above).
    const row = {
      id: 'run-42', engine: 'chatgpt', run_at: '2026-08-14T00:00:00Z',
      raw: {
        prompt: 'best seo agency in denver',
        sourceUrls: ['https://clutch.co/top-denver-seo-2'],
        ownDomainSourceUrls: [],
        thirdPartySourceUrls: ['https://clutch.co/top-denver-seo-2']
      }
    }
    const observations = buildAiCitationObservations(row, { clientId: 'client-1' })
    assert.strictEqual(observations.length, 1)
    assert.strictEqual(observations[0].rawUrl, 'https://clutch.co/top-denver-seo-2')
    assert.strictEqual(observations[0].rawContext.observedOwnership, 'third_party')
    log('COMPATIBILITY TEST (buildAiCitationObservations correctly processes a row shaped exactly like the ones lib/sourceCitation.pure.test.js exercises, without importing or modifying lib/sourceCitation.js) PASSED')
  }

  // ---------------------------------------------------------------------
  // 3/4/5. URL IDENTITY GROUPING, PROVENANCE MERGING, SUBJECT IDENTITY
  // ---------------------------------------------------------------------

  // Malformed URL preserved as an observation but fails normalized
  // identity safely -- grouping falls back to the raw string, never drops
  // the observation and never throws.
  {
    const obs = buildDiscoveryObservation({
      clientId: 'c1', subjectType: 'client', subjectId: 'c1', channel: 'manual', rawUrl: 'not a url at all'
    })
    const groups = groupObservationsByPageIdentity([obs])
    assert.strictEqual(groups.length, 1)
    assert.strictEqual(groups[0].identityValid, false)
    assert.strictEqual(groups[0].normalizedIdentity, null)
    assert.strictEqual(groups[0].observations.length, 1)
    assert.strictEqual(groups[0].observations[0], obs)
    log('TEST 8 (a malformed rawUrl still produces a group -- identityValid:false, normalizedIdentity:null -- rather than being dropped or crashing) PASSED')
  }

  // Same normalized page from multiple channels groups once; all
  // individual provenance observations remain attached.
  {
    const aiObs = buildDiscoveryObservation({
      clientId: 'c1', subjectType: 'client', subjectId: 'c1', channel: 'ai_citation',
      rawUrl: 'https://example.com/page?utm_source=chatgpt', discoveredAt: '2026-08-01T00:00:00Z',
      rawContext: { engine: 'chatgpt' }
    })
    const serpObs = buildDiscoveryObservation({
      clientId: 'c1', subjectType: 'client', subjectId: 'c1', channel: 'serp',
      rawUrl: 'https://www.example.com/page/', discoveredAt: '2026-08-05T00:00:00Z',
      rawContext: { keyword: 'seo agency' }
    })
    const backlinkObs = buildDiscoveryObservation({
      clientId: 'c1', subjectType: 'client', subjectId: 'c1', channel: 'backlink',
      rawUrl: 'https://example.com/page', discoveredAt: '2026-07-20T00:00:00Z',
      rawContext: { referringDomain: 'example.com' }
    })

    const groups = groupObservationsByPageIdentity([aiObs, serpObs, backlinkObs])
    assert.strictEqual(groups.length, 1, 'the same page discovered via 3 channels must become ONE group, not three')
    const [group] = groups
    assert.strictEqual(group.channelCount, 3)
    assert.deepStrictEqual(group.channels, ['ai_citation', 'backlink', 'serp'])
    assert.strictEqual(group.observationCount, 3)
    assert.ok(group.observations.includes(aiObs))
    assert.ok(group.observations.includes(serpObs))
    assert.ok(group.observations.includes(backlinkObs))
    log('TEST 9 (the same page discovered via ai_citation + serp + backlink becomes ONE candidate with 3 channels and all 3 individual observations preserved, not three separate pages and not a flattened provenance string) PASSED')
  }

  // First/last discovered timestamps derived correctly (from the 3-channel
  // group built directly above, spanning 07-20 to 08-05).
  {
    const aiObs = buildDiscoveryObservation({
      clientId: 'c1', subjectType: 'client', subjectId: 'c1', channel: 'ai_citation',
      rawUrl: 'https://example.com/timing', discoveredAt: '2026-08-01T00:00:00Z'
    })
    const serpObs = buildDiscoveryObservation({
      clientId: 'c1', subjectType: 'client', subjectId: 'c1', channel: 'serp',
      rawUrl: 'https://example.com/timing', discoveredAt: '2026-08-05T00:00:00Z'
    })
    const backlinkObs = buildDiscoveryObservation({
      clientId: 'c1', subjectType: 'client', subjectId: 'c1', channel: 'backlink',
      rawUrl: 'https://example.com/timing', discoveredAt: '2026-07-20T00:00:00Z'
    })
    const [group] = groupObservationsByPageIdentity([aiObs, serpObs, backlinkObs])
    assert.strictEqual(group.firstDiscoveredAt, '2026-07-20T00:00:00Z')
    assert.strictEqual(group.lastDiscoveredAt, '2026-08-05T00:00:00Z')
    log('TEST 10 (firstDiscoveredAt/lastDiscoveredAt are correctly derived as the min/max across every observation in the group, independent of input order) PASSED')
  }

  // Same URL for client vs competitor does NOT group together.
  {
    const clientObs = buildDiscoveryObservation({
      clientId: 'c1', subjectType: 'client', subjectId: 'c1', channel: 'ai_citation', rawUrl: 'https://clutch.co/agencies'
    })
    const competitorObs = buildDiscoveryObservation({
      clientId: 'c1', subjectType: 'competitor', subjectId: 'competitor-99', channel: 'ai_citation', rawUrl: 'https://clutch.co/agencies'
    })
    const groups = groupObservationsByPageIdentity([clientObs, competitorObs])
    assert.strictEqual(groups.length, 2, 'identical URL for two different subjects must produce two separate groups')
    const bySubject = new Map(groups.map(g => [`${g.subjectType}:${g.subjectId}`, g]))
    assert.ok(bySubject.has('client:c1'))
    assert.ok(bySubject.has('competitor:competitor-99'))
    log('TEST 11 (the exact same URL observed for the client and for a competitor produces two distinct groups -- subject identity is never collapsed by shared URL) PASSED')
  }

  // Two different competitors citing the exact same URL also stay distinct
  // from each other (not just from the client).
  {
    const competitorA = buildDiscoveryObservation({
      clientId: 'c1', subjectType: 'competitor', subjectId: 'competitor-A', channel: 'backlink', rawUrl: 'https://press.example.com/roundup'
    })
    const competitorB = buildDiscoveryObservation({
      clientId: 'c1', subjectType: 'competitor', subjectId: 'competitor-B', channel: 'backlink', rawUrl: 'https://press.example.com/roundup'
    })
    const groups = groupObservationsByPageIdentity([competitorA, competitorB])
    assert.strictEqual(groups.length, 2)
    log('TEST 12 (two different competitors observed on the same URL also remain distinct groups, not just client-vs-competitor)  PASSED')
  }

  // Different pages for the same subject remain distinct groups.
  {
    const pageA = buildDiscoveryObservation({ clientId: 'c1', subjectType: 'client', subjectId: 'c1', channel: 'ai_citation', rawUrl: 'https://example.com/page-a' })
    const pageB = buildDiscoveryObservation({ clientId: 'c1', subjectType: 'client', subjectId: 'c1', channel: 'ai_citation', rawUrl: 'https://example.com/page-b' })
    const groups = groupObservationsByPageIdentity([pageA, pageB])
    assert.strictEqual(groups.length, 2, 'two genuinely different pages on the same domain, for the same subject, must never collapse into one candidate')
    log('TEST 13 (two different pages on the same domain, for the same subject, remain two distinct groups -- page-level evidence is never flattened to domain-level) PASSED')
  }

  // ---------------------------------------------------------------------
  // NO NETWORK / NO SUPABASE CALLS -- verified directly against source,
  // same technique lib/sourceCitation.pure.test.js's own
  // correctionTest12_wizardRenderPathNeverFetches uses.
  // ---------------------------------------------------------------------
  {
    const fs = require('fs')
    const discoverySource = fs.readFileSync(require.resolve('./discoveryObservation'), 'utf8')
    const identitySource = fs.readFileSync(require.resolve('./urlIdentity'), 'utf8')
    for (const source of [discoverySource, identitySource]) {
      assert.ok(!/supabaseServer/.test(source), 'must never import lib/supabaseServer.js')
      assert.ok(!/require\(['"]\.\/webPageFetch['"]\)/.test(source), 'must never call the real page-fetch primitive from this layer')
      assert.ok(!/\bawait fetch\(/.test(source) && !/\bfetch\(['"]http/.test(source), 'must never perform a real network fetch')
    }
    log('TEST 14 (verified directly against source: neither lib/discoveryObservation.js nor lib/urlIdentity.js imports Supabase or performs a network fetch) PASSED')
  }

  console.log('\nAll lib/discoveryObservation.js pure tests passed (no network calls, no DB required), including Source & Citation shape-compatibility checks.')
}

run()
