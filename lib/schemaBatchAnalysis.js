// PHASE 6 -- SCHEMA BATCH WORKFLOW (2026-09-04): a small, pure,
// framework-free bounded-concurrency batch runner. This is the ONLY new
// orchestration primitive Phase 6 needed -- see SchemaWizard.js's
// analyzeSelected()/prepareSelected(), which both call this with the
// EXISTING per-page functions (analyzeOnePage/prepareSchemaWorkNow) as the
// worker. No new API route, no new persistence, no React/fetch dependency
// here at all -- matches this codebase's established convention for lib/
// modules (see lib/schemaPageSelection.js, lib/schemaPageHydration.js,
// lib/schemaPageIdentity.js), testable with plain `node`.
//
// CORE GUARANTEE (Phase 6 spec, Section 11 -- CONCURRENCY / IDEMPOTENCY):
// "one page failing must not invalidate successful analysis of other
// pages." runWithBoundedConcurrency therefore NEVER throws or rejects
// itself, no matter what `worker` does -- a per-item exception/rejection is
// captured as that item's own result, never propagated. Every item in
// `items` gets exactly one result, in the SAME ORDER as `items`, regardless
// of actual completion order or how many run concurrently.

// runWithBoundedConcurrency(items, worker, concurrency) ->
//   Promise<Array<{ item, status: 'fulfilled', value } | { item, status: 'rejected', error }>>
//
// - items: a plain array (a non-array is treated as empty -- defensive,
//   since a caller deriving this from a Set/Map should already be passing
//   an array, but this must never be the reason a whole batch throws).
// - worker(item, index): called for each item; may be async and may
//   throw/reject freely -- that becomes a 'rejected' entry, nothing more.
// - concurrency: how many `worker` calls may be in flight at once. Clamped
//   to at least 1 (a concurrency of 0/negative/NaN would otherwise leave
//   nothing scheduled and the whole batch would hang forever) and at most
//   items.length (asking for more workers than there is work is harmless
//   but pointless).
async function runWithBoundedConcurrency(items, worker, concurrency = 3) {
  const list = Array.isArray(items) ? items : []
  const results = new Array(list.length)
  if (list.length === 0) return results

  const size = Math.max(1, Math.min(Number.isFinite(concurrency) ? Math.floor(concurrency) : 1, list.length))
  let nextIndex = 0

  async function runOne() {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      if (index >= list.length) return
      const item = list[index]
      try {
        const value = await worker(item, index)
        results[index] = { item, status: 'fulfilled', value }
      } catch (error) {
        results[index] = { item, status: 'rejected', error }
      }
    }
  }

  const runners = []
  for (let i = 0; i < size; i++) runners.push(runOne())
  await Promise.all(runners)
  return results
}

module.exports = { runWithBoundedConcurrency }
