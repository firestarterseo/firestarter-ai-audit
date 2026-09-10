// Pure tests for lib/promptGapExecution.js -- plain Node, no DB, no
// network. The I/O functions (buildExecutionReview/verifyExecutionReview)
// are exercised live, same convention as lib/promptGapPreparedWork.js.

const assert = require('assert')
const { normalizeText, canAutoPublishToWordPress, summarizeChangeSet, compareLiveToApproved } = require('./promptGapExecution')

function log(msg) { console.log(msg) }

// --- normalizeText ---
{
  assert.strictEqual(normalizeText('  Sliding Patio Doors Denver  '), 'sliding patio doors denver')
  assert.strictEqual(normalizeText(null), '')
  log('PASS normalizeText')
}

// --- canAutoPublishToWordPress ---
{
  assert.strictEqual(canAutoPublishToWordPress('content_draft'), false, 'no WordPress content-write endpoint exists yet -- must not be silently claimed available')
  assert.strictEqual(canAutoPublishToWordPress('content_brief'), false)
  assert.strictEqual(canAutoPublishToWordPress('schema_jsonld'), false, 'schema auto-publish already goes through its own dedicated execute-work route, not this module')
  log('PASS canAutoPublishToWordPress (honest: no content type auto-publishes today)')
}

// --- summarizeChangeSet: improve_existing_page, live override wins over stale stored snapshot ---
{
  const payload = {
    action_type: 'improve_existing_page',
    page_url: 'https://jdiwindows.com/doors/',
    protected_page: null,
    proposed_title: 'Sliding Patio Doors Denver - JDI Windows',
    proposed_h1: 'Sliding Patio Doors in Denver, Colorado',
    current_page: { title: 'STALE TITLE FROM GENERATION TIME', h1: 'STALE H1', wordCount: 999 },
    sections_to_add: [{ heading: 'X', content_html: '<p>x</p>', reason: 'y' }],
    internal_linking_suggestions: [{ anchor_text: 'a', link_target_hint: 'b', reason: 'c' }],
    entity_location_signals: [],
    summary_of_changes: 'Update title/H1 to include sliding.',
    site_quality_issues: [{ type: 'possible_stale_or_mismatched_branding', page_url: 'https://jdiwindows.com/doors/' }]
  }
  const freshLive = { title: 'Patio Doors Denver - JDI Windows', h1: 'Altius Windows and Doors', wordCount: 2515 }
  const summary = summarizeChangeSet(payload, { livePage: freshLive })
  assert.strictEqual(summary.title.current, 'Patio Doors Denver - JDI Windows', 'a fresh live fetch must override the stale stored current_page snapshot')
  assert.strictEqual(summary.h1.current, 'Altius Windows and Doors')
  assert.strictEqual(summary.title.proposed, 'Sliding Patio Doors Denver - JDI Windows')
  assert.strictEqual(summary.contentAdditions.length, 1)
  assert.strictEqual(summary.siteQualityIssues.length, 1)
  log('PASS summarizeChangeSet (improve_existing_page, live fetch overrides stale snapshot)')
}

// --- summarizeChangeSet: deepened plan fields (headings_to_change,
// completeness_check) surface through, not just title/H1 ---
{
  const payload = {
    action_type: 'improve_existing_page',
    page_url: 'https://jdiwindows.com/doors/',
    proposed_title: 'Sliding Patio Doors Denver - JDI Windows',
    proposed_h1: 'Sliding Patio Doors in Denver, Colorado',
    current_page: { title: 'stale', h1: 'stale', wordCount: 100, headings: [] },
    headings_to_change: [{ current_heading: 'Altius I Patio Door', new_heading: 'Sliding Patio Door Installation in Denver', heading_level: 'H2', placement: 'Replace the existing heading.', reason: 'heading_terms deficit' }],
    sections_to_add: [],
    internal_linking_suggestions: [],
    entity_location_signals: [],
    summary_of_changes: 's',
    completeness_check: { addressed: ['title_h1_terms', 'heading_terms'], unaddressed: ['internal_link_support'] }
  }
  const freshLive = { title: 'Patio Doors Denver - JDI Windows', h1: 'Altius Windows and Doors', wordCount: 2515, headings: [{ level: 'H2', text: 'Altius I Patio Door' }] }
  const summary = summarizeChangeSet(payload, { livePage: freshLive })
  assert.strictEqual(summary.currentHeadings.length, 1)
  assert.strictEqual(summary.headingsToChange.length, 1)
  assert.strictEqual(summary.headingsToChange[0].new_heading, 'Sliding Patio Door Installation in Denver')
  assert.deepStrictEqual(summary.completenessCheck.unaddressed, ['internal_link_support'])
  log('PASS summarizeChangeSet (headings_to_change and completeness_check surface through)')
}

// --- summarizeChangeSet: create_dedicated_new_page ---
{
  const payload = {
    action_type: 'create_dedicated_new_page',
    protected_page: 'https://jdiwindows.com/',
    page_title: 'Replacement Windows in Littleton, CO | JDI Windows',
    h1: 'Replacement Windows in Littleton, CO',
    target_url_slug: 'replacement-windows-littleton-co',
    meta_description: 'meta',
    angle: 'angle',
    sections: [{ heading_level: 'H2', heading: 'Why', content_html: '<p>x</p>' }],
    internal_linking_suggestions: [{ anchor_text: 'a', link_target_hint: 'b', reason: 'c' }],
    proof_requirements: [{ requirement: 'Littleton project photos', reason: 'substantiate local claims' }],
    schema_recommendations: [{ schema_type: 'Service', reason: 'location + service page' }],
    site_quality_issues: []
  }
  const summary = summarizeChangeSet(payload, {})
  assert.strictEqual(summary.actionType, 'create_dedicated_new_page')
  assert.strictEqual(summary.newPage.url, '/replacement-windows-littleton-co')
  assert.strictEqual(summary.protectedPage, 'https://jdiwindows.com/')
  assert.strictEqual(summary.proofRequirements.length, 1)
  assert.strictEqual(summary.schemaRecommendations[0].schema_type, 'Service')
  log('PASS summarizeChangeSet (create_dedicated_new_page)')
}

// --- compareLiveToApproved: the real post-publish verification check ---
{
  const payload = { action_type: 'improve_existing_page', proposed_title: 'Sliding Patio Doors Denver - JDI Windows', proposed_h1: 'Sliding Patio Doors in Denver, Colorado' }

  // Not yet published -- live still shows the old title/H1.
  const notYetPublished = compareLiveToApproved('improve_existing_page', payload, { title: 'Patio Doors Denver - JDI Windows', h1: 'Altius Windows and Doors' })
  assert.strictEqual(notYetPublished.matched, false, 'must not report verified when the live page still shows the old content')

  // Published correctly.
  const publishedCorrectly = compareLiveToApproved('improve_existing_page', payload, { title: 'Sliding Patio Doors Denver - JDI Windows', h1: 'Sliding Patio Doors in Denver, Colorado' })
  assert.strictEqual(publishedCorrectly.matched, true)
  assert.ok(publishedCorrectly.checks.every(c => c.matches))

  // Fetch failed entirely.
  const fetchFailed = compareLiveToApproved('improve_existing_page', payload, null)
  assert.strictEqual(fetchFailed.matched, false)
  assert.ok(fetchFailed.reason)

  log('PASS compareLiveToApproved (real live-fetch verification, not manual attestation)')
}

log('ALL PASS')
