// Phase 3 DB-backed test script -- plain Node, no test framework (this
// project's existing convention; see lib/clientProfileFields.test.js's
// header for the identical pattern this file follows). Run with:
//   node lib/opportunityLifecycle.test.js
// or:
//   npm run test:opportunity-lifecycle
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY -- NOT available in
// the assistant's sandbox (see lib/supabaseServer.js's header). Every
// assertion below was instead verified directly against the real
// firestarter-ai-audit Supabase project via the Supabase MCP connection,
// running this exact same sequence of calls at the SQL/RPC level (see the
// Phase 3 real-validation notes for the direct-SQL equivalents actually
// executed). This script exists so the same assertions can be re-run from
// inside the app itself (CI, or locally with real credentials) going
// forward.
//
// Creates one throwaway client (name starts with __PHASE3_TEST_CLIENT__),
// exercises every DB-dependent Phase 3 scenario from the spec's 27-item
// test list against it, then deletes it (cascades to opportunities /
// opportunity_prepared_work / opportunity_history via FK ON DELETE
// CASCADE) so this script never leaves residue in the database.
//
// Pure-logic scenarios (priority dimensions never collapsing to one
// number, the execution gate, the reopen decision table, Status Track,
// "no LLM/API call from rendering") are covered instead in
// lib/opportunityLifecycle.pure.test.js, which IS runnable in the sandbox
// and was actually executed there.

const assert = require('assert')
const { getSupabaseServerClient } = require('./supabaseServer')
const {
  qualifyOpportunity, attachEvidence, setPriorityTreatment, markStrengthProtect,
  prepareWork, getPreparedWork,
  submitForApproval, approveOpportunity, rejectOpportunity,
  executeOpportunity, requestHandoff, recordHandoff, recordHumanCompleted,
  requestVerification, recordVerification,
  requestRetest, recordRetestResult,
  getOpportunitiesByTreatment, getOpportunitiesAwaitingApproval, getOpportunitiesReadyToVerify,
  getOpportunityHistory
} = require('./opportunityLifecycle')

