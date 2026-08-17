// Phase 2 -- Prompt & Topic Intelligence: thin persistence wrapper.
//
// Mirrors lib/clientProfileFields.js's own shape and intent exactly: this
// file is the ONLY place the rest of the app should read/write
// topic_clusters / prompt_variations, so nobody is tempted to hand-roll a
// read-modify-write against those tables directly and accidentally
// reintroduce a silent-overwrite or missing-history bug. Every real
// state-transition (approve, reject, edit, business-priority confirm/
// override) is a single supabase.rpc() call into one of the Postgres
// functions created by the phase2_topic_clusters_and_prompt_variations
// migration -- see that migration for the exact locking/branching/history
// logic. This file does no branching of its own beyond thin validation.
//
// Candidate CREATION (insertCandidateTopicCluster /
// insertCandidatePromptVariation) is the one exception to "every write is
// an RPC": a brand-new candidate has no existing row to race against (it's
// a fresh gen_random_uuid()), so there's no pinning-invariant hazard the
// way there is for an update -- unlike Phase 1a/1b's confirmable fields,
// which can be concurrently re-detected AND manually edited, a freshly
// discovered candidate is only ever written by the one discovery pass that
// created it. These two functions do two sequential supabase-js calls
// (insert the row, insert its matching history row) rather than a single
// atomic RPC. Documented tradeoff, not an oversight: if the history insert
// fails after the row insert succeeds, the row exists without its
// "system_discovered" history entry. Low-risk (no financial/pinning
// consequence -- worst case is a slightly incomplete history trail on a
// row that's still a fresh, unreviewed candidate) and flagged in the
// Phase 2 completion report's Issues/Technical Debt section rather than
// silently accepted.

const { getSupabaseServerClient } = require('./supabaseServer')

const TOPIC_CLUSTER_STATUSES = ['benchmark', 'candidate', 'retired']
const BUSINESS_PRIORITY_VALUES = ['none', 'strategic']
const BUSINESS_PRIORITY_STATUSES = ['unconfirmed', 'confirmed', 'overridden']
const GEOGRAPHY_SCOPES = ['local', 'service_area', 'multi_location', 'national', 'ecommerce']
const DISCOVERY_METHODS = ['system_discovery', 'am_manual', 'legacy_migrated']

const PROMPT_VARIATION_TYPES = ['core', 'secondary']
const BRAND_MODES = ['unbranded', 'brand_aware', 'competitor_comparison']
const PROMPT_VARIATION_STATUSES = ['active', 'candidate', 'rejected', 'retired']

// Approved vocabulary -- exactly as specified. "Do not force false
// precision": overlapping tags are allowed on a variation, at most one is
// primary, and a value not in this list is never legal at the DB layer
// either (the migration's own CHECK constraints mirror this list exactly).
const INTENT_VALUES = [
  'recommendation',
  'comparison',
  'provider_vendor_selection',
  'product_service_selection',
  'problem_solution',
  'informational',
  'local_near_me',
  'reputation_trust',
  'cost_pricing',
  'expertise_qualification',
  'other'
]

// Buyer Journey is a SEPARATE model from Intent -- related, not
// interchangeable (per the approved spec). Never derive one from the other
// automatically unless the evidence actually supports it.
const BUYER_JOURNEY_VALUES = ['discover', 'evaluate', 'validate', 'select', 'problem_solution']

function assertValidClusterStatus(status) {
  if (!TOPIC_CLUSTER_STATUSES.includes(status)) {
    throw new Error(`Invalid topic_cluster status "${status}". Must be one of: ${TOPIC_CLUSTER_STATUSES.join(', ')}`)
  }
}

function assertValidBusinessPriority(priority) {
  if (!BUSINESS_PRIORITY_VALUES.includes(priority)) {
    throw new Error(`Invalid business_priority "${priority}". Must be one of: ${BUSINESS_PRIORITY_VALUES.join(', ')}`)
  }
}

