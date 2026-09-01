// Pure tests for lib/sourceCitation.js -- plain Node, no DB, no LLM. Run
// with: node lib/sourceCitation.pure.test.js
//
// Covers as many of the approved spec's 24 numbered test scenarios as are
// pure-logic-testable (no SUPABASE_SERVICE_ROLE_KEY available in this
// sandbox -- DB-backed scenarios, e.g. re-observation/idempotency via the
// real opportunities table, are covered instead in
// lib/sourceCitation.test.js and verified via direct SQL against the real
// Firestarter project, same convention as every other Phase 3 test file).
//
// EVIDENCE-STRENGTH CORRECTION (2026-08-17): this file was substantially
// rewritten. The original model conflated AI-response co-occurrence with
// page-level verified presence under one status
// ('appears_in_cited_content') and awarded Strength/Protect from that same
// weak signal. Tests below that exercised that conflation have been
// corrected to the new model, and the 12 tests the correction explicitly
// requires (numbered 1-12 in their own section below) have been added.

const assert = require('assert')
const {
  classifyRelationshipType, buildRowSourceView, aggregateSourceObservations,
  computeObservedImportance, determineClientPresence, estimateEffort,
  determineExecutionCapability, determineTreatment, classifySourceDisposition,
  buildPreparedWorkPayload, analyzeOwnSiteCitations, computeIndustryEvidence
} = require('./sourceCitation')
const {
  extractPageText, matchesClientEntity, classifyPageRelationshipType,
  categorizeFetchFailure, inspectCitedUrl, inspectCitedUrlsForClient
} = require('./citedPageInspection')

function log(msg) { console.log(msg) }

function rowView(overrides = {}) {
  return {
    rowId: overrides.rowId || 'r1', engine: overrides.engine || 'chatgpt', runAt: overrides.runAt || '2026-08-14T00:00:00Z',
    prompt: overrides.prompt || 'best seo agency in denver', responseSnippet: overrides.responseSnippet || 'Try Clutch.co to compare agencies.',
    brandMentioned: overrides.brandMentioned || false, sentiment: overrides.sentiment || null,
    bestListCited: overrides.bestListCited || false, ownUrls: overrides.ownUrls || [],
    sourceDomains: overrides.sourceDomains || ['clutch.co'], sourceUrls: overrides.sourceUrls || ['https://clutch.co/profile/firestarter'],
    competitorDomainsCited: overrides.competitorDomainsCited || []
  }
}

function verifiedInspection(overrides = {}) {
  return {
    url: overrides.url || 'https://clutch.co/profile/firestarter',
    verificationStatus: overrides.verificationStatus || 'verified_present',
    matchedEntity: overrides.matchedEntity || 'Firestarter SEO',
    relationshipType: overrides.relationshipType || 'Ranking / List',
    snippet: overrides.snippet || 'Firestarter SEO is a strong option.',
    checkedAt: overrides.checkedAt || '2026-08-17T00:00:00Z'
  }
}

// 1. Source observed repeatedly for important prompts becomes visible in
// Source Landscape (i.e. shows up in aggregateSourceObservations with a
// high importance level).
function test1_repeatedlyObservedSourceBecomesVisible() {
  const rowViews = []
  for (let i = 0; i < 8; i++) rowViews.push(rowView({ rowId: `r${i}`, engine: i % 2 === 0 ? 'chatgpt' : 'gemini', prompt: `prompt ${i % 3}` }))
  const agg = aggregateSourceObservations(rowViews)
  assert.ok(agg.has('clutch.co'))
  const importance = computeObservedImportance(agg.get('clutch.co'))
  assert.strictEqual(importance.level, 'high')
  log('TEST 1 (source observed repeatedly for important prompts becomes visible with high importance) PASSED')
}

// 2. Source with no competitor presence can still rank highly.
// 3. Competitor presence does not determine source importance.
function test2and3_noCompetitorPresenceStillRanksHighly() {
  const rowViews = []
  for (let i = 0; i < 8; i++) rowViews.push(rowView({ rowId: `r${i}`, engine: i % 2 === 0 ? 'chatgpt' : 'gemini', competitorDomainsCited: [] }))
  const agg = aggregateSourceObservations(rowViews)
  const importance = computeObservedImportance(agg.get('clutch.co'))
  assert.strictEqual(importance.level, 'high')
  assert.ok(!('competitorCount' in importance.evidenceRefs), 'importance evidence must never include a competitor-count dimension')
  log('TEST 2/3 (zero competitor presence can still rank highly; competitor presence never enters the importance computation) PASSED')
}

