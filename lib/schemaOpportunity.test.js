// Tests for lib/schemaOpportunity.js -- Schema Prepared Work + AM Review
// opportunity-qualification layer (Phase 6, 2026-09-03). Plain `node`, no
// framework, same convention as lib/schemaPageTypeChecks.test.js.
//
// qualifySchemaPageOpportunity is the one impure function here (it calls
// lib/opportunityLifecycle.js#qualifyOpportunity, which needs a real
// Supabase connection this sandbox does not have) -- it's tested via
// require.cache module-injection, the exact pattern
// app/api/clients/[id]/opportunities/[opportunityId]/lifecycle/route.test.js
// already uses to mock a lifecycle function with zero DB access. Every
// other export here is pure and tested directly.

const assert = require('assert')
const path = require('path')

let passCount = 0
function test(name, fn) {
  fn()
  passCount++
  console.log(`PASS: ${name}`)
}
async function atest(name, fn) {
  await fn()
  passCount++
  console.log(`PASS: ${name}`)
}

const {
  normalizeSchemaPagePath, buildSchemaOpportunityFingerprint, isEligibleForPreparedWork,
  buildSchemaOpportunityDetail, buildSchemaOpportunityEvidence, buildSchemaOpportunityTitle,
  OPPORTUNITY_TYPE, OWNING_PILLAR
} = require('./schemaOpportunity')

// ---------------------------------------------------------------------
// normalizeSchemaPagePath / buildSchemaOpportunityFingerprint
// ---------------------------------------------------------------------
test('normalizeSchemaPagePath strips query/hash and trailing slash, keeps root as "/"', () => {
  assert.strictEqual(normalizeSchemaPagePath('/about/'), '/about')
  assert.strictEqual(normalizeSchemaPagePath('/about'), '/about')
  assert.strictEqual(normalizeSchemaPagePath('/about/?utm=x#frag'), '/about')
  assert.strictEqual(normalizeSchemaPagePath('/'), '/')
  assert.strictEqual(normalizeSchemaPagePath(''), '/')
  assert.strictEqual(normalizeSchemaPagePath(null), '/')
})

test('buildSchemaOpportunityFingerprint is stable for equivalent paths, distinct for different pages, and excludes target profile', () => {
  assert.strictEqual(buildSchemaOpportunityFingerprint('/about/'), buildSchemaOpportunityFingerprint('/about'))
  assert.notStrictEqual(buildSchemaOpportunityFingerprint('/about/'), buildSchemaOpportunityFingerprint('/contact/'))
  // Same fingerprint function has no targetProfile parameter at all -- a
  // page re-diagnosed into a different profile still fingerprints
  // identically (verified structurally: the function's only input is path).
  assert.strictEqual(buildSchemaOpportunityFingerprint.length, 1)
})

// ---------------------------------------------------------------------
// isEligibleForPreparedWork -- the exact 16-item test list's first four
// requirements (NO_ACTION_NEEDED/COULD_NOT_VERIFY never eligible,
// ACTION_REQUIRED/IMPROVEMENT_AVAILABLE-with-a-real-gap eligible).
// ---------------------------------------------------------------------
function analysisOf(finalStatus, { coreChecks = [], recommendedChecks = [], fetchState = 'success', targetProfile = 'ABOUT' } = {}) {
  return { fetchState, finalStatus, coreChecks, recommendedChecks, classification: { type: 'About' }, currentSchema: ['WebPage'], targetProfile }
}

test('ACTION_REQUIRED with a genuinely failing Core check is eligible', () => {
  const analysis = analysisOf('ACTION_REQUIRED', { coreChecks: [{ id: 'c1', status: 'fail', tier: 'core', evidence: 'x' }] })
  assert.strictEqual(isEligibleForPreparedWork(analysis), true)
})

test('IMPROVEMENT_AVAILABLE with a genuinely failing Recommended check is eligible', () => {
  const analysis = analysisOf('IMPROVEMENT_AVAILABLE', { recommendedChecks: [{ id: 'r1', status: 'fail', tier: 'recommended', evidence: 'x' }] })
  assert.strictEqual(isEligibleForPreparedWork(analysis), true)
})

test('NO_ACTION_NEEDED is never eligible, regardless of check contents', () => {
  const analysis = analysisOf('NO_ACTION_NEEDED', { coreChecks: [{ id: 'c1', status: 'pass', tier: 'core', evidence: 'x' }] })
  assert.strictEqual(isEligibleForPreparedWork(analysis), false)
})

test('COULD_NOT_VERIFY is never eligible', () => {
  const analysis = analysisOf('COULD_NOT_VERIFY')
  assert.strictEqual(isEligibleForPreparedWork(analysis), false)
})

test('A failed fetch (fetchState !== success) is never eligible even if finalStatus somehow says otherwise', () => {
  const analysis = analysisOf('ACTION_REQUIRED', { coreChecks: [{ id: 'c1', status: 'fail', tier: 'core', evidence: 'x' }], fetchState: 'failed' })
  assert.strictEqual(isEligibleForPreparedWork(analysis), false)
})

