// SCHEMA PAGE-WORK DATA LAYER -- Phase 5 of the 2026-09 Schema
// persistence pass. The minimum server-side application layer over the
// `schema_page_work` / `schema_page_work_history` tables approved and
// applied in Migration B.
//
// RESPONSIBILITY BOUNDARY (unchanged from the migration): this module owns
// CURRENT DURABLE PAGE REVIEW/ANALYSIS STATE and its lightweight,
// append-only MEANINGFUL-TRANSITION history. It never reads or writes
// `opportunities` / `opportunity_prepared_work` / `opportunity_history` --
// those stay exclusively owned by lib/opportunityLifecycle.js. The only
// thing this module knows about Phase 3 is a nullable `opportunity_id`
// pointer, set once by linkOpportunity() and never otherwise interpreted
// here (no approval/execution/verification/retest fields, ever).
//
// IDENTITY: every function below takes the client's own site-relative
// `path` (the same string SchemaWizard.js/lib/pageAnalysis.js already use)
// and derives `normalized_path` via lib/schemaPageIdentity.js's
// normalizeSchemaPagePath() -- the SAME rule lib/schemaOpportunity.js uses
// for a Schema opportunity's fingerprint. No second normalization rule is
// invented here.
//
// NOT PERSISTED HERE: the sitemap universe. This module is never called
// from sitemap discovery/audit code -- only from an AM's explicit queue
// toggle, a completed page analysis, or a successful Prepare Schema Work
// qualification (see the three call sites: the new page-work/queue route,
// analyze-page/route.js, and prepare-work/route.js). A page that was
// merely discovered or recommended, and never acted on, never gets a row.
//
// UPDATED_AT: no database trigger (explicit product decision -- see
// Migration B's report). Every function below that writes a row sets
// updated_at = now() itself.

const { getSupabaseServerClient } = require('./supabaseServer')
const { normalizeSchemaPagePath } = require('./schemaPageIdentity')

const TABLE = 'schema_page_work'
const HISTORY_TABLE = 'schema_page_work_history'

function nowIso() {
  return new Date().toISOString()
}

// getPageWorkForClient(clientId) -> schema_page_work row[] for this client.
// Read-only, no live fetch, no re-analysis -- exactly what the hydration
// endpoint (Section 8) needs.
async function getPageWorkForClient(clientId) {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.from(TABLE).select('*').eq('client_id', clientId)
  if (error) throw error
  return data || []
}

// getPageWorkRow(clientId, path) -> the single row for (clientId,
// normalizedPath(path)), or null if none exists yet. Internal helper for
// every mutation below -- always reads the CURRENT row first so a
// mutation can (a) decide whether this is a genuine transition (for
// idempotent history logging) and (b) preserve every field it isn't
// explicitly asked to change.
async function getPageWorkRow(clientId, path) {
  const supabase = getSupabaseServerClient()
  const normalizedPath = normalizeSchemaPagePath(path)
  const { data, error } = await supabase
    .from(TABLE).select('*').eq('client_id', clientId).eq('normalized_path', normalizedPath).maybeSingle()
  if (error) throw error
  return data || null
}

// insertHistoryEvent(supabase, {...}) -- internal. Every write path below
// appends at most the events Section 3/17 actually asks for; nothing here
// ever stores a full analysis payload in a history row (see
// schema_page_work_history's own migration comment).
async function insertHistoryEvent(supabase, { schemaPageWorkId, clientId, eventType, fromValue = null, toValue = null, actor }) {
  const { error } = await supabase.from(HISTORY_TABLE).insert({
    schema_page_work_id: schemaPageWorkId,
    client_id: clientId,
    event_type: eventType,
    from_value: fromValue,
    to_value: toValue,
    actor
  })
  if (error) throw error
}

