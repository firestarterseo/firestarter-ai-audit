// Tests for lib/schemaPageWork.js -- the Schema page-work data layer
// (2026-09 Schema persistence pass, Phase 5). Plain `node`, require.cache
// module injection for lib/supabaseServer.js (zero real Supabase
// connection), same convention as every other DB-touching lib/ test in
// this repo (e.g. lib/opportunityLifecycle.test.js).

const assert = require('assert')
const path = require('path')

const supabaseServerPath = require.resolve(path.join(__dirname, 'supabaseServer'))

// ---------------------------------------------------------------------
// Fake Supabase -- an in-memory schema_page_work / schema_page_work_history
// pair, with just enough of the query builder surface this module's data
// layer actually uses: .select().eq().eq().maybeSingle(), .select().eq(),
// and .upsert(payload, {onConflict}).select().single(), and .insert().
// ---------------------------------------------------------------------
let pageWorkRows = []
let historyRows = []
let nextId = 1

function defaultRow() {
  return {
    queue_status: 'not_queued', analysis_status: 'unanalyzed', final_status: null,
    opportunity_id: null, classification: null, target_profile: null, latest_analysis: null,
    queued_at: null, analyzed_at: null, last_seen_in_sitemap_at: null
  }
}

function historyTable() {
  return {
    async insert(row) {
      historyRows.push({ id: `hist-${nextId++}`, created_at: new Date().toISOString(), ...row })
      return { error: null }
    }
  }
}

// getPageWorkForClient's plain select().eq() needs to resolve to a list --
// the `then()` on the select() chain below makes it directly awaitable
// (Supabase's real query builder is thenable the same way), so
// `await supabase.from(TABLE).select('*').eq('client_id', clientId)`
// resolves to {data, error} with no further chaining required.
function fakeSupabaseSimple() {
  return {
    from(tableName) {
      if (tableName === 'schema_page_work') {
        return {
          select() {
            const filters = {}
            const chain = {
              eq(k, v) { filters[k] = v; return chain },
              async maybeSingle() {
                const match = pageWorkRows.find(r => Object.entries(filters).every(([k, v]) => r[k] === v))
                return { data: match || null, error: null }
              },
              then(resolve) {
                const matches = pageWorkRows.filter(r => Object.entries(filters).every(([k, v]) => r[k] === v))
                resolve({ data: matches, error: null })
              }
            }
            return chain
          },
          upsert(payload, opts = {}) {
            const conflictKeys = (opts.onConflict || 'client_id,normalized_path').split(',')
            return {
              select() {
                return {
                  async single() {
                    const existingIdx = pageWorkRows.findIndex(r => conflictKeys.every(k => r[k] === payload[k]))
                    if (existingIdx === -1) {
                      const row = { id: `pw-${nextId++}`, created_at: new Date().toISOString(), ...defaultRow(), ...payload }
                      pageWorkRows.push(row)
                      return { data: row, error: null }
                    }
                    pageWorkRows[existingIdx] = { ...pageWorkRows[existingIdx], ...payload }
                    return { data: pageWorkRows[existingIdx], error: null }
                  }
                }
              }
            }
          }
        }
      }
      if (tableName === 'schema_page_work_history') return historyTable()
      throw new Error(`fakeSupabase: unexpected table "${tableName}"`)
    }
  }
}

require.cache[supabaseServerPath] = {
  id: supabaseServerPath, filename: supabaseServerPath, loaded: true,
  exports: { getSupabaseServerClient: () => fakeSupabaseSimple() }
}

const {
  getPageWorkForClient, getPageWorkRow, upsertQueueState, upsertAnalysisResult, linkOpportunity
} = require('./schemaPageWork')

function reset() {
  pageWorkRows = []
  historyRows = []
  nextId = 1
}

function historyFor(pageWorkId) {
  return historyRows.filter(h => h.schema_page_work_id === pageWorkId)
}

let passCount = 0
async function atest(name, fn) {
  await fn()
  passCount++
  console.log(`PASS: ${name}`)
}

const ANALYSIS_IMPROVEMENT = { path: '/about/', fetchState: 'success', finalStatus: 'IMPROVEMENT_AVAILABLE', classification: { type: 'About' }, targetProfile: 'ABOUT', coreChecks: [], recommendedChecks: [{ id: 'r1', status: 'fail' }] }
const ANALYSIS_NO_ACTION = { ...ANALYSIS_IMPROVEMENT, finalStatus: 'NO_ACTION_NEEDED', recommendedChecks: [] }
const ANALYSIS_COULD_NOT_VERIFY = { path: '/broken/', fetchState: 'failed', finalStatus: 'COULD_NOT_VERIFY', classification: { type: 'Other' }, targetProfile: null, coreChecks: [], recommendedChecks: [] }