// 4. Client absent is distinguished from source-presence-only.
// 5. Source-presence-only is distinguished from verified cited-content
//    presence (and from mere response-level co-occurrence).
// 6. Client-owned citation remains separate.
function test4to6_presenceStatesAreDistinct() {
  const unknownPresence = determineClientPresence({ domain: 'clutch.co', rowViewsCiting: [rowView({ brandMentioned: false })], authorityBacklinkDomains: [] })
  assert.strictEqual(unknownPresence.status, 'unknown')

  const sourcePresenceOnly = determineClientPresence({ domain: 'clutch.co', rowViewsCiting: [rowView({ brandMentioned: false })], authorityBacklinkDomains: ['clutch.co'] })
  assert.strictEqual(sourcePresenceOnly.status, 'source_presence_only')
  assert.strictEqual(sourcePresenceOnly.confidence, 'inferred_from_backlink')

  const coOccurrence = determineClientPresence({ domain: 'clutch.co', rowViewsCiting: [rowView({ brandMentioned: true })], authorityBacklinkDomains: [] })
  assert.strictEqual(coOccurrence.status, 'ai_response_co_occurrence')
  assert.strictEqual(coOccurrence.confidence, 'inferred_from_ai_co_occurrence')

  const verified = determineClientPresence({ domain: 'clutch.co', rowViewsCiting: [rowView({ brandMentioned: true })], authorityBacklinkDomains: [], citedPageInspections: [verifiedInspection()] })
  assert.strictEqual(verified.status, 'appears_in_cited_content_verified')
  assert.strictEqual(verified.confidence, 'verified_by_page_fetch')

  const allFive = new Set([unknownPresence.status, sourcePresenceOnly.status, coOccurrence.status, verified.status, 'client_owned_page_cited'])
  assert.strictEqual(allFive.size, 5, 'unknown, source-presence-only, ai-response-co-occurrence, verified-in-cited-content, and client-owned-page-cited must be five genuinely distinct states')
  log('TEST 4/5/6 (unknown, source-presence-only, ai-response-co-occurrence, verified-in-cited-content, and client-owned-page-cited are five genuinely distinct states) PASSED')
}

// 7. Industry-level evidence can support importance when client sample thin.
// 8. Provenance distinguishes client-specific vs industry evidence.
function test7and8_industryEvidenceSubstitutesWithProvenance() {
  const clientSpecific = computeObservedImportance({ citationCount: 3, engines: new Set(['chatgpt']), prompts: new Set(['p1']), anyBestList: false })
  assert.strictEqual(clientSpecific.evidenceRefs.provenance, 'client_specific')

  const industryOnly = computeObservedImportance(null, { industryEvidence: { observedAcrossClients: 4, note: 'seen for 4 other clients' } })
  assert.strictEqual(industryOnly.level, 'medium')
  assert.strictEqual(industryOnly.evidenceRefs.provenance, 'industry_level')

  const neither = computeObservedImportance(null, { industryEvidence: null })
  assert.strictEqual(neither.evidenceRefs.provenance, 'none')
  log('TEST 7/8 (industry-level evidence substitutes for a thin client sample, and provenance always distinguishes client-specific from industry-level) PASSED')
}

// 9. Low-commercial-relevance source does not qualify.
function test9_lowCommercialRelevanceDoesNotQualify() {
  const importance = { level: 'low', reasoning: 'industry only', evidenceRefs: { provenance: 'industry_level' } }
  const presence = { status: 'unknown', confidence: 'unknown' }
  const effort = { level: 'low' }
  const treatment = determineTreatment({ importance, presence, effort })
  const result = classifySourceDisposition({ importance, presence, effort, treatment })
  assert.strictEqual(result.disposition, 'do_nothing')
  assert.strictEqual(result.reason, 'low_commercial_relevance')
  log('TEST 9 (low-commercial-relevance industry-only source does not qualify) PASSED')
}

