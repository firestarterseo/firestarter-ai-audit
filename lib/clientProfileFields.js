// Phase 1a -- Confirmable Client-Classification Infrastructure.
//
// This is deliberately NOT a generic "confirmable field framework." It is
// built for exactly the 8 approved Client/Industry Intelligence fields
// (FIELD_KEYS below) and generalizes no further than that. If a second real
// consumer shows up later (e.g. Prompt & Topic Intelligence's
// business_priority), that's the point at which this gets pulled out into
// something more general -- not before.
//
// Every field/item lives as ONE ROW in client_profile_fields, keyed by
// (client_id, field_key, item_index). Scalar fields (business_model,
// industry, ...) always have exactly one row at item_index 0. List fields
// (secondary_products_services, primary_geography_markets for a
// multi-location client) have one row per item, each carrying its own
// value/confidence/evidence/confirmation_status independently. This is why
// Phase 1b can add real multi-value data (a client with 3 secondary
// services, or 4 markets) without any schema change: the table is already
// row-per-item, not row-per-field.
//
// The core invariant this file exists to enforce: an AM-confirmed or
// AM-overridden value can NEVER be silently replaced by automated
// re-detection. See fn_write_client_profile_field_system in the migration
// for exactly how that's enforced at the database level (locked read +
// branch on confirmation_status, inside one atomic Postgres function --
// see that function's own header comment for why this had to be a DB
// function rather than sequential supabase-js calls).
//
// This file is intentionally thin: every state-transition (write, confirm,
// override, accept/dismiss recommendation) is a single supabase.rpc() call
// into a Postgres function that does the locking + branching + history
// write + recommendation write atomically. This file's job is just to be
// the one place the rest of the app calls into, so nobody is tempted to
// hand-roll a read-modify-write against client_profile_fields directly and
// accidentally reintroduce the silent-overwrite bug this phase exists to
// prevent.

const { getSupabaseServerClient } = require('./supabaseServer')

// The 8 approved Client/Industry Intelligence fields (Phase 1b populates
// these; Phase 1a only needs to know their names to validate against the
// same set the database CHECK constraint enforces). Do not add fields here
// speculatively -- this list should always match the migration's CHECK
// constraint exactly.
const FIELD_KEYS = [
  'business_model',
  'industry',
  'vertical_subindustry',
  'specialty',
  'primary_products_services',
  'secondary_products_services',
  'primary_customer_use_case',
  'primary_geography_markets'
]

const CONFIDENCE_VALUES = ['confirmed_by_direct_evidence', 'likely', 'uncertain']

function assertValidFieldKey(fieldKey) {
  if (!FIELD_KEYS.includes(fieldKey)) {
    throw new Error(`Unknown client-profile field_key "${fieldKey}". Must be one of: ${FIELD_KEYS.join(', ')}`)
  }
}

function assertValidConfidence(confidence) {
  if (confidence != null && !CONFIDENCE_VALUES.includes(confidence)) {
    throw new Error(`Invalid confidence "${confidence}". Must be one of: ${CONFIDENCE_VALUES.join(', ')} (or null).`)
  }
}

// getClientProfileFields(clientId) -> array of every field/item row for
// this client, across every field_key and item_index. Phase 1b's
// getClientIndustryProfile(clientId) will group this by field_key into the
// actual profile shape -- that grouping is deliberately NOT built here,
// since it's Phase 1b's job to decide how each field_key maps to a
// human-facing profile property.
async function getClientProfileFields(clientId) {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from('client_profile_fields')
    .select('field_key, item_index, value, confidence, evidence, confirmation_status, last_verified_at, created_at, updated_at')
    .eq('client_id', clientId)
    .order('field_key', { ascending: true })
    .order('item_index', { ascending: true })
  if (error) throw error
  return data || []
}

// getOpenClientProfileRecommendations(clientId) -> array of open
// recommendations for this client, for whatever review-queue UI Phase 1b
// builds.
async function getOpenClientProfileRecommendations(clientId) {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from('client_profile_recommendations')
    .select('id, field_key, item_index, current_value, recommended_value, recommended_confidence, recommended_evidence, detected_at')
    .eq('client_id', clientId)
    .eq('status', 'open')
    .order('detected_at', { ascending: true })
  if (error) throw error
  return data || []
}