async function main() {
  // -----------------------------------------------------------------
  // QUEUE PERSISTENCE
  // -----------------------------------------------------------------
  await atest('first queue creates a page-work row and a "queued" history event', async () => {
    reset()
    const row = await upsertQueueState({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', classification: { type: 'About' }, queued: true, actor: 'am' })
    assert.strictEqual(row.queue_status, 'queued')
    assert.strictEqual(row.normalized_path, '/about')
    assert.ok(row.queued_at)
    assert.strictEqual(pageWorkRows.length, 1)
    const hist = historyFor(row.id)
    assert.strictEqual(hist.length, 1)
    assert.strictEqual(hist[0].event_type, 'queued')
    assert.strictEqual(hist[0].actor, 'am')
  })

  await atest('repeated queue does not duplicate the row or the history transition', async () => {
    reset()
    const row1 = await upsertQueueState({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', queued: true })
    const row2 = await upsertQueueState({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', queued: true })
    assert.strictEqual(row1.id, row2.id)
    assert.strictEqual(pageWorkRows.length, 1)
    assert.strictEqual(historyFor(row1.id).length, 1, 'a second identical queue action must not append a second history event')
  })

  await atest('repeated queue is idempotent even across trailing-slash path variations (same normalized identity)', async () => {
    reset()
    await upsertQueueState({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', queued: true })
    const row = await upsertQueueState({ clientId: 'c1', path: '/about', pageUrl: 'https://x.com/about/', queued: true })
    assert.strictEqual(pageWorkRows.length, 1)
    assert.strictEqual(historyFor(row.id).length, 1)
  })

  await atest('unqueue preserves analysis/final status and appends removed_from_queue', async () => {
    reset()
    await upsertQueueState({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', queued: true })
    const analyzed = await upsertAnalysisResult({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', analysis: ANALYSIS_IMPROVEMENT })
    assert.strictEqual(analyzed.final_status, 'IMPROVEMENT_AVAILABLE')
    const unqueued = await upsertQueueState({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', queued: false, actor: 'am' })
    assert.strictEqual(unqueued.queue_status, 'not_queued')
    assert.strictEqual(unqueued.final_status, 'IMPROVEMENT_AVAILABLE', 'unqueueing must never clear final_status')
    assert.strictEqual(unqueued.analysis_status, 'analyzed', 'unqueueing must never clear analysis_status')
    assert.deepStrictEqual(unqueued.latest_analysis, ANALYSIS_IMPROVEMENT, 'unqueueing must never clear latest_analysis')
    const hist = historyFor(unqueued.id)
    assert.ok(hist.some(h => h.event_type === 'removed_from_queue' && h.actor === 'am'))
  })

  await atest('unqueueing a page with no durable row at all is a no-op -- never creates one just to mark it not_queued', async () => {
    reset()
    const result = await upsertQueueState({ clientId: 'c1', path: '/never-touched/', pageUrl: 'https://x.com/never-touched/', queued: false })
    assert.strictEqual(result, null)
    assert.strictEqual(pageWorkRows.length, 0)
  })

  // -----------------------------------------------------------------
  // ANALYSIS PERSISTENCE
  // -----------------------------------------------------------------
  await atest('analysis creates/upserts a page-work row with the full result', async () => {
    reset()
    const row = await upsertAnalysisResult({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', classification: { type: 'About' }, targetProfile: 'ABOUT', analysis: ANALYSIS_IMPROVEMENT, actor: 'system' })
    assert.strictEqual(row.analysis_status, 'analyzed')
    assert.strictEqual(row.final_status, 'IMPROVEMENT_AVAILABLE')
    assert.deepStrictEqual(row.latest_analysis, ANALYSIS_IMPROVEMENT)
    assert.ok(row.analyzed_at)
    assert.ok(row.last_seen_in_sitemap_at)
  })

  await atest('analysis persists NO_ACTION_NEEDED without any opportunity_id', async () => {
    reset()
    const row = await upsertAnalysisResult({ clientId: 'c1', path: '/faq/', pageUrl: 'https://x.com/faq/', analysis: ANALYSIS_NO_ACTION })
    assert.strictEqual(row.final_status, 'NO_ACTION_NEEDED')
    assert.strictEqual(row.opportunity_id, null)
  })

  await atest('analysis persists COULD_NOT_VERIFY (including a genuine fetch failure) without any opportunity_id', async () => {
    reset()
    const row = await upsertAnalysisResult({ clientId: 'c1', path: '/broken/', pageUrl: 'https://x.com/broken/', analysis: ANALYSIS_COULD_NOT_VERIFY })
    assert.strictEqual(row.final_status, 'COULD_NOT_VERIFY')
    assert.strictEqual(row.opportunity_id, null)
  })

  await atest('re-analysis updates the SAME row (never a duplicate)', async () => {
    reset()
    const first = await upsertAnalysisResult({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', analysis: ANALYSIS_IMPROVEMENT })
    const second = await upsertAnalysisResult({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', analysis: ANALYSIS_NO_ACTION })
    assert.strictEqual(first.id, second.id)
    assert.strictEqual(pageWorkRows.length, 1)
    assert.strictEqual(second.final_status, 'NO_ACTION_NEEDED')
  })

  await atest('a changed final_status creates a final_status_changed history event with from/to', async () => {
    reset()
    const first = await upsertAnalysisResult({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', analysis: ANALYSIS_IMPROVEMENT })
    const second = await upsertAnalysisResult({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', analysis: ANALYSIS_NO_ACTION })
    const hist = historyFor(second.id)
    const changed = hist.filter(h => h.event_type === 'final_status_changed')
    assert.strictEqual(changed.length, 1)
    assert.strictEqual(changed[0].from_value, 'IMPROVEMENT_AVAILABLE')
    assert.strictEqual(changed[0].to_value, 'NO_ACTION_NEEDED')
  })

  await atest('an unchanged final_status does NOT create a final_status_changed history event', async () => {
    reset()
    const first = await upsertAnalysisResult({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', analysis: ANALYSIS_IMPROVEMENT })
    const second = await upsertAnalysisResult({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', analysis: { ...ANALYSIS_IMPROVEMENT } })
    const hist = historyFor(second.id)
    assert.strictEqual(hist.filter(h => h.event_type === 'final_status_changed').length, 0)
    assert.strictEqual(hist.filter(h => h.event_type === 'analysis_completed').length, 2, 'analysis_completed is still logged every time, even with no status change')
  })

  await atest('re-analysis does not clear an existing opportunity_id', async () => {
    reset()
    await upsertAnalysisResult({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', analysis: ANALYSIS_IMPROVEMENT })
    const linked = await linkOpportunity({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', opportunityId: 'opp-1' })
    assert.strictEqual(linked.opportunity_id, 'opp-1')
    const reanalyzed = await upsertAnalysisResult({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', analysis: ANALYSIS_NO_ACTION })
    assert.strictEqual(reanalyzed.opportunity_id, 'opp-1', 'opportunity_id must survive re-analysis')
  })

  // -----------------------------------------------------------------
  // OPPORTUNITY LINKAGE
  // -----------------------------------------------------------------
  await atest('opportunity linkage works and appends opportunity_linked history', async () => {
    reset()
    await upsertAnalysisResult({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', analysis: ANALYSIS_IMPROVEMENT })
    const linked = await linkOpportunity({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', opportunityId: 'opp-1', actor: 'system' })
    assert.strictEqual(linked.opportunity_id, 'opp-1')
    const hist = historyFor(linked.id)
    assert.ok(hist.some(h => h.event_type === 'opportunity_linked' && h.to_value === 'opp-1' && h.actor === 'system'))
  })

  await atest('repeated linkage of the SAME opportunity is idempotent -- no duplicate write, no duplicate history', async () => {
    reset()
    await upsertAnalysisResult({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', analysis: ANALYSIS_IMPROVEMENT })
    const first = await linkOpportunity({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', opportunityId: 'opp-1' })
    const second = await linkOpportunity({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', opportunityId: 'opp-1' })
    assert.strictEqual(first.id, second.id)
    assert.strictEqual(pageWorkRows.length, 1)
    assert.strictEqual(historyFor(first.id).filter(h => h.event_type === 'opportunity_linked').length, 1)
  })

  await atest('linkOpportunity creates a minimal row when none exists yet (defensive/standalone path)', async () => {
    reset()
    const linked = await linkOpportunity({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', opportunityId: 'opp-1' })
    assert.strictEqual(linked.opportunity_id, 'opp-1')
    assert.strictEqual(pageWorkRows.length, 1)
  })

  await atest('linkOpportunity never sets approval_status/execution_status/verification_status/retest_status fields (no such columns are ever written)', async () => {
    reset()
    const linked = await linkOpportunity({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', opportunityId: 'opp-1' })
    for (const forbidden of ['approval_status', 'execution_status', 'verification_status', 'retest_status', 'preparedWork', 'prepared_work']) {
      assert.ok(!(forbidden in linked), `schema_page_work must never carry a ${forbidden} field`)
    }
  })

  // -----------------------------------------------------------------
  // READ
  // -----------------------------------------------------------------
  await atest('getPageWorkForClient returns every durable row for that client only', async () => {
    reset()
    await upsertQueueState({ clientId: 'c1', path: '/about/', pageUrl: 'https://x.com/about/', queued: true })
    await upsertQueueState({ clientId: 'c2', path: '/contact/', pageUrl: 'https://y.com/contact/', queued: true })
    const rows = await getPageWorkForClient('c1')
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].client_id, 'c1')
  })

  await atest('getPageWorkRow returns null for a page that was never durably touched', async () => {
    reset()
    const row = await getPageWorkRow('c1', '/never/')
    assert.strictEqual(row, null)
  })

  console.log(`\n${passCount} passed.`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