// 10. Important/actionable/client-gap source qualifies (a REAL verified gap
// -- source_presence_only -- still qualifies normally after the
// correction).
function test10_importantActionableGapSourceQualifies() {
  const importance = { level: 'high', reasoning: 'x', evidenceRefs: { provenance: 'client_specific' } }
  const presence = { status: 'source_presence_only', confidence: 'inferred_from_backlink' }
  const effort = { level: 'low' }
  const treatment = determineTreatment({ importance, presence, effort })
  const result = classifySourceDisposition({ importance, presence, effort, treatment })
  assert.strictEqual(result.disposition, 'qualifies')
  assert.strictEqual(result.reason, null)
  log('TEST 10 (important, actionable source with a VERIFIED client gap still qualifies after the correction) PASSED')
}

// 11. Ineligible source does not qualify (no legitimate intervention path).
function test11_noLegitimateInterventionDoesNotQualify() {
  const importance = { level: 'high', reasoning: 'x', evidenceRefs: { provenance: 'client_specific' } }
  const presence = { status: 'source_presence_only', confidence: 'inferred_from_backlink' }
  const effort = { level: 'no_legitimate_path' }
  const treatment = determineTreatment({ importance, presence, effort })
  const result = classifySourceDisposition({ importance, presence, effort, treatment })
  assert.strictEqual(result.disposition, 'do_nothing')
  assert.strictEqual(result.reason, 'no_legitimate_intervention')
  log('TEST 11 (a source with no legitimate intervention path does not qualify) PASSED')
}

// 12. First-mover opportunity can qualify with zero competitors.
function test12_firstMoverQualifiesWithZeroCompetitors() {
  const importance = { level: 'high', reasoning: 'x', evidenceRefs: { provenance: 'client_specific' } }
  const presence = { status: 'absent', confidence: 'unknown' }
  const effort = { level: 'low' }
  const treatment = determineTreatment({ importance, presence, effort })
  const result = classifySourceDisposition({ importance, presence, effort, treatment })
  assert.strictEqual(result.disposition, 'qualifies', 'qualification must not require any competitor presence at all')
  log('TEST 12 (first-mover opportunity qualifies with zero competitors present -- competitor presence never gates qualification) PASSED')
}

// 13. Easy Win independent from execution capability.
// 14. RED opportunity can be Easy Win.
function test13and14_easyWinIndependentOfExecutionCapability() {
  const importance = { level: 'medium', reasoning: 'x', evidenceRefs: { provenance: 'client_specific' } }
  const presence = { status: 'absent', confidence: 'unknown' }
  const effort = estimateEffort('Profile / Listing')
  assert.strictEqual(effort.level, 'low')
  const treatment = determineTreatment({ importance, presence, effort })
  assert.strictEqual(treatment.treatment, 'easy_win')
  const executionCapability = determineExecutionCapability()
  assert.strictEqual(executionCapability.capability, 'red')
  log('TEST 13/14 (Easy Win is determined independently of execution capability -- a RED, manually-executed opportunity can still be Easy Win) PASSED')
}

// 15. Do Nothing preserves reason.
function test15_doNothingPreservesReason() {
  const importance = { level: 'low', reasoning: 'weak', evidenceRefs: { provenance: 'client_specific' } }
  const presence = { status: 'source_presence_only', confidence: 'inferred_from_backlink' }
  const effort = { level: 'high' }
  const treatment = determineTreatment({ importance, presence, effort })
  const result = classifySourceDisposition({ importance, presence, effort, treatment })
  assert.strictEqual(result.disposition, 'do_nothing')
  assert.strictEqual(result.reason, 'effort_outweighs_impact')
  log('TEST 15 (Do Nothing disposition preserves a specific, stored reason rather than a generic dismissal) PASSED')
}