// writeSystemDetectedField(...) -- the ONLY path automated classification
// (Phase 1b) may use to write a value. Delegates entirely to
// fn_write_client_profile_field_system, which is the one place the
// pinning invariant is enforced: if the target field is unconfirmed, it
// writes through; if it's confirmed/overridden, it never touches the
// current value and instead creates or refreshes a recommendation.
//
// Returns one of: 'inserted' | 'updated' | 'unchanged' |
// 'no_conflict_matches_confirmed' | 'conflict_recommendation_created' |
// 'conflict_recommendation_updated' | 'recommendation_refreshed'
// so callers (and tests) can assert on exactly what happened.
async function writeSystemDetectedField({ clientId, fieldKey, itemIndex = 0, value, confidence, evidence = [] }) {
  assertValidFieldKey(fieldKey)
  assertValidConfidence(confidence)
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.rpc('fn_write_client_profile_field_system', {
    p_client_id: clientId,
    p_field_key: fieldKey,
    p_item_index: itemIndex,
    p_value: value,
    p_confidence: confidence,
    p_evidence: evidence
  })
  if (error) throw error
  return data
}

// confirmClientProfileField(...) -- AM accepts the current detected value
// as-is. Only valid while confirmation_status = 'unconfirmed' (the DB
// function raises if not; a stale_recommendation_pending field must be
// resolved via accept/dismiss instead, so the AM's intent is always
// explicit).
async function confirmClientProfileField({ clientId, fieldKey, itemIndex = 0 }) {
  assertValidFieldKey(fieldKey)
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.rpc('fn_confirm_client_profile_field', {
    p_client_id: clientId,
    p_field_key: fieldKey,
    p_item_index: itemIndex
  })
  if (error) throw error
  return data
}

// overrideClientProfileField(...) -- AM supplies their own value directly.
// Always wins immediately regardless of current confirmation_status (this
// IS the direct-evidence case -- confidence is set to
// 'confirmed_by_direct_evidence' automatically, not asked of the AM). If an
// open recommendation existed for this slot, it's implicitly dismissed as
// part of the same atomic call, since the AM's own value supersedes it.
async function overrideClientProfileField({ clientId, fieldKey, itemIndex = 0, value, evidence = [] }) {
  assertValidFieldKey(fieldKey)
  if (value == null || value === '') {
    throw new Error('overrideClientProfileField requires a non-empty value -- use a future "clear field" action if the intent is to blank it out.')
  }
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.rpc('fn_override_client_profile_field', {
    p_client_id: clientId,
    p_field_key: fieldKey,
    p_item_index: itemIndex,
    p_value: value,
    p_evidence: evidence
  })
  if (error) throw error
  return data
}

// acceptClientProfileRecommendation(...) -- AM accepts a pending
// recommendation: the recommended value becomes the current, confirmed
// value; the recommendation closes; exactly one history row is written.
// Atomic (single Postgres function call) so it's impossible to end up with
// the recommendation closed but the field unchanged, or vice versa.
async function acceptClientProfileRecommendation({ recommendationId }) {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.rpc('fn_accept_client_profile_recommendation', {
    p_recommendation_id: recommendationId
  })
  if (error) throw error
  return data
}

// dismissClientProfileRecommendation(...) -- AM dismisses a pending
// recommendation: the current value is untouched, the field's
// confirmation_status reverts to whatever it was before the conflict was
// detected (confirmed or overridden), and a history row records that this
// decision was made -- without pretending the value itself changed.
async function dismissClientProfileRecommendation({ recommendationId }) {
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase.rpc('fn_dismiss_client_profile_recommendation', {
    p_recommendation_id: recommendationId
  })
  if (error) throw error
  return data
}

module.exports = {
  FIELD_KEYS,
  CONFIDENCE_VALUES,
  getClientProfileFields,
  getOpenClientProfileRecommendations,
  writeSystemDetectedField,
  confirmClientProfileField,
  overrideClientProfileField,
  acceptClientProfileRecommendation,
  dismissClientProfileRecommendation
}