// upsertQueueState({clientId, path, pageUrl, classification, queued, actor})
//   -> the current row (created if this is the first-ever meaningful
//      activity on this page), or null if this was a no-op "unqueue a page
//      with no durable row" request (nothing to persist -- see Section 3:
//      a page is never persisted just because it might be removed from a
//      queue it was never durably added to).
//
// IDEMPOTENT: if the row already reflects the requested queue_status, this
// makes NO write and appends NO history event (Section 4's explicit
// requirement -- "must not create duplicate history events when no real
// transition occurred").
//
// Deliberately does NOT touch classification/page_url on an EXISTING row
// -- those are analysis's job (Section 5); queueing only ever sets
// queue_status/queued_at/updated_at on a row that already exists. On
// FIRST creation (queuing a page with no prior row at all), page_url and
// an initial classification snapshot are stored so the row is displayable
// before any analysis has run.
async function upsertQueueState({ clientId, path, pageUrl, classification = null, queued, actor = 'am' }) {
  if (!clientId) throw new Error('upsertQueueState requires clientId.')
  if (!path) throw new Error('upsertQueueState requires path.')

  const supabase = getSupabaseServerClient()
  const normalizedPath = normalizeSchemaPagePath(path)
  const existing = await getPageWorkRow(clientId, path)
  const desiredStatus = queued ? 'queued' : 'not_queued'

  if (existing && existing.queue_status === desiredStatus) {
    return existing
  }
  if (!existing && !queued) {
    return null
  }
  if (!existing && !pageUrl) {
    throw new Error('upsertQueueState requires pageUrl when creating a new page-work row.')
  }

  const now = nowIso()
  const payload = {
    client_id: clientId,
    normalized_path: normalizedPath,
    queue_status: desiredStatus,
    updated_at: now
  }
  if (queued) payload.queued_at = now
  if (!existing) {
    payload.page_url = pageUrl
    if (classification) payload.classification = classification
  }

  const { data, error } = await supabase.from(TABLE).upsert(payload, { onConflict: 'client_id,normalized_path' }).select().single()
  if (error) throw error

  await insertHistoryEvent(supabase, {
    schemaPageWorkId: data.id,
    clientId,
    eventType: queued ? 'queued' : 'removed_from_queue',
    fromValue: existing ? existing.queue_status : null,
    toValue: desiredStatus,
    actor
  })

  return data
}

// upsertAnalysisResult({clientId, path, pageUrl, classification,
//   targetProfile, analysis, actor}) -> the current row.
//
// Called on EVERY completed analysis, regardless of finalStatus --
// ACTION_REQUIRED, IMPROVEMENT_AVAILABLE, NO_ACTION_NEEDED, and
// COULD_NOT_VERIFY (including a genuine fetch failure, whose analyzePage()
// result already carries finalStatus: 'COULD_NOT_VERIFY') are ALL
// persisted identically -- Section 6's explicit requirement. This
// function never creates a Phase 3 opportunity and never inspects
// eligibility; that gate lives entirely in lib/schemaOpportunity.js and is
// applied by the caller (prepare-work/route.js) before it ever calls
// linkOpportunity() below.
//
// Never clears opportunity_id -- re-analysis of a page that already has a
// linked opportunity preserves that linkage (Section 13).
//
// last_seen_in_sitemap_at is stamped to now() here: a page can only reach
// this function via an AM analyzing a page that is currently part of this
// audit's live-discovered candidate universe (SchemaWizard.js's
// candidatePages, sourced from the sitemap crawl this pillar's own audit
// run just performed) -- that IS current sitemap evidence, distinct from
// (and not a substitute for) a future dedicated re-audit sync.
async function upsertAnalysisResult({ clientId, path, pageUrl, classification = null, targetProfile = null, analysis, actor = 'system' }) {
  if (!clientId) throw new Error('upsertAnalysisResult requires clientId.')
  if (!path) throw new Error('upsertAnalysisResult requires path.')
  if (!analysis) throw new Error('upsertAnalysisResult requires analysis.')

  const supabase = getSupabaseServerClient()
  const normalizedPath = normalizeSchemaPagePath(path)
  const existing = await getPageWorkRow(clientId, path)
  const now = nowIso()
  const newFinalStatus = analysis.finalStatus || null

  const payload = {
    client_id: clientId,
    normalized_path: normalizedPath,
    page_url: pageUrl,
    classification: classification || (existing ? existing.classification : null),
    target_profile: targetProfile || null,
    latest_analysis: analysis,
    analysis_status: 'analyzed',
    analyzed_at: now,
    final_status: newFinalStatus,
    last_seen_in_sitemap_at: now,
    updated_at: now
  }

  const { data, error } = await supabase.from(TABLE).upsert(payload, { onConflict: 'client_id,normalized_path' }).select().single()
  if (error) throw error

  await insertHistoryEvent(supabase, { schemaPageWorkId: data.id, clientId, eventType: 'analysis_completed', actor })

  // Only a genuine transition on an ALREADY-EXISTING row counts as a
  // "change" worth logging -- the very first analysis of a page (no prior
  // row) is an initial observation, not a status change, so it must not
  // log a from: null final_status_changed event (Section 5: "only if
  // status actually changed").
  const previousFinalStatus = existing ? existing.final_status : null
  if (existing && previousFinalStatus !== newFinalStatus) {
    await insertHistoryEvent(supabase, {
      schemaPageWorkId: data.id, clientId, eventType: 'final_status_changed',
      fromValue: previousFinalStatus, toValue: newFinalStatus, actor
    })
  }

  return data
}