// getTopicClustersForClient(clientId, opts) -> array of topic_clusters rows
// for this client (optionally filtered to one status), newest-created
// first within each status. Does NOT nest prompt_variations -- callers
// that need the full tree use getTopicClusterDetail per-cluster, or
// getTopicClustersWithVariations below for the common "whole board" case
// (used by the AM review list, which needs every cluster's variations to
// render sample-core-prompt / secondary-count without an extra round trip
// per card).
async function getTopicClustersForClient(clientId, { status } = {}) {
  const supabase = getSupabaseServerClient()
  let query = supabase.from('topic_clusters').select('*').eq('client_id', clientId).order('created_at', { ascending: false })
  if (status) {
    assertValidClusterStatus(status)
    query = query.eq('status', status)
  }
  const { data, error } = await query
  if (error) throw error
  return data || []
}

// getTopicClustersWithVariations(clientId, opts) -> array of
// { ...cluster, variations: [...] }. One extra query total (not one per
// cluster) -- fetch every cluster, then every variation for this client in
// a single query, then group in memory.
async function getTopicClustersWithVariations(clientId, { status } = {}) {
  const supabase = getSupabaseServerClient()
  const clusters = await getTopicClustersForClient(clientId, { status })
  if (clusters.length === 0) return []

  const { data: variations, error } = await supabase
    .from('prompt_variations')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: true })
  if (error) throw error

  const byCluster = new Map()
  for (const v of variations || []) {
    if (!byCluster.has(v.topic_cluster_id)) byCluster.set(v.topic_cluster_id, [])
    byCluster.get(v.topic_cluster_id).push(v)
  }

  return clusters.map(c => ({ ...c, variations: byCluster.get(c.id) || [] }))
}

// getTopicClusterDetail(clusterId) -> { ...cluster, variations: [...] } |
// null. The drill-down read for one cluster's detail view.
async function getTopicClusterDetail(clusterId) {
  const supabase = getSupabaseServerClient()
  const { data: cluster, error } = await supabase.from('topic_clusters').select('*').eq('id', clusterId).single()
  if (error) {
    if (error.code === 'PGRST116') return null // no row found
    throw error
  }
  const { data: variations, error: variationsError } = await supabase
    .from('prompt_variations')
    .select('*')
    .eq('topic_cluster_id', clusterId)
    .order('created_at', { ascending: true })
  if (variationsError) throw variationsError
  return { ...cluster, variations: variations || [] }
}

// getRetiredCandidateClusters(clientId) -> topic_clusters rows that were
// REJECTED as candidates (status='retired' AND approved_at IS NULL -- see
// fn_reject_topic_cluster's branching, which is the one place this
// distinction is created). This is the exact set discovery must check
// against for suppression: "a rejected candidate should NOT simply be
// regenerated identically on the next discovery pass" -- true retirements
// of a former BENCHMARK cluster (approved_at IS NOT NULL) are a different
// concept entirely (see RETIREMENT in the spec) and are not suppressed the
// same way.
async function getRetiredCandidateClusters(clientId) {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from('topic_clusters')
    .select('*')
    .eq('client_id', clientId)
    .eq('status', 'retired')
    .is('approved_at', null)
  if (error) throw error
  return data || []
}