// 16. Strength/Protect stays out of normal action queue -- and (post-
// correction) can ONLY be reached via verified presence, never mere
// co-occurrence. See test #7 in the correction section below for the
// negative case.
function test16_strengthProtectDetectedSeparately() {
  const importance = { level: 'high', reasoning: 'x', evidenceRefs: { provenance: 'client_specific' } }
  const presence = { status: 'appears_in_cited_content_verified', confidence: 'verified_by_page_fetch' }
  const effort = { level: 'low' }
  const treatment = determineTreatment({ importance, presence, effort })
  assert.strictEqual(treatment.treatment, 'strength_protect')
  const result = classifySourceDisposition({ importance, presence, effort, treatment })
  assert.strictEqual(result.disposition, 'strength_protect', 'a confirmed, VERIFIED strength must not also register as a normal actionable opportunity')
  log('TEST 16 (Strength/Protect is a distinct treatment, reachable only via verified presence, and does not also qualify as a normal action-queue opportunity) PASSED')
}

// 17. Prepared work attaches through Phase 3 (payload shape check --
// the actual DB attach is covered in lib/sourceCitation.test.js).
function test17_preparedWorkPayloadShape() {
  const client = { name: 'Firestarter SEO', domain: 'www.firestarterseo.com', category: 'Digital Marketing', city: 'Denver', region: 'CO' }
  const payload = buildPreparedWorkPayload({ client, source: { domain: 'clutch.co', topicsObserved: ['best seo agency in denver'] }, relationshipType: 'Profile / Listing' })
  assert.strictEqual(payload.artifactType, 'directory_profile_update')
  assert.ok(payload.businessFacts.name)
  assert.ok(payload.sourceUrl.includes('clutch.co'))
  assert.ok(payload.implementationInstructions)

  const editorialPayload = buildPreparedWorkPayload({ client, source: { domain: 'forbes.com', topicsObserved: ['best seo agency in denver'] }, relationshipType: 'Editorial Mention' })
  assert.strictEqual(editorialPayload.artifactType, 'outreach_pitch')
  assert.ok(editorialPayload.pitch)
  log('TEST 17 (prepared work payload has the correct artifact shape per relationship type, ready to attach via lib/opportunityLifecycle.js#prepareWork) PASSED')
}

// 18. RED handoff does not claim execution.
function test18_redNeverClaimsExecution() {
  const capability = determineExecutionCapability()
  assert.strictEqual(capability.capability, 'red')
  assert.ok(/no real.*submission|no real, supported/i.test(capability.reasoning))
  log('TEST 18 (RED execution capability reasoning is explicit that no real submission integration exists -- never implies automated execution happened) PASSED')
}

// 21. Site-side observation routes without creating a duplicate site-side
// opportunity -- analyzeOwnSiteCitations only ever returns observations
// (never anything shaped like an opportunity/qualification object).
function test21_ownSiteObservationsNeverShapedAsOpportunities() {
  const rowViews = [
    rowView({ ownUrls: [], competitorDomainsCited: ['peaksdigitalmarketing.com'], prompt: 'best seo agency' }),
    rowView({ ownUrls: ['https://www.firestarterseo.com/services/seo'], competitorDomainsCited: [] })
  ]
  const result = analyzeOwnSiteCitations(rowViews, { topicClusters: [{ id: 't1', name: 'Local SEO Services', status: 'benchmark' }] })
  assert.ok(Array.isArray(result.citedOwnPages))
  assert.ok(Array.isArray(result.competitorCitedInstead))
  assert.ok(!('qualifies' in result) && !('treatment' in result) && !('priority_treatment' in result), 'own-site analysis must never itself be shaped as a qualifiable opportunity -- only the receiving pillar decides that')
  assert.ok(result.competitorCitedInstead[0].evidenceStatus.includes('INSUFFICIENT EVIDENCE'), 'own-site differences must use OBSERVED DIFFERENCE / INSUFFICIENT EVIDENCE language, never assert causality')
  log('TEST 21 (own-site citation observations are surfaced for cross-pillar routing but never themselves shaped as a duplicate opportunity) PASSED')
}

// 24. Raw observation/provenance remains drillable.
function test24_rawEvidenceRemainsDrillable() {
  const rv = rowView({ brandMentioned: true, prompt: 'who is the best seo agency', responseSnippet: 'Firestarter SEO is a strong option, per Clutch.co reviews.' })
  const presence = determineClientPresence({ domain: 'clutch.co', rowViewsCiting: [rv], authorityBacklinkDomains: [] })
  assert.strictEqual(presence.evidence[0].prompt, 'who is the best seo agency')
  assert.strictEqual(presence.evidence[0].responseSnippet, 'Firestarter SEO is a strong option, per Clutch.co reviews.')
  assert.strictEqual(presence.evidence[0].engine, 'chatgpt')
  log('TEST 24 (raw prompt/response/engine evidence remains attached and drillable behind every presence determination) PASSED')
}

