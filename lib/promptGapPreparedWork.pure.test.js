// Pure tests for lib/promptGapPreparedWork.js -- plain Node, no DB, no LLM.
// The generator/orchestrator I/O functions are exercised live (same
// convention as lib/contentBrief.js/lib/keywordRelevance.js -- no unit test
// for the Anthropic-calling layer itself).

const assert = require('assert')
const { isHomepagePath, determineActionType, detectSiteQualityIssues, checkPlanAddressesDiagnosis } = require('./promptGapPreparedWork')

function log(msg) { console.log(msg) }

// --- isHomepagePath ---
{
  assert.strictEqual(isHomepagePath('https://jdiwindows.com/'), true)
  assert.strictEqual(isHomepagePath('https://jdiwindows.com'), true)
  assert.strictEqual(isHomepagePath('https://jdiwindows.com/doors/'), false)
  assert.strictEqual(isHomepagePath('not a url'), false)
  log('PASS isHomepagePath')
}

// --- determineActionType: the exact motivating case (homepage protection) ---
{
  const homepageOpp = { pillar: 'entity_citation_authority', type: 'entity_verification', detail: { gap_category: 'relevance', affected_page_url: 'https://jdiwindows.com/' } }
  const homepageDecision = determineActionType(homepageOpp)
  assert.strictEqual(homepageDecision.actionType, 'create_dedicated_new_page', 'a relevance gap on the homepage must never be resolved by retargeting it')
  assert.strictEqual(homepageDecision.protectedPage, 'https://jdiwindows.com/')
  assert.ok(homepageDecision.reason.includes('HOMEPAGE'))

  const supportingPageOpp = { pillar: 'entity_citation_authority', type: 'entity_verification', detail: { gap_category: 'relevance', affected_page_url: 'https://jdiwindows.com/doors/' } }
  const supportingDecision = determineActionType(supportingPageOpp)
  assert.strictEqual(supportingDecision.actionType, 'improve_existing_page', 'a non-homepage supporting page is safe to retarget directly')
  assert.strictEqual(supportingDecision.protectedPage, null)

  const noPageRelevance = determineActionType({ pillar: 'entity_citation_authority', type: 'entity_verification', detail: { gap_category: 'relevance', affected_page_url: null } })
  assert.strictEqual(noPageRelevance.actionType, 'create_dedicated_new_page')

  const noPageContent = determineActionType({ pillar: 'content_authority', type: 'content_brief', detail: { gap_category: 'content', affected_page_url: null } })
  assert.strictEqual(noPageContent.actionType, 'create_dedicated_new_page')

  const thinPageContent = determineActionType({ pillar: 'content_authority', type: 'content_brief', detail: { gap_category: 'content', affected_page_url: 'https://jdiwindows.com/denver-window-replacement/' } })
  assert.strictEqual(thinPageContent.actionType, 'expand_existing_page', 'a content gap with a real page is an in-place expansion, never routed around the page')

  const schemaOpp = determineActionType({ pillar: 'schema_structure', type: 'schema_fix', detail: {} })
  assert.strictEqual(schemaOpp.actionType, 'fix_technical_schema')
  log('PASS determineActionType (homepage-protection motivating case)')
}