test('ACTION_REQUIRED with (defensively) no actually-failing core check is NOT eligible -- re-derives, never trusts finalStatus blindly', () => {
  const analysis = analysisOf('ACTION_REQUIRED', { coreChecks: [{ id: 'c1', status: 'pass', tier: 'core', evidence: 'x' }] })
  assert.strictEqual(isEligibleForPreparedWork(analysis), false)
})

test('IMPROVEMENT_AVAILABLE with (defensively) no actually-failing recommended check is NOT eligible', () => {
  const analysis = analysisOf('IMPROVEMENT_AVAILABLE', { recommendedChecks: [{ id: 'r1', status: 'pass', tier: 'recommended', evidence: 'x' }] })
  assert.strictEqual(isEligibleForPreparedWork(analysis), false)
})

test('null/undefined analysis is never eligible', () => {
  assert.strictEqual(isEligibleForPreparedWork(null), false)
  assert.strictEqual(isEligibleForPreparedWork(undefined), false)
})

// ---------------------------------------------------------------------
// detail / evidence / title builders -- current-schema preservation +
// evidence shape OpportunityCard.js expects.
// ---------------------------------------------------------------------
test('buildSchemaOpportunityDetail preserves path/classification/targetProfile/currentSchema/checks/finalStatus and stamps a diagnosedAt', () => {
  const analysis = {
    classification: { type: 'About', source: 'sitemap', confidence: 'high' },
    targetProfile: 'ABOUT',
    currentSchema: ['WebPage', 'Organization'],
    coreChecks: [{ id: 'c1', status: 'pass', tier: 'core', evidence: 'ok' }],
    recommendedChecks: [{ id: 'r1', status: 'fail', tier: 'recommended', evidence: 'missing subtype' }],
    avoidFindings: [],
    notApplicable: [],
    finalStatus: 'IMPROVEMENT_AVAILABLE'
  }
  const detail = buildSchemaOpportunityDetail(analysis, { path: '/about/', pageUrl: 'https://example.com/about/' })
  assert.strictEqual(detail.path, '/about/')
  assert.strictEqual(detail.pageUrl, 'https://example.com/about/')
  assert.deepStrictEqual(detail.classification, analysis.classification)
  assert.strictEqual(detail.targetProfile, 'ABOUT')
  assert.deepStrictEqual(detail.currentSchema, ['WebPage', 'Organization'])
  assert.deepStrictEqual(detail.coreChecks, analysis.coreChecks)
  assert.deepStrictEqual(detail.recommendedChecks, analysis.recommendedChecks)
  assert.strictEqual(detail.finalStatus, 'IMPROVEMENT_AVAILABLE')
  assert.ok(typeof detail.diagnosedAt === 'string' && detail.diagnosedAt.length > 0)
})

test('buildSchemaOpportunityEvidence includes only failing checks, in OpportunityCard.js\'s {text, source} shape, never fabricated', () => {
  const analysis = {
    coreChecks: [
      { id: 'c1', status: 'pass', tier: 'core', evidence: 'fine' },
      { id: 'c2', status: 'fail', tier: 'core', evidence: 'This page has no WebPage or AboutPage schema at all.' }
    ],
    recommendedChecks: [
      { id: 'r1', status: 'fail', tier: 'recommended', evidence: 'This page uses a generic WebPage type rather than AboutPage.' }
    ]
  }
  const evidence = buildSchemaOpportunityEvidence(analysis)
  assert.strictEqual(evidence.length, 2)
  assert.ok(evidence.every(e => typeof e.text === 'string' && e.source === 'schema_diagnostic'))
  assert.deepStrictEqual(evidence.map(e => e.checkId), ['c2', 'r1'])
  assert.deepStrictEqual(evidence.map(e => e.tier), ['core', 'recommended'])
})

test('buildSchemaOpportunityTitle names the path, target profile, and final status', () => {
  const title = buildSchemaOpportunityTitle({ targetProfile: 'ABOUT', finalStatus: 'IMPROVEMENT_AVAILABLE' }, '/about/')
  assert.ok(title.includes('/about/'))
  assert.ok(title.includes('ABOUT'))
  assert.ok(title.includes('IMPROVEMENT_AVAILABLE'))
})

test('OPPORTUNITY_TYPE/OWNING_PILLAR are the exact approved values ("schema_structure" is a real pillar id)', () => {
  const { PILLAR_IDS } = require('./pillarTaxonomy')
  assert.strictEqual(OWNING_PILLAR, 'schema_structure')
  assert.ok(PILLAR_IDS.includes(OWNING_PILLAR))
  assert.strictEqual(typeof OPPORTUNITY_TYPE, 'string')
  assert.ok(OPPORTUNITY_TYPE.length > 0)
})

