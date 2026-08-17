// Phase 2 -- Testing Cadence Scheduler.
//
// Answers exactly one question: "WHICH PROMPT VARIATIONS ARE DUE THIS
// CYCLE?" -- configurable per-client (core cadence, secondary cadence,
// call-budget), never hard-coded "every prompt x every engine x every
// week." This does NOT decide adaptively/intelligently yet (the spec is
// explicit: "do not make the final cadence intelligence adaptive yet,
// build the configuration and scheduler capability") -- it's a
// deterministic due/deferred calculation over whatever cadence config is
// in effect.
//
// Split into a pure, DB-free core (computeDuePromptVariations) and a thin
// async DB-fetching wrapper (getDuePromptVariations), same "pure logic
// separated from I/O" pattern Phase 1b's predictWriteOutcome/
// persistClassification split established -- this is what makes the core
// scheduling logic directly unit-testable in any environment, including
// this sandbox, with zero DB credentials.
//
// NOT WIRED into the weekly cron yet, by design -- the spec is explicit:
// "Do not attach a massive new workload to the weekly cron yet without
// first understanding the current cron execution model." This phase stops
// at making "what's due" answerable and "mark as tested" safe to call;
// wiring trackAiVisibility.js/the cron route up to actually iterate due
// variations is a follow-on integration decision, not a Phase 2 deliverable
// ("do not modify unrelated pillars").

const { getSupabaseServerClient } = require('./supabaseServer')
const { getClientPromptTestingConfig, DEFAULT_TESTING_CONFIG } = require('./topicClusters')

const MS_PER_DAY = 24 * 60 * 60 * 1000

function cadenceDaysFor(variationType, config) {
  const cfg = config || DEFAULT_TESTING_CONFIG
  return variationType === 'core'
    ? (cfg.core_cadence_days ?? DEFAULT_TESTING_CONFIG.core_cadence_days)
    : (cfg.secondary_cadence_days ?? DEFAULT_TESTING_CONFIG.secondary_cadence_days)
}

// computeDuePromptVariations(variations, config, asOf) -> { due, deferred }
//   variations: array of prompt_variations rows (any status is accepted --
//     only 'active' rows are ever considered due; everything else is
//     passed through untouched in neither list).
//   config: { core_cadence_days, secondary_cadence_days, max_prompts_per_cycle }
//   asOf: a Date -- the "now" this calculation is relative to. Passed in
//     explicitly (never computed internally via `new Date()`/Date.now())
//     so this function is fully deterministic and safely re-callable with
//     a fixed clock in tests and in Workflow-style replay contexts.
//
// due[] -- eligible AND selected within this cycle's call budget, sorted
// core-before-secondary, then most-overdue-first, then oldest-tested-first.
// Each entry carries dueSince/cadenceDays so callers/tests can see WHY it
// was picked.
//
// deferred[] -- eligible but pushed past this cycle's max_prompts_per_cycle
// budget, annotated deferredDueToBudget:true. NEVER silently dropped --
// "if more eligible prompts exist than the current budget permits:
// schedule/rotate them. Do not silently drop them" -- callers/UI can
// surface this list directly (e.g. "12 more prompts eligible, deferred to
// next cycle").
function computeDuePromptVariations(variations, config, asOf) {
  const cfg = config || DEFAULT_TESTING_CONFIG
  const now = asOf instanceof Date ? asOf : new Date(asOf)
  const maxPerCycle = Number.isFinite(cfg.max_prompts_per_cycle) ? cfg.max_prompts_per_cycle : DEFAULT_TESTING_CONFIG.max_prompts_per_cycle

  const active = (variations || []).filter(v => v.status === 'active')

  const eligible = []
  for (const v of active) {
    const cadenceDays = cadenceDaysFor(v.variation_type, cfg)
    let nextEligibleAt
    if (v.next_eligible_at) {
      nextEligibleAt = new Date(v.next_eligible_at)
    } else if (v.last_tested_at) {
      nextEligibleAt = new Date(new Date(v.last_tested_at).getTime() + cadenceDays * MS_PER_DAY)
    } else {
      // Never tested -- due immediately, regardless of cadence.
      nextEligibleAt = null
    }

    const isDue = nextEligibleAt == null || nextEligibleAt.getTime() <= now.getTime()
    if (!isDue) continue

    const overdueDays = nextEligibleAt == null
      ? Infinity // never-tested variations are the most overdue, by definition
      : (now.getTime() - nextEligibleAt.getTime()) / MS_PER_DAY

    eligible.push({
      ...v,
      cadenceDays,
      dueSince: nextEligibleAt ? nextEligibleAt.toISOString() : null,
      overdueDays
    })
  }

  // Priority order: core before secondary (the stable benchmark wording
  // matters more than semantic-variance sampling), then most-overdue-first,
  // then oldest last_tested_at first as a tiebreak (never-tested treated as
  // oldest of all, via a null-safe comparable timestamp).
  eligible.sort((a, b) => {
    if (a.variation_type !== b.variation_type) return a.variation_type === 'core' ? -1 : 1
    if (a.overdueDays !== b.overdueDays) return b.overdueDays - a.overdueDays
    const at = a.last_tested_at ? new Date(a.last_tested_at).getTime() : -Infinity
    const bt = b.last_tested_at ? new Date(b.last_tested_at).getTime() : -Infinity
    return at - bt
  })

  const due = eligible.slice(0, maxPerCycle)
  const deferred = eligible.slice(maxPerCycle).map(v => ({ ...v, deferredDueToBudget: true }))

  return { due, deferred, config: cfg, asOf: now.toISOString() }
}