// --- detectSiteQualityIssues: the exact motivating case (/doors/'s stale brand H1) ---
{
  const client = { name: 'JDI Windows', domain: 'jdiwindows.com', city: 'Denver', region: 'CO' }

  const staleBrandPage = { h1: 'Altius Windows and Doors' }
  const staleBrandIssues = detectSiteQualityIssues({ client, currentPage: staleBrandPage, pageUrl: 'https://jdiwindows.com/doors/' })
  assert.strictEqual(staleBrandIssues.length, 1, 'an H1 reading as a genuinely different business name must be flagged')
  assert.strictEqual(staleBrandIssues[0].type, 'possible_stale_or_mismatched_branding')
  assert.ok(staleBrandIssues[0].evidence.includes('Altius'))

  // A normal descriptive H1 that happens to include the client's own city
  // must NOT be flagged -- "Denver" is a known term (client.city), so this
  // reads as ordinary copy, not a different business.
  const normalPage = { h1: 'Denver Window Company' }
  const normalIssues = detectSiteQualityIssues({ client, currentPage: normalPage, pageUrl: 'https://jdiwindows.com/' })
  assert.strictEqual(normalIssues.length, 0, 'an H1 matching the client\'s own city must not be flagged as stale branding')

  assert.strictEqual(detectSiteQualityIssues({ client, currentPage: null, pageUrl: 'x' }).length, 0)
  log('PASS detectSiteQualityIssues (stale-branding motivating case)')
}

// --- checkPlanAddressesDiagnosis: deterministic, no-LLM completeness
// check, scoped strictly to the already-diagnosed deficit list -- never
// invents a new gap of its own. ---
{
  const deficits = [
    { type: 'title_h1_terms', terms: ['sliding'], detail: 'x' },
    { type: 'heading_terms', terms: ['sliding', 'denver'], detail: 'x' },
    { type: 'location_not_structural', terms: ['littleton'], detail: 'x' },
    { type: 'page_intent_mismatch', terms: [], detail: 'x' },
    { type: 'internal_link_support', terms: [], detail: 'x' }
  ]

  // A complete plan: covers every term-based deficit's terms somewhere in
  // its own text, adds a heading (satisfies page_intent_mismatch), and adds
  // an internal link (satisfies internal_link_support).
  const completeProposal = {
    proposed_title: 'Sliding Patio Doors Denver',
    proposed_h1: 'Sliding Patio Doors in Denver, Colorado',
    headings_to_change: [{ new_heading: 'Sliding Patio Doors for Littleton & Denver Homes', placement: 'x' }],
    sections_to_add: [],
    entity_location_signals: [],
    internal_linking_suggestions: [{ anchor_text: 'Denver locations', link_target_hint: '/locations/denver' }]
  }
  const completeResult = checkPlanAddressesDiagnosis(deficits, completeProposal)
  assert.strictEqual(completeResult.unaddressed.length, 0, 'every diagnosed deficit is covered by the plan\'s own text/structure')
  assert.strictEqual(completeResult.addressed.length, 5)

  // A shallow, title/H1-only plan: real motivating case -- everything else
  // is left unaddressed and must be REPORTED, not silently passed.
  const shallowProposal = {
    proposed_title: 'Sliding Patio Doors Denver',
    proposed_h1: 'Sliding Patio Doors in Denver, Colorado',
    headings_to_change: [], sections_to_add: [], entity_location_signals: [], internal_linking_suggestions: []
  }
  const shallowResult = checkPlanAddressesDiagnosis(deficits, shallowProposal)
  assert.ok(shallowResult.unaddressed.includes('location_not_structural'), 'Littleton was never added anywhere in a title/H1-only plan')
  assert.ok(shallowResult.unaddressed.includes('page_intent_mismatch'), 'no heading/section change means the page structure genuinely did not change')
  assert.ok(shallowResult.unaddressed.includes('internal_link_support'), 'no internal link was proposed')
  assert.ok(shallowResult.addressed.includes('title_h1_terms'), '"sliding" IS in the new title/H1')

  // No structured diagnosis available -- must degrade honestly, not throw
  // or fabricate a pass/fail.
  const noDiagnosis = checkPlanAddressesDiagnosis(null, completeProposal)
  assert.strictEqual(noDiagnosis.addressed.length, 0)
  assert.strictEqual(noDiagnosis.unaddressed.length, 0)
  assert.ok(noDiagnosis.note)

  log('PASS checkPlanAddressesDiagnosis (complete vs. shallow plan, real JDI deficit set)')
}

log('ALL PASS')