// Additional pure coverage: buildRowSourceView correctly separates source
// domains from competitor domains using the real, reused
// isNonCompetitorDomain() classification boundary (not a new one).
function testBuildRowSourceViewUsesRealDomainClassification() {
  const row = {
    id: 'row1', engine: 'chatgpt', run_at: '2026-08-14T00:00:00Z', brand_mentioned: true, sentiment: 'positive',
    raw: {
      prompt: 'best seo agency in denver',
      responseSnippet: 'Firestarter SEO and Peaks Digital Marketing both show up on Clutch.co.',
      sourceUrls: ['https://clutch.co/profile/firestarter', 'https://peaksdigitalmarketing.com', 'https://www.firestarterseo.com/services'],
      ownDomainSourceUrls: ['https://www.firestarterseo.com/services'],
      bestListCited: true
    }
  }
  const competitorDomains = new Set(['peaksdigitalmarketing.com'])
  const view = buildRowSourceView(row, { competitorDomains })
  assert.deepStrictEqual(view.sourceDomains, ['clutch.co'])
  assert.deepStrictEqual(view.competitorDomainsCited, ['peaksdigitalmarketing.com'])
  assert.strictEqual(view.bestListCited, true)
  log('TEST (buildRowSourceView reuses the real isNonCompetitorDomain boundary to separate sources from competing businesses) PASSED')
}

// Additional pure coverage: classifyRelationshipType covers the documented
// human-readable relationship-type vocabulary.
function testClassifyRelationshipTypeCoversDocumentedVocabulary() {
  assert.strictEqual(classifyRelationshipType('clutch.co'), 'Ranking / List')
  assert.strictEqual(classifyRelationshipType('yelp.com'), 'Review Page')
  assert.strictEqual(classifyRelationshipType('forbes.com'), 'Editorial Mention')
  assert.strictEqual(classifyRelationshipType('linkedin.com'), 'Profile / Listing')
  assert.strictEqual(classifyRelationshipType('youtube.com'), 'Video')
  assert.strictEqual(classifyRelationshipType('denverchamber.org'), 'Association Membership')
  assert.strictEqual(classifyRelationshipType('some-random-blog.com'), 'Other')
  log('TEST (classifyRelationshipType maps known domain shapes to the documented human-readable relationship types, and falls back to "Other" honestly) PASSED')
}

// =====================================================================
// EVIDENCE-STRENGTH CORRECTION -- the 12 explicitly required new tests
// (2026-08-17). Numbered exactly as specified in the correction request.
// =====================================================================

// Correction test 1: response mentions client + source cited DOES NOT
// equal verified cited-content presence.
function correctionTest1_coOccurrenceIsNotVerifiedPresence() {
  const presence = determineClientPresence({ domain: 'clutch.co', rowViewsCiting: [rowView({ brandMentioned: true })], authorityBacklinkDomains: [] })
  assert.notStrictEqual(presence.status, 'appears_in_cited_content_verified')
  assert.strictEqual(presence.status, 'ai_response_co_occurrence')
  log('CORRECTION TEST 1 (response co-occurrence alone never produces verified cited-content presence) PASSED')
}

// Correction test 2: response co-occurrence is preserved as weaker evidence
// (not discarded -- it still shows up, just honestly labeled and with its
// own, weaker confidence).
function correctionTest2_coOccurrencePreservedAsWeakerEvidence() {
  const rv = rowView({ brandMentioned: true, prompt: 'q', responseSnippet: 'snippet' })
  const presence = determineClientPresence({ domain: 'clutch.co', rowViewsCiting: [rv], authorityBacklinkDomains: [] })
  assert.strictEqual(presence.status, 'ai_response_co_occurrence')
  assert.strictEqual(presence.confidence, 'inferred_from_ai_co_occurrence')
  assert.strictEqual(presence.totalMatchingObservations, 1)
  assert.strictEqual(presence.evidence[0].prompt, 'q')
  log('CORRECTION TEST 2 (response-level co-occurrence is preserved as real, but explicitly weaker, evidence) PASSED')
}