// insertCandidateTopicCluster(data) -> the inserted row.
// Always inserted as status='candidate' regardless of what the caller
// passes -- discovery may NEVER silently create a benchmark row (see
// fn_approve_topic_cluster for the only legal path to status='benchmark').
async function insertCandidateTopicCluster({
  clientId,
  name,
  primaryService = null,
  whyItMatters = null,
  geographyScope = null,
  geographyValues = [],
  evidence = [],
  discoveryMethod = 'system_discovery',
  dedupeKey = null
}) {
  if (!name || !String(name).trim()) throw new Error('insertCandidateTopicCluster requires a non-empty name.')
  if (geographyScope != null && !GEOGRAPHY_SCOPES.includes(geographyScope)) {
    throw new Error(`Invalid geography_scope "${geographyScope}". Must be one of: ${GEOGRAPHY_SCOPES.join(', ')} (or null).`)
  }
  if (!DISCOVERY_METHODS.includes(discoveryMethod)) {
    throw new Error(`Invalid discovery_method "${discoveryMethod}". Must be one of: ${DISCOVERY_METHODS.join(', ')}`)
  }

  const supabase = getSupabaseServerClient()
  const row = {
    client_id: clientId,
    name: String(name).trim(),
    primary_service: primaryService,
    why_it_matters: whyItMatters,
    status: 'candidate',
    business_priority: 'none',
    business_priority_status: 'unconfirmed',
    geography_scope: geographyScope,
    geography_values: geographyValues,
    evidence,
    discovery_method: discoveryMethod,
    dedupe_key: dedupeKey
  }
  const { data, error } = await supabase.from('topic_clusters').insert(row).select().single()
  if (error) throw error

  const { error: historyError } = await supabase.from('topic_cluster_history').insert({
    client_id: clientId,
    topic_cluster_id: data.id,
    previous_value: null,
    new_value: data,
    changed_by: discoveryMethod === 'am_manual' ? 'am' : 'system',
    change_reason: 'system_discovered'
  })
  if (historyError) throw historyError

  return data
}

// insertCandidatePromptVariation(data) -> the inserted row. Always
// status='candidate' (see insertCandidateTopicCluster's header -- same
// "discovery never silently creates an active/benchmark row" invariant).
async function insertCandidatePromptVariation({
  clientId,
  topicClusterId,
  promptText,
  variationType,
  brandMode = 'unbranded',
  intentTags = [],
  intentPrimary = null,
  buyerJourneyTags = [],
  buyerJourneyPrimary = null,
  geography = null,
  discoveryMethod = 'system_discovery',
  evidence = []
}) {
  if (!promptText || !String(promptText).trim()) throw new Error('insertCandidatePromptVariation requires non-empty promptText.')
  if (!PROMPT_VARIATION_TYPES.includes(variationType)) {
    throw new Error(`Invalid variation_type "${variationType}". Must be one of: ${PROMPT_VARIATION_TYPES.join(', ')}`)
  }
  if (!BRAND_MODES.includes(brandMode)) {
    throw new Error(`Invalid brand_mode "${brandMode}". Must be one of: ${BRAND_MODES.join(', ')}`)
  }
  if (intentPrimary != null && !INTENT_VALUES.includes(intentPrimary)) {
    throw new Error(`Invalid intent_primary "${intentPrimary}".`)
  }
  if (buyerJourneyPrimary != null && !BUYER_JOURNEY_VALUES.includes(buyerJourneyPrimary)) {
    throw new Error(`Invalid buyer_journey_primary "${buyerJourneyPrimary}".`)
  }
  if (!DISCOVERY_METHODS.includes(discoveryMethod)) {
    throw new Error(`Invalid discovery_method "${discoveryMethod}". Must be one of: ${DISCOVERY_METHODS.join(', ')}`)
  }

  const supabase = getSupabaseServerClient()
  const row = {
    client_id: clientId,
    topic_cluster_id: topicClusterId,
    prompt_text: String(promptText).trim(),
    variation_type: variationType,
    brand_mode: brandMode,
    intent_tags: intentTags,
    intent_primary: intentPrimary,
    buyer_journey_tags: buyerJourneyTags,
    buyer_journey_primary: buyerJourneyPrimary,
    geography,
    status: 'candidate',
    discovery_method: discoveryMethod,
    evidence
  }
  const { data, error } = await supabase.from('prompt_variations').insert(row).select().single()
  if (error) throw error

  const { error: historyError } = await supabase.from('prompt_variation_history').insert({
    client_id: clientId,
    prompt_variation_id: data.id,
    previous_value: null,
    new_value: data,
    changed_by: discoveryMethod === 'am_manual' ? 'am' : 'system',
    change_reason: 'system_discovered'
  })
  if (historyError) throw historyError

  return data
}