// ---------------------------------------------------------------------
// qualifySchemaPageOpportunity -- mocked lib/opportunityLifecycle.js via
// require.cache injection (zero real Supabase connection), matching
// app/api/.../lifecycle/route.test.js's own established mocking pattern.
// ---------------------------------------------------------------------
async function withMockedQualifyOpportunity(impl, fn) {
  const modPath = require.resolve('./opportunityLifecycle')
  const schemaOpportunityPath = require.resolve('./schemaOpportunity')
  const calls = []
  const fakeQualifyOpportunity = async (input) => { calls.push(input); return impl(input) }

  const previousLifecycle = require.cache[modPath]
  const previousSchemaOpportunity = require.cache[schemaOpportunityPath]
  delete require.cache[schemaOpportunityPath]
  require.cache[modPath] = { id: modPath, filename: modPath, loaded: true, exports: { qualifyOpportunity: fakeQualifyOpportunity } }

  try {
    const freshModule = require('./schemaOpportunity')
    await fn(freshModule, calls)
  } finally {
    if (previousLifecycle) require.cache[modPath] = previousLifecycle
    else delete require.cache[modPath]
    delete require.cache[schemaOpportunityPath]
    if (previousSchemaOpportunity) require.cache[schemaOpportunityPath] = previousSchemaOpportunity
  }
}

async function main() {
  await atest('qualifySchemaPageOpportunity never calls qualifyOpportunity for NO_ACTION_NEEDED (no opportunity created)', async () => {
    await withMockedQualifyOpportunity(
      async () => { throw new Error('qualifyOpportunity must not be called') },
      async (mod, calls) => {
        const result = await mod.qualifySchemaPageOpportunity({ clientId: 'c1', path: '/about/', analysis: analysisOf('NO_ACTION_NEEDED') })
        assert.deepStrictEqual(result, { eligible: false })
        assert.strictEqual(calls.length, 0)
      }
    )
  })

  await atest('qualifySchemaPageOpportunity never calls qualifyOpportunity for COULD_NOT_VERIFY (no opportunity created)', async () => {
    await withMockedQualifyOpportunity(
      async () => { throw new Error('qualifyOpportunity must not be called') },
      async (mod, calls) => {
        const result = await mod.qualifySchemaPageOpportunity({ clientId: 'c1', path: '/locations/co-springs/', analysis: analysisOf('COULD_NOT_VERIFY') })
        assert.deepStrictEqual(result, { eligible: false })
        assert.strictEqual(calls.length, 0)
      }
    )
  })

  await atest('qualifySchemaPageOpportunity calls qualifyOpportunity with owningPillar/originatingPillar schema_structure, the stable fingerprint, executionCapability red, for ACTION_REQUIRED', async () => {
    await withMockedQualifyOpportunity(
      async () => ({ opportunityId: 'opp-123', action: 'created' }),
      async (mod, calls) => {
        const analysis = analysisOf('ACTION_REQUIRED', { coreChecks: [{ id: 'about_page_type_representation', status: 'fail', tier: 'core', evidence: 'no WebPage/AboutPage schema' }] })
        const result = await mod.qualifySchemaPageOpportunity({ clientId: 'c1', path: '/about/', pageUrl: 'https://example.com/about/', analysis })
        assert.deepStrictEqual(result, { eligible: true, opportunityId: 'opp-123', action: 'created', fingerprint: 'schema:/about' })
        assert.strictEqual(calls.length, 1)
        const input = calls[0]
        assert.strictEqual(input.clientId, 'c1')
        assert.strictEqual(input.owningPillar, 'schema_structure')
        assert.strictEqual(input.originatingPillar, 'schema_structure')
        assert.strictEqual(input.fingerprint, 'schema:/about')
        assert.strictEqual(input.executionCapability, 'red')
        assert.strictEqual(input.actor, 'am')
        assert.strictEqual(input.detail.path, '/about/')
        assert.strictEqual(input.detail.targetProfile, 'ABOUT')
      }
    )
  })

  await atest('qualifySchemaPageOpportunity uses a stable fingerprint independent of path trailing-slash variations (duplicate-prevention correctness)', async () => {
    await withMockedQualifyOpportunity(
      async () => ({ opportunityId: 'opp-1', action: 'reobserved_open' }),
      async (mod, calls) => {
        await mod.qualifySchemaPageOpportunity({ clientId: 'c1', path: '/about', analysis: analysisOf('ACTION_REQUIRED', { coreChecks: [{ id: 'x', status: 'fail', tier: 'core', evidence: 'y' }] }) })
        await mod.qualifySchemaPageOpportunity({ clientId: 'c1', path: '/about/', analysis: analysisOf('ACTION_REQUIRED', { coreChecks: [{ id: 'x', status: 'fail', tier: 'core', evidence: 'y' }] }) })
        assert.strictEqual(calls.length, 2)
        assert.strictEqual(calls[0].fingerprint, calls[1].fingerprint)
      }
    )
  })

  console.log(`\n${passCount} passed.`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