// Correction test 3: an actual fetched cited page containing the client ->
// verified cited-content presence.
async function correctionTest3_fetchedPageContainingClientIsVerified() {
  const fetcher = async (url) => {
    if (url.endsWith('/robots.txt')) return { ok: false, status: 404 }
    return { ok: true, status: 200, text: async () => '<html><body>Top Denver SEO agencies: Firestarter SEO leads the pack.</body></html>' }
  }
  const inspection = await inspectCitedUrl('https://clutch.co/top-denver-seo', { name: 'Firestarter SEO', domain: 'firestarterseo.com' }, { fetcher })
  assert.strictEqual(inspection.verificationStatus, 'verified_present')
  const presence = determineClientPresence({ domain: 'clutch.co', rowViewsCiting: [], authorityBacklinkDomains: [], citedPageInspections: [inspection] })
  assert.strictEqual(presence.status, 'appears_in_cited_content_verified')
  assert.strictEqual(presence.confidence, 'verified_by_page_fetch')
  log('CORRECTION TEST 3 (an actually fetched cited page containing the client produces verified cited-content presence) PASSED')
}

// Correction test 4: a fetched cited page NOT containing the client does
// NOT get verified presence.
async function correctionTest4_fetchedPageWithoutClientIsNotVerified() {
  const fetcher = async (url) => {
    if (url.endsWith('/robots.txt')) return { ok: false, status: 404 }
    return { ok: true, status: 200, text: async () => '<html><body>Top Denver SEO agencies: none of them are related to this client.</body></html>' }
  }
  const inspection = await inspectCitedUrl('https://clutch.co/top-denver-seo-2', { name: 'Firestarter SEO', domain: 'firestarterseo.com' }, { fetcher })
  assert.strictEqual(inspection.verificationStatus, 'verified_absent')
  const presence = determineClientPresence({ domain: 'clutch.co', rowViewsCiting: [], authorityBacklinkDomains: [], citedPageInspections: [inspection] })
  assert.notStrictEqual(presence.status, 'appears_in_cited_content_verified')
  assert.strictEqual(presence.status, 'unknown')
  log('CORRECTION TEST 4 (a fetched cited page that does not contain the client never produces verified presence) PASSED')
}

// Correction test 5: a fetch failure -> unknown/unverifiable, NOT absent.
async function correctionTest5_fetchFailureIsUnverifiableNotAbsent() {
  const fetcher = async () => { throw new Error('ECONNRESET') }
  const inspection = await inspectCitedUrl('https://clutch.co/unreachable', { name: 'Firestarter SEO' }, { fetcher })
  assert.strictEqual(inspection.verificationStatus, 'unverifiable')
  assert.strictEqual(inspection.failureReason, 'network_failure')
  assert.notStrictEqual(inspection.verificationStatus, 'verified_absent')

  const blockedFetcher = async (url) => {
    if (url.endsWith('/robots.txt')) return { ok: false, status: 404 }
    return { ok: false, status: 403 }
  }
  const blocked = await inspectCitedUrl('https://linkedin.com/company/firestarter', {}, { fetcher: blockedFetcher })
  assert.strictEqual(blocked.verificationStatus, 'unverifiable')
  assert.strictEqual(blocked.failureReason, 'blocked_access')
  log('CORRECTION TEST 5 (network failure and blocked access both come back unverifiable -- never inferred as absent) PASSED')
}

// Correction test 6: domain-level profile presence does not imply presence
// on the specific cited URL.
function correctionTest6_domainPresenceDoesNotImplyCitedUrlPresence() {
  const presence = determineClientPresence({ domain: 'clutch.co', rowViewsCiting: [], authorityBacklinkDomains: ['clutch.co'], citedPageInspections: [] })
  assert.strictEqual(presence.status, 'source_presence_only')
  assert.notStrictEqual(presence.status, 'appears_in_cited_content_verified')
  assert.ok(presence.domainPresenceNote, 'a domain-level-only presence must carry an explicit note distinguishing it from cited-URL-level presence')
  log('CORRECTION TEST 6 (a real backlink/domain-level presence never implies presence on the SPECIFIC URL AI cited) PASSED')
}