// --- RPC wrappers -- every real state-transition below delegates entirely
// to the migration's Postgres functions. See that migration for exact
// locking/branching/history-write logic; this file adds no logic of its
// own beyond argument validation.

async function approveTopicCluster({ clusterId }) {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.rpc('fn_approve_topic_cluster', { p_cluster_id: clusterId })
  if (error) throw error
  return data
}

async function rejectTopicCluster({ clusterId, reason = null }) {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.rpc('fn_reject_topic_cluster', { p_cluster_id: clusterId, p_reason: reason })
  if (error) throw error
  return data
}

async function rejectPromptVariation({ variationId, reason = null }) {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.rpc('fn_reject_prompt_variation', { p_variation_id: variationId, p_reason: reason })
  if (error) throw error
  return data
}

async function editTopicCluster({ clusterId, name = null, whyItMatters = null, geographyScope = null, geographyValues = null }) {
  if (geographyScope != null && !GEOGRAPHY_SCOPES.includes(geographyScope)) {
    throw new Error(`Invalid geography_scope "${geographyScope}".`)
  }
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.rpc('fn_edit_topic_cluster', {
    p_cluster_id: clusterId,
    p_name: name,
    p_why_it_matters: whyItMatters,
    p_geography_scope: geographyScope,
    p_geography_values: geographyValues
  })
  if (error) throw error
  return data
}

// UNPROVIDED -- a sentinel distinguishing "the caller didn't pass this
// field" from "the caller explicitly passed null to clear it." This
// matters ONLY for intentPrimary/buyerJourneyPrimary/geography below --
// see the long comment on why.
const UNPROVIDED = Symbol('unprovided')

// editPromptVariation(...) -> the updated row.
//
// fn_edit_prompt_variation's OWN semantics (by design, confirmed against
// its live definition): promptText/brandMode/intentTags/buyerJourneyTags
// are COALESCED against the existing row when passed null (null = "leave
// unchanged"), but intentPrimary/buyerJourneyPrimary/geography are SET
// DIRECTLY, with no coalesce -- this is intentional, so an AM can
// explicitly clear one of those three fields (e.g. "this prompt has no
// clear primary intent after all"). The hazard that creates: a caller
// (like the AM-review UI) that only wants to edit prompt_text and sends
// nothing for the other fields must NOT have intentPrimary/
// buyerJourneyPrimary/geography silently wiped to null as a side effect of
// JS's own `undefined ?? null` collapsing "not provided" into "explicitly
// clear." This function defends against that at the call boundary: any of
// those three params left as the UNPROVIDED sentinel (i.e. genuinely
// omitted by the caller) is resolved to its CURRENT value from the
// database before the RPC call, so omitting a field always means "leave
// as-is," and only an explicit null (or a real value) reaches the RPC as
// an intentional change.
async function editPromptVariation({
  variationId,
  promptText = null,
  brandMode = null,
  intentTags = null,
  intentPrimary = UNPROVIDED,
  buyerJourneyTags = null,
  buyerJourneyPrimary = UNPROVIDED,
  geography = UNPROVIDED
}) {
  if (brandMode != null && !BRAND_MODES.includes(brandMode)) throw new Error(`Invalid brand_mode "${brandMode}".`)
  if (intentPrimary !== UNPROVIDED && intentPrimary != null && !INTENT_VALUES.includes(intentPrimary)) throw new Error(`Invalid intent_primary "${intentPrimary}".`)
  if (buyerJourneyPrimary !== UNPROVIDED && buyerJourneyPrimary != null && !BUYER_JOURNEY_VALUES.includes(buyerJourneyPrimary)) throw new Error(`Invalid buyer_journey_primary "${buyerJourneyPrimary}".`)

  const supabase = getSupabaseServerClient()

  let resolvedIntentPrimary = intentPrimary
  let resolvedBuyerJourneyPrimary = buyerJourneyPrimary
  let resolvedGeography = geography
  if (intentPrimary === UNPROVIDED || buyerJourneyPrimary === UNPROVIDED || geography === UNPROVIDED) {
    const { data: current, error: fetchError } = await supabase
      .from('prompt_variations')
      .select('intent_primary, buyer_journey_primary, geography')
      .eq('id', variationId)
      .single()
    if (fetchError) throw fetchError
    if (intentPrimary === UNPROVIDED) resolvedIntentPrimary = current.intent_primary
    if (buyerJourneyPrimary === UNPROVIDED) resolvedBuyerJourneyPrimary = current.buyer_journey_primary
    if (geography === UNPROVIDED) resolvedGeography = current.geography
  }

  const { data, error } = await supabase.rpc('fn_edit_prompt_variation', {
    p_variation_id: variationId,
    p_prompt_text: promptText,
    p_brand_mode: brandMode,
    p_intent_tags: intentTags,
    p_intent_primary: resolvedIntentPrimary,
    p_buyer_journey_tags: buyerJourneyTags,
    p_buyer_journey_primary: resolvedBuyerJourneyPrimary,
    p_geography: resolvedGeography
  })
  if (error) throw error
  return data
}