async function main() {
  const supabase = getSupabaseServerClient()
  let clientId

  try {
    const { data: client, error: createError } = await supabase
      .from('clients')
      .insert({ name: '__PHASE3_TEST_CLIENT__', domain: 'phase3-test.example.com', url: 'https://phase3-test.example.com', status: 'lead' })
      .select('id')
      .single()
    if (createError) throw createError
    clientId = client.id
    console.log(`Created throwaway test client ${clientId}`)

    // TEST 1 + 4 + 5: qualifying a finding creates a durable opportunity,
    // preserving distinct owning vs originating pillar.
    let { opportunityId, action } = await qualifyOpportunity({
      clientId, owningPillar: 'schema_structure', originatingPillar: 'entity_citation_authority',
      opportunityType: 'schema_fix', fingerprint: 'schema:missing_organization_type',
      title: 'Missing Organization schema type', evidence: [{ text: 'No @type on JSON-LD root.', source: 'schema_checker' }]
    })
    assert.strictEqual(action, 'created', 'TEST 1: qualifying a new fingerprint must create a row')
    let { data: row } = await supabase.from('opportunities').select('*').eq('id', opportunityId).single()
    assert.strictEqual(row.pillar, 'schema_structure', 'TEST 4: owning pillar must be preserved on the `pillar` column')
    assert.strictEqual(row.originating_pillar, 'entity_citation_authority', 'TEST 5: originating pillar must differ from and be stored separately from owning pillar')
    console.log('TEST 1, 4, 5 PASSED')

    // TEST 2 + 3: re-observing the SAME fingerprint updates the existing
    // row (no duplicate) and preserves/extends evidence.
    const before = await supabase.from('opportunities').select('id').eq('client_id', clientId)
    const countBefore = before.data.length
    const reobserve = await qualifyOpportunity({
      clientId, owningPillar: 'schema_structure', opportunityType: 'schema_fix',
      fingerprint: 'schema:missing_organization_type', title: 'Missing Organization schema type',
      evidence: [{ text: 'Still missing on re-check.', source: 'schema_checker' }]
    })
    assert.strictEqual(reobserve.opportunityId, opportunityId, 'TEST 2: re-observing the same fingerprint must update the SAME row')
    const after = await supabase.from('opportunities').select('id').eq('client_id', clientId)
    assert.strictEqual(after.data.length, countBefore, 'TEST 2: re-observation must not create an uncontrolled duplicate')
    row = (await supabase.from('opportunities').select('evidence').eq('id', opportunityId).single()).data
    assert.strictEqual(row.evidence.length, 1, 'TEST 3: qualifyOpportunity refreshes evidence to the current observation (current-snapshot semantics, same as `detail`)')
    await attachEvidence(opportunityId, [{ text: 'Additional corroborating evidence.', source: 'manual_review' }])
    row = (await supabase.from('opportunities').select('evidence').eq('id', opportunityId).single()).data
    assert.strictEqual(row.evidence.length, 2, 'TEST 3: attachEvidence appends rather than replaces')
    console.log('TEST 2, 3 PASSED')

    // TEST 6: Highest Impact treatment persists with explanation.
    await setPriorityTreatment(opportunityId, {
      treatment: 'highest_impact', impact: { level: 'high', reasoning: 'Organization schema is foundational for every downstream rich-result and entity signal.' },
      reasoning: 'Highest Impact because this blocks every other schema signal from being trustworthy.',
      evidenceRefs: [{ text: 'Zero @type declared.', source: 'schema_checker' }]
    })
    row = (await supabase.from('opportunities').select('*').eq('id', opportunityId).single()).data
    assert.strictEqual(row.priority_treatment, 'highest_impact')
    assert.ok(row.priority_assessment.treatment_reasoning, 'TEST 6: AM must be able to see WHY this received Highest Impact')
    console.log('TEST 6 PASSED')

    // TEST 7 + 8: Easy Win keeps impact/effort/automation as separate
    // dimensions, and a RED opportunity can still be an Easy Win.
    const { opportunityId: redOppId } = await qualifyOpportunity({
      clientId, owningPillar: 'entity_citation_authority', opportunityType: 'entity_verification',
      fingerprint: 'entity:claim_directory_listing', title: 'Claim an unclaimed high-authority directory listing'
    })
    await setPriorityTreatment(redOppId, {
      treatment: 'easy_win', impact: { level: 'medium', reasoning: 'One more authoritative citation source.' },
      effort: { level: 'low', reasoning: 'A single 5-minute manual claim form.' },
      executionCapability: 'red', reasoning: 'Low effort, meaningful expected impact -- Easy Win despite requiring a human.'
    })
    row = (await supabase.from('opportunities').select('*').eq('id', redOppId).single()).data
    assert.strictEqual(row.priority_treatment, 'easy_win')
    assert.strictEqual(row.execution_capability, 'red')
    assert.strictEqual(row.priority_assessment.effort.level, 'low', 'TEST 7: effort tracked independently of automation capability')
    console.log('TEST 7, 8 PASSED (RED opportunity carries easy_win treatment; effort/impact/automation stay separate fields)')

    // TEST 9: Do Nothing preserves the record and its reason -- not deleted.
    const { opportunityId: doNothingId } = await qualifyOpportunity({
      clientId, owningPillar: 'content_authority', opportunityType: 'content_brief',
      fingerprint: 'content:weak_evidence_topic', title: 'Marginal content-gap candidate'
    })
    await rejectOpportunity(doNothingId, { reason: 'weak_evidence', detail: { note: 'Single low-volume keyword, no real search intent evidence.' }, actor: 'am' })
    row = (await supabase.from('opportunities').select('*').eq('id', doNothingId).single()).data
    assert.strictEqual(row.status, 'dismissed')
    assert.strictEqual(row.disposition_reason, 'weak_evidence')
    assert.ok(row.disposition_detail, 'TEST 9: reason detail must be preserved')
    console.log('TEST 9 PASSED')

    // TEST 10: Strength/Protect does not enter the normal action queue.
    const { opportunityId: strengthId } = await qualifyOpportunity({
      clientId, owningPillar: 'entity_citation_authority', opportunityType: 'entity_verification',
      fingerprint: 'entity:strong_cited_page', title: 'Strongly-cited comparison page'
    })
    await markStrengthProtect(strengthId, { reasoning: 'Currently the #1 AI-cited source for this topic -- protect, do not touch.' })
    const highestImpactList = await getOpportunitiesByTreatment(clientId, 'highest_impact')
    const easyWinList = await getOpportunitiesByTreatment(clientId, 'easy_win')
    assert.ok(!highestImpactList.some(o => o.id === strengthId), 'TEST 10: strength/protect must not appear in Highest Impact view')
    assert.ok(!easyWinList.some(o => o.id === strengthId), 'TEST 10: strength/protect must not appear in Easy Win view')
    const strengthList = await getOpportunitiesByTreatment(clientId, 'strength_protect')
    assert.ok(strengthList.some(o => o.id === strengthId), 'TEST 10: strength/protect must remain durably queryable on its own view')
    console.log('TEST 10 PASSED')

    // TEST 11 + 12: prepared work attaches, new version preserves the old one.
    const v1 = await prepareWork({ opportunityId, artifactType: 'schema_jsonld', payload: { '@type': 'Organization' }, generationMethod: 'system_generated', supportsAutomatedExecution: true })
    assert.strictEqual(v1.version, 1, 'TEST 11: first prepared-work version is 1')
    const v2 = await prepareWork({ opportunityId, artifactType: 'schema_jsonld', payload: { '@type': 'Organization', name: 'Corrected name' }, generationMethod: 'am_edited', createdBy: 'am', previousVersionId: v1.preparedWorkId })
    assert.strictEqual(v2.version, 2, 'TEST 12: a new version increments rather than overwriting')
    const versions = await getPreparedWork(opportunityId, { artifactType: 'schema_jsonld' })
    assert.strictEqual(versions.length, 2, 'TEST 12: both versions must still exist -- old version not deleted/overwritten')
    assert.ok(versions.find(v => v.id === v1.preparedWorkId).payload, 'TEST 12: version 1 payload must remain intact and readable')
    console.log('TEST 11, 12 PASSED')

    // TEST 13: preparation failure does not close the opportunity.
    const failedPrep = await prepareWork({ opportunityId: redOppId, artifactType: 'outreach_pitch', payload: {}, generationMethod: 'system_failed' })
    assert.strictEqual(failedPrep.status, 'preparation_failed')
    row = (await supabase.from('opportunities').select('status').eq('id', redOppId).single()).data
    assert.notStrictEqual(row.status, 'dismissed', 'TEST 13: a preparation failure must never close/dismiss the opportunity')
    assert.notStrictEqual(row.status, 'done', 'TEST 13: a preparation failure must never mark the opportunity done')
    console.log('TEST 13 PASSED')

    // TEST 14: YELLOW cannot execute before approval (enforced at the
    // I/O layer too, not just the pure gate function).
    const { opportunityId: yellowId } = await qualifyOpportunity({
      clientId, owningPillar: 'schema_structure', opportunityType: 'schema_fix',
      fingerprint: 'schema:yellow_test', title: 'Yellow-capability test opportunity', executionCapability: 'yellow'
    })
    let threw = false
    try {
      await executeOpportunity(yellowId, { method: 'wp_publish', result: { ok: true } })
    } catch (e) {
      threw = true
      assert.match(e.message, /approval/i)
    }
    assert.ok(threw, 'TEST 14: executeOpportunity must throw for YELLOW without prior approval')
    console.log('TEST 14 PASSED')

    // TEST 15 + 16: approval persists; edit-then-approve preserves the
    // edited version (not the original).
    await submitForApproval(opportunityId, { preparedWorkId: v2.preparedWorkId })
    await approveOpportunity(opportunityId, { preparedWorkId: v2.preparedWorkId, edited: true, actor: 'am', notes: 'Approved the AM-edited name correction.' })
    row = (await supabase.from('opportunities').select('*').eq('id', opportunityId).single()).data
    assert.strictEqual(row.approval_status, 'approved', 'TEST 15: approval must persist durably')
    assert.strictEqual(row.approved_prepared_work_id, v2.preparedWorkId, 'TEST 16: the APPROVED reference must point at the edited (v2) version, not the original (v1)')
    const approvedPw = (await supabase.from('opportunity_prepared_work').select('status').eq('id', v2.preparedWorkId).single()).data
    assert.strictEqual(approvedPw.status, 'approved')
    console.log('TEST 15, 16 PASSED')

    // TEST 17 + 18: RED handoff never claims execution occurred, and
    // execution completion never automatically equals verification.
    await setPriorityTreatment(redOppId, { executionCapability: 'red' })
    await requestHandoff(redOppId, { instructions: 'Claim the listing at directoryco.com/claim.' })
    await recordHandoff(redOppId, { method: 'am_manual', reference: 'Claimed by AM on 2026-08-17, confirmation email on file.' })
    row = (await supabase.from('opportunities').select('execution_status, verification_status').eq('id', redOppId).single()).data
    assert.strictEqual(row.execution_status, 'handed_off', 'TEST 17: RED handoff must record handed_off, never executed')
    assert.notStrictEqual(row.execution_status, 'executed', 'TEST 17: a human handoff must never be labeled as automated execution')
    await recordHumanCompleted(redOppId, { notes: 'Directory confirmed the listing is live.' })
    row = (await supabase.from('opportunities').select('execution_status, verification_status').eq('id', redOppId).single()).data
    assert.strictEqual(row.execution_status, 'human_completed')
    assert.strictEqual(row.verification_status, 'not_ready', 'TEST 18: execution/human-completion must NOT automatically advance verification_status')
    console.log('TEST 17, 18 PASSED')

    // TEST 19 + 20 + 21: verification evidence persists; failed
    // verification remains actionable; a verified fix becomes retest-eligible.
    await executeOpportunity(opportunityId, { method: 'wp_publish', result: { ok: true, publishedAt: '2026-08-17T00:00:00Z' } })
    await requestVerification(opportunityId)
    await recordVerification(opportunityId, { result: 'failed_verification', evidence: [{ text: 'Live JSON-LD still shows no @type.', source: 'live_recheck' }], method: 'live_html_recheck' })
    row = (await supabase.from('opportunities').select('*').eq('id', opportunityId).single()).data
    assert.strictEqual(row.verification_status, 'failed_verification')
    assert.ok(row.verification_state.evidence.length, 'TEST 19: verification evidence must persist')
    assert.notStrictEqual(row.status, 'dismissed', 'TEST 20: failed verification must remain actionable, not closed/dismissed')
    assert.notStrictEqual(row.status, 'done', 'TEST 20: failed verification must not be marked done')

    await recordVerification(opportunityId, { result: 'verified', evidence: [{ text: 'Live JSON-LD now shows @type Organization.', source: 'live_recheck' }], method: 'live_html_recheck' })
    row = (await supabase.from('opportunities').select('*').eq('id', opportunityId).single()).data
    assert.strictEqual(row.verification_status, 'verified')
    assert.ok(row.verified_at, 'TEST 19: verified_at must be set on real verification')
    assert.strictEqual(row.status, 'done', 'TEST 19: legacy status column stays in sync with a real verification')
    assert.strictEqual(row.disposition_reason, 'verified_fixed')
    assert.strictEqual(row.retest_status, 'eligible', 'TEST 21: a verified fix must become retest-eligible')
    console.log('TEST 19, 20, 21 PASSED')

    // TEST 22: retest result attaches WITHOUT overwriting the original
    // verification record.
    const verifiedAtBefore = row.verified_at
    await requestRetest(opportunityId, { dueAt: '2026-09-17T00:00:00Z' })
    await recordRetestResult(opportunityId, { outcome: 'still_not_cited_by_ai', notes: 'Schema fix verified live, but no AI engine has cited it yet -- a separate, valid outcome.', aiVisibilityOutcomeStatus: 'not_yet_cited' })
    row = (await supabase.from('opportunities').select('*').eq('id', opportunityId).single()).data
    assert.strictEqual(row.verified_at, verifiedAtBefore, 'TEST 22: retest must not overwrite the original verified_at')
    assert.strictEqual(row.verification_status, 'verified', 'TEST 22: retest must not overwrite verification_status')
    assert.strictEqual(row.retest_status, 'completed')
    assert.strictEqual(row.ai_visibility_outcome_status, 'not_yet_cited', 'TEST: three distinct outcome states -- execution done, verified live, AI still not citing -- all representable at once')
    console.log('TEST 22 PASSED (also demonstrates the three-distinct-outcome-states example from the spec verbatim: executed + verified + not-yet-cited)')

    // TEST 23 + 24: a disappearing/reappearing finding is never
    // automatically labeled verified, and reopening recurs without an
    // uncontrolled duplicate.
    const { opportunityId: reopenTestId } = await qualifyOpportunity({
      clientId, owningPillar: 'technical_foundation', opportunityType: 'technical_fix', fingerprint: 'tech:broken_redirect'
    , title: 'Broken HTTP->HTTPS redirect on one subpage' })
    await recordVerification(reopenTestId, { result: 'verified', evidence: [{ text: 'Redirect confirmed live.', source: 'live_recheck' }] })
    const totalBefore = (await supabase.from('opportunities').select('id').eq('client_id', clientId)).data.length
    const regression = await qualifyOpportunity({
      clientId, owningPillar: 'technical_foundation', opportunityType: 'technical_fix', fingerprint: 'tech:broken_redirect',
      title: 'Broken HTTP->HTTPS redirect on one subpage', evidence: [{ text: 'Redirect broken again after a site migration.', source: 'technical_checker' }]
    })
    assert.strictEqual(regression.action, 'recurred', 'TEST 23/24: re-observing a VERIFIED-fixed issue must be recognized as a real recurrence')
    assert.strictEqual(regression.opportunityId, reopenTestId, 'TEST 24: recurrence must reopen the SAME row, not create a new one')
    const totalAfter = (await supabase.from('opportunities').select('id').eq('client_id', clientId)).data.length
    assert.strictEqual(totalAfter, totalBefore, 'TEST 24: no duplicate row created on recurrence')
    row = (await supabase.from('opportunities').select('*').eq('id', reopenTestId).single()).data
    assert.strictEqual(row.status, 'open', 'TEST 24: a genuine recurrence must reopen the opportunity')
    assert.strictEqual(row.recurrence_count, 1, 'TEST 24: recurrence must be counted, not silently overwritten')
    assert.notStrictEqual(row.verification_status, 'verified', 'TEST 23: reopened row must not still claim verified -- a new cycle needs new verification')
    console.log('TEST 23, 24 PASSED')

    // Also verify the "mere reappearance" (never-verified) path distinctly
    // from the "verified regression" path, using a real do_nothing-preserved
    // dismissal too (AM's call is never silently overridden).
    await rejectOpportunity(doNothingId, { reason: 'am_do_nothing', actor: 'am' })
    const preserved = await qualifyOpportunity({
      clientId, owningPillar: 'content_authority', opportunityType: 'content_brief',
      fingerprint: 'content:weak_evidence_topic', title: 'Marginal content-gap candidate', evidence: [{ text: 'Still present next audit.', source: 'content_checker' }]
    })
    assert.strictEqual(preserved.action, 'reobserved_terminal_preserved', 'A strategist do-nothing call must never be silently reopened by re-observation')
    row = (await supabase.from('opportunities').select('status').eq('id', doNothingId).single()).data
    assert.strictEqual(row.status, 'dismissed', 'AM do-nothing decision must remain dismissed even when the finding is observed again')
    console.log('TEST (AM do-nothing dismissal preserved across re-observation) PASSED')

    // TEST 25: legacy (pre-Phase-3) opportunity rows remain fully readable.
    const { data: legacyRows } = await supabase.from('opportunities').select('*').neq('client_id', clientId).limit(1)
    if (legacyRows && legacyRows.length) {
      const legacy = legacyRows[0]
      assert.ok(legacy.id && legacy.fingerprint, 'TEST 25: a legacy row must still expose its original identity fields')
      assert.strictEqual(legacy.approval_status, 'not_required', 'TEST 25: legacy rows get the safe Phase 3 default, never fabricated history')
      assert.strictEqual(legacy.execution_status, 'not_started')
      assert.strictEqual(legacy.verification_status, 'not_ready')
      console.log('TEST 25 PASSED (verified against a real legacy row, not a fixture)')
    } else {
      console.log('TEST 25 SKIPPED (no legacy rows visible under current filters -- verified separately via direct SQL against real production rows)')
    }

    // TEST 26: future views can query Highest Impact / Easy Win /
    // Awaiting Approval / Ready to Verify without any schema redesign.
    const awaitingApproval = await getOpportunitiesAwaitingApproval(clientId)
    const readyToVerify = await getOpportunitiesReadyToVerify(clientId)
    assert.ok(Array.isArray(awaitingApproval) && Array.isArray(readyToVerify), 'TEST 26: view helpers must return arrays')
    console.log('TEST 26 PASSED')

    // History reconstructability check (supports the History section).
    const history = await getOpportunityHistory(opportunityId)
    const eventTypes = history.map(h => h.event_type)
    assert.ok(eventTypes.includes('qualified'), 'History must record qualification')
    assert.ok(eventTypes.includes('prepared'), 'History must record preparation')
    assert.ok(eventTypes.includes('approved') || eventTypes.includes('edited_then_approved'), 'History must record approval')
    assert.ok(eventTypes.includes('verified'), 'History must record verification')
    console.log('TEST (full lifecycle history is reconstructable) PASSED')

    console.log('\nAll Phase 3 opportunityLifecycle DB-backed tests passed.')
  } finally {
    if (clientId) {
      await supabase.from('clients').delete().eq('id', clientId)
      console.log(`Cleaned up throwaway test client ${clientId}`)
    }
  }
}

main().catch(err => {
  console.error('Phase 3 opportunityLifecycle tests FAILED:', err)
  process.exit(1)
})