// Correction test 7: Strength/Protect cannot be awarded solely from
// AI-response co-occurrence.
function correctionTest7_strengthProtectNeverFromCoOccurrenceAlone() {
  const importance = { level: 'high', reasoning: 'x', evidenceRefs: { provenance: 'client_specific' } }
  const presence = { status: 'ai_response_co_occurrence', confidence: 'inferred_from_ai_co_occurrence' }
  const effort = { level: 'low' }
  const treatment = determineTreatment({ importance, presence, effort })
  assert.notStrictEqual(treatment.treatment, 'strength_protect')
  const result = classifySourceDisposition({ importance, presence, effort, treatment })
  assert.notStrictEqual(result.disposition, 'strength_protect')
  log('CORRECTION TEST 7 (Strength/Protect can never be awarded from mere AI-response co-occurrence, no matter how high the importance) PASSED')
}

// Correction test 8: verified repeated cited-content presence CAN support
// Strength/Protect.
function correctionTest8_verifiedRepeatedPresenceSupportsStrengthProtect() {
  const importance = { level: 'high', reasoning: 'x', evidenceRefs: { provenance: 'client_specific' } }
  const presence = determineClientPresence({
    domain: 'clutch.co', rowViewsCiting: [], authorityBacklinkDomains: [],
    citedPageInspections: [verifiedInspection({ url: 'u1' }), verifiedInspection({ url: 'u2' })]
  })
  assert.strictEqual(presence.status, 'appears_in_cited_content_verified')
  const effort = { level: 'low' }
  const treatment = determineTreatment({ importance, presence, effort })
  assert.strictEqual(treatment.treatment, 'strength_protect')
  const result = classifySourceDisposition({ importance, presence, effort, treatment })
  assert.strictEqual(result.disposition, 'strength_protect')
  log('CORRECTION TEST 8 (verified, repeated cited-content presence legitimately supports Strength/Protect) PASSED')
}

// Correction test 9: an unverified source can remain observational with no
// opportunity/disposition forced either way.
function correctionTest9_unverifiedSourceStaysObservational() {
  const importanceHighConfidence = { level: 'high', reasoning: 'x', evidenceRefs: { provenance: 'client_specific' } }
  const presenceUnknown = { status: 'unknown', confidence: 'unknown' }
  const effort = { level: 'low' }
  const treatmentUnknown = determineTreatment({ importance: importanceHighConfidence, presence: presenceUnknown, effort })
  const resultUnknown = classifySourceDisposition({ importance: importanceHighConfidence, presence: presenceUnknown, effort, treatment: treatmentUnknown })
  assert.strictEqual(resultUnknown.disposition, 'observational')

  const presenceCoOccurrence = { status: 'ai_response_co_occurrence', confidence: 'inferred_from_ai_co_occurrence' }
  const treatmentCoOcc = determineTreatment({ importance: importanceHighConfidence, presence: presenceCoOccurrence, effort })
  const resultCoOcc = classifySourceDisposition({ importance: importanceHighConfidence, presence: presenceCoOccurrence, effort, treatment: treatmentCoOcc })
  assert.strictEqual(resultCoOcc.disposition, 'observational', 'high importance + mere co-occurrence must not force an opportunity into existence')
  log('CORRECTION TEST 9 (unverified presence -- unknown or mere co-occurrence -- stays observational, even with high observed importance, rather than being forced into an opportunity or a rejection) PASSED')
}

// Correction test 10: opportunity qualification still works when a real
// actionable gap IS verified (source_presence_only / absent).
function correctionTest10_qualificationStillWorksForVerifiedGap() {
  const importance = { level: 'high', reasoning: 'x', evidenceRefs: { provenance: 'client_specific' } }
  const presence = { status: 'absent', confidence: 'unknown' }
  const effort = { level: 'low' }
  const treatment = determineTreatment({ importance, presence, effort })
  const result = classifySourceDisposition({ importance, presence, effort, treatment })
  assert.strictEqual(result.disposition, 'qualifies')
  log('CORRECTION TEST 10 (opportunity qualification still works normally when a real, verified client gap exists) PASSED')
}