// getDuePromptVariations(clientId, opts) -> async wrapper. Fetches this
// client's active prompt_variations + its testing config (or the
// documented defaults, if no client_prompt_testing_config row exists yet),
// then delegates entirely to computeDuePromptVariations.
async function getDuePromptVariations(clientId, { asOf } = {}) {
  const supabase = getSupabaseServerClient()
  const { data: variations, error } = await supabase
    .from('prompt_variations')
    .select('*')
    .eq('client_id', clientId)
    .eq('status', 'active')
  if (error) throw error

  const config = await getClientPromptTestingConfig(clientId)
  return computeDuePromptVariations(variations || [], config, asOf ? new Date(asOf) : new Date())
}

// markPromptVariationTested(variationId, testedAt, opts) -> updated row.
// Forward-compatible write helper -- NOT called by anything yet (no
// tracking loop consumes computeDuePromptVariations' output this phase).
// Deliberately a plain update, not a history-tracked RPC: this is
// operational scheduling bookkeeping (when a variation was last actually
// tested), not one of the reviewable state-transitions
// topic_cluster_history/prompt_variation_history exist to record (compare
// their change_reason CHECK constraints, which only cover discovery/AM
// review actions, never "a test ran").
async function markPromptVariationTested(variationId, testedAt, { variationType, cadenceDaysOverride } = {}) {
  const supabase = getSupabaseServerClient()
  const tested = testedAt instanceof Date ? testedAt : new Date(testedAt)

  let resolvedType = variationType
  if (!resolvedType) {
    const { data: existing, error: fetchError } = await supabase
      .from('prompt_variations')
      .select('variation_type, client_id')
      .eq('id', variationId)
      .single()
    if (fetchError) throw fetchError
    resolvedType = existing.variation_type
  }

  const cadenceDays = cadenceDaysOverride ?? cadenceDaysFor(resolvedType, DEFAULT_TESTING_CONFIG)
  const nextEligibleAt = new Date(tested.getTime() + cadenceDays * MS_PER_DAY)

  const { data, error } = await supabase
    .from('prompt_variations')
    .update({ last_tested_at: tested.toISOString(), next_eligible_at: nextEligibleAt.toISOString() })
    .eq('id', variationId)
    .select()
    .single()
  if (error) throw error
  return data
}

module.exports = {
  DEFAULT_TESTING_CONFIG,
  computeDuePromptVariations,
  getDuePromptVariations,
  markPromptVariationTested,
  cadenceDaysFor
}
