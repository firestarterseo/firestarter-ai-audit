// Pure tests for lib/promptGapPreparedWork.js -- plain Node, no DB, no LLM.
// The generator/orchestrator I/O functions are exercised live (same
// convention as lib/contentBrief.js/lib/keywordRelevance.js -- no unit test
// for the Anthropic-calling layer itself).

const assert = require('assert')
const { isHomepagePath, determineActionType, detectSiteQualityIssues } = require('./promptGapPreparedWork')

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

log('ALL PASS')