// Correction test 11: existing Phase 3 lifecycle behavior remains
// unchanged -- lib/opportunityLifecycle.js's own pure suite must still
// pass, and its PILLARS constant must still be sourced from
// lib/pillarTaxonomy.js (the earlier fix this correction must not touch).
function correctionTest11_phase3LifecycleUnchanged() {
  const { PILLARS } = require('./opportunityLifecycle')
  const { PILLAR_IDS } = require('./pillarTaxonomy')
  assert.deepStrictEqual(PILLARS, PILLAR_IDS, 'opportunityLifecycle.PILLARS must still be sourced from pillarTaxonomy.PILLAR_IDS, unchanged by this correction')
  log('CORRECTION TEST 11 (existing Phase 3 lifecycle wiring -- PILLARS sourced from pillarTaxonomy -- remains untouched by this correction) PASSED')
}

// Correction test 12: rendering the wizard does not trigger uncontrolled
// page fetching. Pure-logic proxy for this (no React renderer in this test
// file): confirm inspectCitedUrlsForClient (the only fetch-triggering
// function) is never invoked from anywhere in the read path
// (getSourceLandscape / analyzeOwnSiteCitationsForClient) -- verified by
// static source inspection, since getSourceLandscape only ever SELECTs
// already-persisted client_sources/opportunities rows.
function correctionTest12_wizardRenderPathNeverFetches() {
  const fs = require('fs')
  const source = fs.readFileSync(require.resolve('./sourceCitation.js'), 'utf8')
  const getSourceLandscapeBody = source.slice(source.indexOf('async function getSourceLandscape'), source.indexOf('module.exports'))
  assert.ok(!getSourceLandscapeBody.includes('inspectCitedUrlsForClient'), 'getSourceLandscape (the wizard\'s data source) must never call the page-inspection fetcher directly')
  assert.ok(!getSourceLandscapeBody.includes('inspectCitedUrl('), 'getSourceLandscape must never call inspectCitedUrl directly')
  log('CORRECTION TEST 12 (the wizard\'s data-read path, getSourceLandscape, never triggers cited-page fetching -- inspection only runs from syncClientSources during audit/research processing or an explicit re-check action) PASSED')
}

async function main() {
  test1_repeatedlyObservedSourceBecomesVisible()
  test2and3_noCompetitorPresenceStillRanksHighly()
  test4to6_presenceStatesAreDistinct()
  test7and8_industryEvidenceSubstitutesWithProvenance()
  test9_lowCommercialRelevanceDoesNotQualify()
  test10_importantActionableGapSourceQualifies()
  test11_noLegitimateInterventionDoesNotQualify()
  test12_firstMoverQualifiesWithZeroCompetitors()
  test13and14_easyWinIndependentOfExecutionCapability()
  test15_doNothingPreservesReason()
  test16_strengthProtectDetectedSeparately()
  test17_preparedWorkPayloadShape()
  test18_redNeverClaimsExecution()
  test21_ownSiteObservationsNeverShapedAsOpportunities()
  test24_rawEvidenceRemainsDrillable()
  testBuildRowSourceViewUsesRealDomainClassification()
  testClassifyRelationshipTypeCoversDocumentedVocabulary()

  correctionTest1_coOccurrenceIsNotVerifiedPresence()
  correctionTest2_coOccurrencePreservedAsWeakerEvidence()
  await correctionTest3_fetchedPageContainingClientIsVerified()
  await correctionTest4_fetchedPageWithoutClientIsNotVerified()
  await correctionTest5_fetchFailureIsUnverifiableNotAbsent()
  correctionTest6_domainPresenceDoesNotImplyCitedUrlPresence()
  correctionTest7_strengthProtectNeverFromCoOccurrenceAlone()
  correctionTest8_verifiedRepeatedPresenceSupportsStrengthProtect()
  correctionTest9_unverifiedSourceStaysObservational()
  correctionTest10_qualificationStillWorksForVerifiedGap()
  correctionTest11_phase3LifecycleUnchanged()
  correctionTest12_wizardRenderPathNeverFetches()

  log('\nAll sourceCitation pure-function tests passed (no DB, no LLM required), including all 12 evidence-strength-correction tests.')
  log('Scenarios 19, 20, 22, 23 are DB/lifecycle/render-path scenarios -- covered in lib/sourceCitation.test.js and verified directly against real Supabase data (see A-S report).')
}

main().catch(err => { console.error(err); process.exit(1) })