// linkOpportunity({clientId, path, pageUrl, opportunityId, actor}) -> the
// current row.
//
// Called ONLY after lib/schemaOpportunity.js#qualifySchemaPageOpportunity
// has already qualified/re-observed a real Phase 3 opportunity (i.e.
// AFTER prepare-work/route.js's eligibility gate has already passed) --
// this function has no eligibility logic of its own and trusts the caller
// completely, same discipline as lib/opportunityLifecycle.js's own
// qualifyOpportunity().
//
// IDEMPOTENT: if the row is already linked to this exact opportunityId,
// this makes NO write and appends NO history event (Section 7's explicit
// "repeated preparation of the same stable opportunity should not
// generate duplicate opportunity_linked history").
//
// If the page-work row does not exist yet (an AM clicked "Prepare Schema
// Work" on a page with no prior queue/analyze activity -- prepare-work's
// own route always calls upsertAnalysisResult immediately before this, so
// in practice the row already exists by this point; this defensive path
// exists so linkOpportunity() is correct standalone, e.g. under test)
// creates it from whatever minimal identity is available -- it never
// duplicates approval_status/execution_status/verification_status/
// retest_status/prepared-work payloads, which stay exclusively in
// `opportunities`/`opportunity_prepared_work`.
async function linkOpportunity({ clientId, path, pageUrl, opportunityId, actor = 'system' }) {
  if (!clientId) throw new Error('linkOpportunity requires clientId.')
  if (!path) throw new Error('linkOpportunity requires path.')
  if (!opportunityId) throw new Error('linkOpportunity requires opportunityId.')

  const supabase = getSupabaseServerClient()
  const normalizedPath = normalizeSchemaPagePath(path)
  const existing = await getPageWorkRow(clientId, path)

  if (existing && existing.opportunity_id === opportunityId) {
    return existing
  }
  if (!existing && !pageUrl) {
    throw new Error('linkOpportunity requires pageUrl when creating a new page-work row.')
  }

  const now = nowIso()
  const payload = {
    client_id: clientId,
    normalized_path: normalizedPath,
    page_url: pageUrl || (existing ? existing.page_url : null),
    opportunity_id: opportunityId,
    updated_at: now
  }

  const { data, error } = await supabase.from(TABLE).upsert(payload, { onConflict: 'client_id,normalized_path' }).select().single()
  if (error) throw error

  await insertHistoryEvent(supabase, {
    schemaPageWorkId: data.id, clientId, eventType: 'opportunity_linked',
    fromValue: existing ? existing.opportunity_id : null, toValue: opportunityId, actor
  })

  return data
}

module.exports = {
  getPageWorkForClient,
  getPageWorkRow,
  upsertQueueState,
  upsertAnalysisResult,
  linkOpportunity
}