// setTopicClusterBusinessPrioritySystem -- the ONLY path automated
// discovery may use to suggest a business_priority. Mirrors Phase 1a's
// pinning invariant: never overwrites an AM-confirmed/overridden value.
// Returns 'skipped_not_unconfirmed' | 'unchanged' | 'updated'.
async function setTopicClusterBusinessPrioritySystem({ clusterId, priority }) {
  assertValidBusinessPriority(priority)
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.rpc('fn_set_topic_cluster_business_priority_system', {
    p_cluster_id: clusterId,
    p_priority: priority
  })
  if (error) throw error
  return data
}

// setTopicClusterBusinessPriorityAm -- "Mark Strategic" / "Skip" quick
// action. Always applies immediately (this IS the AM's direct decision).
async function setTopicClusterBusinessPriorityAm({ clusterId, priority }) {
  assertValidBusinessPriority(priority)
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.rpc('fn_set_topic_cluster_business_priority_am', {
    p_cluster_id: clusterId,
    p_priority: priority
  })
  if (error) throw error
  return data
}

// getClientPromptTestingConfig(clientId) -> the client's row, or the
// documented V1 defaults if none exists yet (absent row = use defaults, by
// design -- see the migration's header comment on client_prompt_testing_config).
const DEFAULT_TESTING_CONFIG = { core_cadence_days: 7, secondary_cadence_days: 28, max_prompts_per_cycle: 10 }

async function getClientPromptTestingConfig(clientId) {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.from('client_prompt_testing_config').select('*').eq('client_id', clientId).maybeSingle()
  if (error) throw error
  return data || { client_id: clientId, ...DEFAULT_TESTING_CONFIG, isDefault: true }
}

module.exports = {
  TOPIC_CLUSTER_STATUSES,
  BUSINESS_PRIORITY_VALUES,
  BUSINESS_PRIORITY_STATUSES,
  GEOGRAPHY_SCOPES,
  DISCOVERY_METHODS,
  PROMPT_VARIATION_TYPES,
  BRAND_MODES,
  PROMPT_VARIATION_STATUSES,
  INTENT_VALUES,
  BUYER_JOURNEY_VALUES,
  DEFAULT_TESTING_CONFIG,
  getTopicClustersForClient,
  getTopicClustersWithVariations,
  getTopicClusterDetail,
  getRetiredCandidateClusters,
  insertCandidateTopicCluster,
  insertCandidatePromptVariation,
  approveTopicCluster,
  rejectTopicCluster,
  rejectPromptVariation,
  editTopicCluster,
  editPromptVariation,
  setTopicClusterBusinessPrioritySystem,
  setTopicClusterBusinessPriorityAm,
  getClientPromptTestingConfig
}
