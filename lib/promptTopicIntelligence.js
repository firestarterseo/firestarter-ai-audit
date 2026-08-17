// Phase 2 -- Prompt & Topic Intelligence.
//
// Answers "WHAT COMMERCIALLY MEANINGFUL QUESTIONS SHOULD WE TRACK FOR THIS
// CLIENT ACROSS AI ENGINES?" as a structured benchmark of TOPIC CLUSTERS
// (lib/topicClusters.js) with controlled PROMPT VARIATIONS -- not a list of
// keywords, not 50 random prompts. The normal AM experience this produces
// is "WE RECOMMEND TRACKING THESE TOPICS," never "please write the
// questions you want to track."
//
// BUSINESS CONTEXT FIRST: discovery begins with
// getClientIndustryProfile(clientId) (lib/clientIndustryIntelligence.js) --
// the Phase 1b canonical read model -- and does NOT independently re-fetch
// the homepage or re-derive business classification. That is Phase 1b's
// job; this module only consumes its output, same as any other pillar
// would.
//
// REUSE, NOT REBUILD: this module composes existing capabilities exactly
// like Phase 1b did --
//   - lib/clientIndustryIntelligence.js's getClientIndustryProfile (the
//     shared canonical business-context read model)
//   - lib/checkers/ahrefs.js's getOrganicKeywords (supporting search-demand
//     evidence only -- see gatherDiscoveryEvidence's header for why this is
//     called directly rather than through topPromptCandidates)
//   - lib/llm/anthropic.js's callAnthropicTool (the existing forced-tool-
//     use pattern -- one call per discovery pass, not one call per cluster)
//   - lib/topicClusters.js (the ONLY path this module may use to persist
//     anything)
//
// DISCOVERY VS BENCHMARK: everything this module writes lands as
// status='candidate'. Nothing here ever promotes a cluster/variation into
// the benchmark -- that is exclusively an AM action
// (lib/topicClusters.js's approveTopicCluster/approvePromptVariation-via-
// cluster-approval). "System may automatically discover candidates. System
// may NOT silently add candidates into the benchmark."

const { getClientIndustryProfile } = require('./clientIndustryIntelligence')
const { getOrganicKeywords } = require('./checkers/ahrefs')
const { callAnthropicTool } = require('./llm/anthropic')
const { getSupabaseServerClient } = require('./supabaseServer')
const {
  INTENT_VALUES,
  BUYER_JOURNEY_VALUES,
  BRAND_MODES,
  GEOGRAPHY_SCOPES,
  getRetiredCandidateClusters,
  insertCandidateTopicCluster,
  insertCandidatePromptVariation,
  setTopicClusterBusinessPrioritySystem
} = require('./topicClusters')

// Target range for an initial benchmark -- "a starting range, not a hard
// database cap." Used only to steer the system prompt; never enforced as
// a hard slice/truncation on the model's actual output (see
// normalizeDiscoveryResult -- nothing here silently drops a cluster the
// model proposed beyond this range).
const TARGET_CLUSTER_COUNT_MIN = 10
const TARGET_CLUSTER_COUNT_MAX = 15

// MAX_SECONDARY_PER_CLUSTER -- "normally 1 CORE + 1-3 SECONDARY per
// cluster." Enforced in application logic (enforceCoreSecondaryConvention
// below), NOT a database constraint -- per the spec: "Do NOT create a
// rigid database uniqueness constraint that permanently prevents multiple
// core prompts later."
const MAX_SECONDARY_PER_CLUSTER = 3

// gatherDiscoveryEvidence(clientId) -> evidence bundle, or a graceful
// { ok:false, reason } when discovery cannot defensibly proceed.
//
// Deliberately bounded: at most one Ahrefs organic-keywords call, zero
// homepage fetches (business-context is Phase 1b's job, not this module's
// -- see header), zero Anthropic calls (that happens once, later, in
// discoverTopicClusters). A client with no Client/Industry Intelligence
// profile yet fails gracefully here (test 20: "client with no profile
// fails/degrades gracefully rather than fabricating prompts") rather than
// falling through to some independently-guessed business context.
async function gatherDiscoveryEvidence(clientId) {
  if (!clientId) return { ok: false, reason: 'missing_client_id' }

  const profile = await getClientIndustryProfile(clientId)
  if (!profile || !profile.hasAnyProfileData) {
    return { ok: false, reason: 'no_client_industry_profile', clientId }
  }

  const supabase = getSupabaseServerClient()
  const { data: client, error } = await supabase
    .from('clients')
    .select('id, name, url, domain, city, region, category, test_prompts')
    .eq('id', clientId)
    .single()
  if (error) throw error

  let ahrefsKeywords = []
  const ahrefsConfigured = !!process.env.AHREFS_API_KEY
  const domain = client.domain || (client.url ? client.url.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null)
  if (ahrefsConfigured && domain) {
    // Raw rows (not topPromptCandidates' phrasing-oriented output) --
    // discovery needs volume/local/branded fields as SUPPORTING EVIDENCE
    // for the LLM to reason over, not a ready-made prompt list. "Do not
    // simply convert top organic keywords into AI prompts."
    const rows = await getOrganicKeywords(domain, { apiKey: process.env.AHREFS_API_KEY, limit: 30 })
    ahrefsKeywords = rows.filter(r => !r.branded).slice(0, 20)
  }

  const existingClusters = await require('./topicClusters').getTopicClustersWithVariations(clientId)
  const rejectedCandidateClusters = await getRetiredCandidateClusters(clientId)

  return {
    ok: true,
    clientId,
    client,
    profile,
    ahrefsConfigured,
    ahrefsKeywords,
    legacyTestPrompts: client.test_prompts || [],
    existingClusters,
    rejectedCandidateClusters
  }
}

// --- Dedupe / suppression -----------------------------------------------

// computeDedupeKey(clusterName, primaryService, geographyScope) -> a stable
// lowercase key used to recognize "the same candidate idea" across
// discovery passes. Keyed on primary_service + geography_scope when a
// primary_service is available (the two things that actually define a
// commercial topic), falling back to a normalized name when it isn't.
function computeDedupeKey(clusterName, primaryService, geographyScope) {
  const norm = s => (s || '').toString().trim().toLowerCase().replace(/\s+/g, ' ')
  if (primaryService) return `service:${norm(primaryService)}|geo:${norm(geographyScope)}`
  return `name:${norm(clusterName)}`
}

// shouldSuppressCandidate(dedupeKey, rejectedClusters, profile) -> boolean.
// "A rejected candidate should NOT simply be regenerated identically on the
// next discovery pass. It may reappear later only if materially new
// evidence justifies reconsideration." Materially-new-evidence heuristic:
// compare the rejected cluster's retired_at against the MOST RECENT
// last_verified_at across the client's confirmed profile fields -- if the
// business profile itself has been re-verified/changed since the
// rejection, that is real new evidence; if not, the rejection still stands
// and this candidate is suppressed. This is plain, inspectable logic, not
// LLM discretion.
function mostRecentProfileVerification(profile) {
  const timestamps = []
  const scalarFields = [profile.businessModel, profile.industry, profile.verticalSubindustry, profile.specialty, profile.primaryCustomerUseCase]
  for (const f of scalarFields) if (f && f.lastVerifiedAt) timestamps.push(new Date(f.lastVerifiedAt).getTime())
  const listFields = [profile.primaryProductsServices, profile.secondaryProductsServices, profile.primaryGeographyMarkets]
  for (const list of listFields) {
    for (const item of list || []) if (item.lastVerifiedAt) timestamps.push(new Date(item.lastVerifiedAt).getTime())
  }
  if (timestamps.length === 0) return null
  return new Date(Math.max(...timestamps))
}

function shouldSuppressCandidate(dedupeKey, rejectedClusters, profile) {
  const match = (rejectedClusters || []).find(c => c.dedupe_key === dedupeKey)
  if (!match) return { suppressed: false }

  const profileVerifiedAt = mostRecentProfileVerification(profile)
  const rejectedAt = match.retired_at ? new Date(match.retired_at) : null
  const materiallyNewEvidence = !!(profileVerifiedAt && rejectedAt && profileVerifiedAt.getTime() > rejectedAt.getTime())

  return {
    suppressed: !materiallyNewEvidence,
    matchedClusterId: match.id,
    matchedClusterName: match.name,
    rejectionReason: match.retired_reason,
    materiallyNewEvidence
  }
}

// --- Core/secondary convention enforcement ------------------------------

// enforceCoreSecondaryConvention(variations) -> normalized array.
// Pure function -- no DB, no LLM. Guarantees exactly ONE core (the first
// one the model marked core, or the first variation at all if none was
// marked core) and caps secondaries at MAX_SECONDARY_PER_CLUSTER (extra
// secondaries beyond the cap are dropped -- NOT silently from the model's
// intent, since the system prompt already asks for at most this many; this
// is a defensive backstop, and callers can inspect the `droppedCount`
// return field rather than have it happen invisibly).
function enforceCoreSecondaryConvention(variations) {
  const list = Array.isArray(variations) ? variations.slice() : []
  if (list.length === 0) return { variations: [], droppedCount: 0 }

  let coreIndex = list.findIndex(v => v.variation_type === 'core')
  if (coreIndex === -1) coreIndex = 0

  const core = { ...list[coreIndex], variation_type: 'core' }
  const rest = list.filter((_, i) => i !== coreIndex).map(v => ({ ...v, variation_type: 'secondary' }))

  const secondaries = rest.slice(0, MAX_SECONDARY_PER_CLUSTER)
  const droppedCount = rest.length - secondaries.length

  return { variations: [core, ...secondaries], droppedCount }
}

// --- Business-priority correlation --------------------------------------

// suggestSystemBusinessPriority(cluster, profile) -> 'none' | 'strategic'.
// Plain, inspectable correlation rule -- NOT an LLM judgment call: a
// cluster whose primary_service matches the client's #1 (item_index 0)
// primary product/service is suggested 'strategic'; everything else
// (secondary services, unmatched/geography-only clusters) is 'none'. This
// is a SUGGESTION only -- written via the system (never-overwrites-a-
// pinned-value) RPC path, exactly like Phase 1a's own confirmable-field
// behavior, and is always AM-overridable via "Mark Strategic"/"Skip."
function suggestSystemBusinessPriority(cluster, profile) {
  const topPrimaryService = (profile.primaryProductsServices || [])[0]
  if (!topPrimaryService || !cluster.primary_service) return 'none'
  const norm = s => (s || '').toString().trim().toLowerCase()
  return norm(topPrimaryService.value) === norm(cluster.primary_service) ? 'strategic' : 'none'
}

// --- Anthropic forced-tool-use discovery call ---------------------------

function variationSchema() {
  return {
    type: 'object',
    properties: {
      prompt_text: {
        type: 'string',
        description: 'A realistic, natural customer question or search phrase -- exactly how a real person would ask an AI engine this. NEVER a keyword string, NEVER the client\'s own brand name stapled onto a category, NEVER search-volume metadata folded into the wording. Good: "Best SEO company in Denver", "Who would you recommend for local SEO in Denver?". Bad: "Denver SEO company agency service best top provider", "Firestarter SEO best Denver SEO company yes?", "SEO Denver volume 1200".'
      },
      variation_type: { type: 'string', enum: ['core', 'secondary'] },
      brand_mode: { type: 'string', enum: BRAND_MODES, description: 'unbranded = a natural discovery/commercial question with no client or competitor name in it (this should form most of the benchmark). brand_aware = the client\'s own name is directly asked about (reputation/trust/entity understanding). competitor_comparison = the client is explicitly compared against one named competitor -- use sparingly, only when a specific real competitor is known; should not dominate the benchmark.' },
      intent_tags: { type: 'array', items: { type: 'string', enum: INTENT_VALUES }, description: 'Every intent that genuinely applies -- overlap is allowed and expected.' },
      intent_primary: { type: ['string', 'null'], enum: [...INTENT_VALUES, null] },
      buyer_journey_tags: { type: 'array', items: { type: 'string', enum: BUYER_JOURNEY_VALUES } },
      buyer_journey_primary: { type: ['string', 'null'], enum: [...BUYER_JOURNEY_VALUES, null] }
    },
    required: ['prompt_text', 'variation_type', 'brand_mode', 'intent_tags', 'intent_primary', 'buyer_journey_tags', 'buyer_journey_primary']
  }
}

const DISCOVERY_TOOL = {
  name: 'propose_topic_clusters',
  description: 'Propose a defensible initial benchmark of topic clusters (roughly 10-15, a target range not a hard cap) for tracking this client\'s AI visibility, each with one core prompt and 0-3 secondary variations.',
  input_schema: {
    type: 'object',
    properties: {
      topic_clusters: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'A short, human-readable topic name, e.g. "Local SEO Services in Denver".' },
            primary_service: { type: ['string', 'null'], description: 'Which of the client\'s own products/services this cluster is about, if any -- must match (or closely match) one of the services provided in the input evidence. Null only for a cluster that is genuinely not service-specific.' },
            why_it_matters: { type: 'string', description: 'One or two sentences of plain AM-facing rationale for why this topic is worth tracking -- not a restatement of the topic name.' },
            geography_scope: { type: ['string', 'null'], enum: [...GEOGRAPHY_SCOPES, null], description: 'Must match the business model in the input evidence -- do not invent a geography scope the evidence does not support.' },
            geography_values: { type: 'array', items: { type: 'string' } },
            evidence: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', description: 'Which input evidence this draws from, e.g. "primary_products_services", "ahrefs_organic_keyword", "primary_geography_markets", "legacy_test_prompt".' },
                  detail: { type: 'string', description: 'The specific evidence value (quote or closely paraphrase it) -- not a restatement of the cluster name.' }
                },
                required: ['type', 'detail']
              },
              description: 'Cite the SPECIFIC input evidence this cluster is grounded in. A single strong signal is enough to justify a candidate -- do not pad this to look thorough.'
            },
            prompt_variations: {
              type: 'array',
              minItems: 1,
              maxItems: 4,
              items: variationSchema(),
              description: 'Exactly one item with variation_type "core" (the stable benchmark wording), plus 0-3 items with variation_type "secondary" (controlled semantic variations of the SAME underlying question, not unrelated new topics).'
            }
          },
          required: ['name', 'why_it_matters', 'geography_scope', 'geography_values', 'evidence', 'prompt_variations']
        }
      }
    },
    required: ['topic_clusters']
  }
}

function buildDiscoverySystemPrompt() {
  return `You are recommending an initial AI-visibility measurement benchmark for a real SEO agency's client, for an internal tool used by account managers (AMs). The AM experience this produces must be "we recommend tracking these topics," never "please write the questions you want to track" -- so every cluster and prompt you propose must be immediately usable as-is, grounded in the real evidence provided, and read like something a human strategist would actually propose.

WHAT A "TOPIC CLUSTER" IS: a commercially meaningful question area to track across AI engines (ChatGPT, Gemini, Perplexity, Copilot, Google) -- not a keyword, not a random search term. Each cluster gets exactly one CORE prompt (stable wording, tested most often) plus 0-3 SECONDARY prompts (controlled semantic variations of the SAME question, used to reduce wording-sensitivity and measure variance -- NOT unrelated new topics).

NATURAL PROMPT QUALITY -- every prompt_text must resemble a real customer question, not a keyword string:
GOOD: "Best SEO company in Denver", "Who would you recommend for local SEO in Denver?", "What SEO agency is best for a small business in Denver?", "Which Denver SEO agencies have strong local SEO experience?"
BAD (never produce anything like this): "Denver SEO company agency service best top provider", "Firestarter SEO best Denver SEO company yes?", "SEO Denver volume 1200"

BUSINESS CONTEXT COMES FIRST: ground every cluster in the client's REAL, already-classified business profile provided in the input (business model, industry, specialty, products/services, primary customer/use case, geography). Do not invent a business fact that isn't in the evidence. Ahrefs organic keywords and any legacy test prompts are SUPPORTING evidence only -- do not simply convert a top keyword into a prompt; synthesize the natural customer question the keyword is evidence FOR.

UNBRANDED VS BRAND-AWARE: unbranded discovery prompts (no client or competitor name) should form the core of the benchmark -- these measure real commercial discovery. Brand-aware prompts (the client's own name is asked about directly) measure reputation/trust/entity understanding, not discovery -- include some, but do not blend them into the same prompt without a clear reason. Competitor-comparison prompts (naming one specific real competitor) may appear but must not dominate.

GEOGRAPHY: follow the business model in the evidence. A Local/Service-Area business naturally gets city/metro context. A Multi-location business should only get location-specific clusters where it's commercially justified -- do not generate near-duplicate clusters for every city. A National business should not have location modifiers forced onto it. An Ecommerce business's product/use-case context usually matters more than geography.

INTENT (tags, one may be primary) -- use ONLY these values, do not force false precision: recommendation, comparison, provider_vendor_selection, product_service_selection, problem_solution, informational, local_near_me, reputation_trust, cost_pricing, expertise_qualification, other.

BUYER JOURNEY (tags, one may be primary) -- a SEPARATE model from intent, related but not interchangeable; do not derive one from the other automatically. Use ONLY: discover, evaluate, validate, select, problem_solution.

SCALE: aim for roughly 10-15 total topic clusters -- a target range, not a hard cap and not a quota to pad out. Prioritize real coverage: important services, strategic topics, the discover/evaluate/validate/select commercial journey, problem/solution questions, a little useful informational/citation-worthy territory, and geography only where the business model actually calls for it. Do not let one service dominate just because it has more keyword volume than another -- cover the client's real service mix.

EVIDENCE: every cluster must cite the specific input evidence it's grounded in (which profile field, which keyword, which legacy prompt). A single strong signal is enough -- do not require multiple evidence types to pad out a cluster that's already well-supported by one direct signal.`
}

function buildDiscoveryUserMessage(evidence) {
  const { profile, ahrefsKeywords, legacyTestPrompts, existingClusters, client } = evidence
  return JSON.stringify({
    client: { name: client.name, city: client.city, region: client.region },
    businessProfile: {
      businessModel: profile.businessModel?.value || null,
      industry: profile.industry?.value || null,
      verticalSubindustry: profile.verticalSubindustry?.value || null,
      specialty: profile.specialty?.value || null,
      primaryCustomerUseCase: profile.primaryCustomerUseCase?.value || null,
      primaryProductsServices: (profile.primaryProductsServices || []).map(i => i.value),
      secondaryProductsServices: (profile.secondaryProductsServices || []).map(i => i.value),
      primaryGeographyMarkets: (profile.primaryGeographyMarkets || []).map(i => i.value)
    },
    supportingEvidence: {
      ahrefsOrganicKeywords: (ahrefsKeywords || []).map(k => ({ keyword: k.keyword, volume: k.volume, local: k.local })),
      legacyTestPrompts: legacyTestPrompts || []
    },
    existingTopicClusterNames: (existingClusters || []).map(c => c.name)
  })
}

function normalizeVariation(raw) {
  const intentTags = Array.isArray(raw.intent_tags) ? raw.intent_tags.filter(t => INTENT_VALUES.includes(t)) : []
  const intentPrimary = INTENT_VALUES.includes(raw.intent_primary) ? raw.intent_primary : null
  const buyerJourneyTags = Array.isArray(raw.buyer_journey_tags) ? raw.buyer_journey_tags.filter(t => BUYER_JOURNEY_VALUES.includes(t)) : []
  const buyerJourneyPrimary = BUYER_JOURNEY_VALUES.includes(raw.buyer_journey_primary) ? raw.buyer_journey_primary : null
  return {
    prompt_text: String(raw.prompt_text || '').trim(),
    variation_type: raw.variation_type === 'core' ? 'core' : 'secondary',
    brand_mode: BRAND_MODES.includes(raw.brand_mode) ? raw.brand_mode : 'unbranded',
    intent_tags: intentTags,
    intent_primary: intentPrimary,
    buyer_journey_tags: buyerJourneyTags,
    buyer_journey_primary: buyerJourneyPrimary
  }
}

// normalizeDiscoveryResult(rawResult, evidence) -> array of normalized
// cluster candidates, each with its enforced core/secondary variation set
// and a computed dedupe key. No suppression/persistence here -- pure
// shaping of the LLM's raw tool-call output into this module's internal
// candidate shape.
function normalizeDiscoveryResult(rawResult) {
  const clusters = Array.isArray(rawResult?.topic_clusters) ? rawResult.topic_clusters : []
  return clusters
    .filter(c => c && c.name && Array.isArray(c.prompt_variations) && c.prompt_variations.length > 0)
    .map(c => {
      const normalizedVariations = c.prompt_variations.map(normalizeVariation).filter(v => v.prompt_text)
      const { variations, droppedCount } = enforceCoreSecondaryConvention(normalizedVariations)
      const geographyScope = GEOGRAPHY_SCOPES.includes(c.geography_scope) ? c.geography_scope : null
      return {
        name: String(c.name).trim(),
        primary_service: c.primary_service ? String(c.primary_service).trim() : null,
        why_it_matters: c.why_it_matters ? String(c.why_it_matters).trim() : null,
        geography_scope: geographyScope,
        geography_values: Array.isArray(c.geography_values) ? c.geography_values : [],
        evidence: Array.isArray(c.evidence) ? c.evidence : [],
        variations,
        droppedVariationCount: droppedCount,
        dedupe_key: computeDedupeKey(c.name, c.primary_service, geographyScope)
      }
    })
}

// discoverTopicClusters(clientId, opts) -> discovery result.
// dryRun (default true): predicts everything (suppression decisions,
// suggested business priority, the full proposed cluster/variation set)
// WITHOUT writing anything to the database -- used by the AM Review UI's
// "Discover topics" preview and by real-client validation passes.
async function discoverTopicClusters(clientId, { dryRun = true } = {}) {
  const evidence = await gatherDiscoveryEvidence(clientId)
  if (!evidence.ok) {
    return { ok: false, reason: evidence.reason, clientId, dryRun }
  }

  const { result, error } = await callAnthropicTool({
    system: buildDiscoverySystemPrompt(),
    user: buildDiscoveryUserMessage(evidence),
    tool: DISCOVERY_TOOL,
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxTokens: 8192
  })

  if (error || !result) {
    return {
      ok: false,
      reason: 'llm_call_failed',
      error: error || { status: null, message: 'No discovery result returned.' },
      clientId,
      dryRun
    }
  }

  const normalizedClusters = normalizeDiscoveryResult(result)

  const proposed = []
  const suppressed = []
  for (const cluster of normalizedClusters) {
    const suppression = shouldSuppressCandidate(cluster.dedupe_key, evidence.rejectedCandidateClusters, evidence.profile)
    if (suppression.suppressed) {
      suppressed.push({ ...cluster, suppression })
      continue
    }
    const suggestedBusinessPriority = suggestSystemBusinessPriority(cluster, evidence.profile)
    proposed.push({ ...cluster, suggestedBusinessPriority, reconsideredAfterRejection: !!suppression.matchedClusterId })
  }

  if (dryRun) {
    return { ok: true, dryRun: true, clientId, proposedClusters: proposed, suppressedCandidates: suppressed, evidenceAvailable: { ahrefsConfigured: evidence.ahrefsConfigured, ahrefsKeywordCount: evidence.ahrefsKeywords.length, legacyTestPromptCount: evidence.legacyTestPrompts.length } }
  }

  const created = []
  for (const cluster of proposed) {
    const clusterRow = await insertCandidateTopicCluster({
      clientId,
      name: cluster.name,
      primaryService: cluster.primary_service,
      whyItMatters: cluster.why_it_matters,
      geographyScope: cluster.geography_scope,
      geographyValues: cluster.geography_values,
      evidence: cluster.evidence,
      discoveryMethod: 'system_discovery',
      dedupeKey: cluster.dedupe_key
    })

    const variationRows = []
    for (const v of cluster.variations) {
      const vRow = await insertCandidatePromptVariation({
        clientId,
        topicClusterId: clusterRow.id,
        promptText: v.prompt_text,
        variationType: v.variation_type,
        brandMode: v.brand_mode,
        intentTags: v.intent_tags,
        intentPrimary: v.intent_primary,
        buyerJourneyTags: v.buyer_journey_tags,
        buyerJourneyPrimary: v.buyer_journey_primary,
        geography: cluster.geography_values[0] || null,
        discoveryMethod: 'system_discovery',
        evidence: cluster.evidence
      })
      variationRows.push(vRow)
    }

    // Best-effort system business-priority suggestion -- never blocks
    // candidate creation if this write fails for some reason; it's a
    // secondary annotation, not the core deliverable of this pass.
    let businessPriorityOutcome = null
    try {
      businessPriorityOutcome = await setTopicClusterBusinessPrioritySystem({ clusterId: clusterRow.id, priority: cluster.suggestedBusinessPriority })
    } catch (e) {
      businessPriorityOutcome = `error: ${e.message}`
    }

    created.push({ cluster: clusterRow, variations: variationRows, businessPriorityOutcome })
  }

  return {
    ok: true,
    dryRun: false,
    clientId,
    created,
    suppressedCandidates: suppressed,
    evidenceAvailable: { ahrefsConfigured: evidence.ahrefsConfigured, ahrefsKeywordCount: evidence.ahrefsKeywords.length, legacyTestPromptCount: evidence.legacyTestPrompts.length }
  }
}

// --- Legacy client.test_prompts migration -------------------------------

// looksBranded(promptText, clientName) -> true if the prompt text itself
// contains the client's own name -- a plain, literal-text heuristic (never
// an LLM guess) used ONLY to set brand_mode on migrated legacy prompts.
// Intent/buyer-journey are never inferred this way -- see
// migrateLegacyTestPrompts' header for why those stay null.
function looksBranded(promptText, clientName) {
  if (!clientName) return false
  const norm = s => (s || '').toString().trim().toLowerCase()
  return norm(promptText).includes(norm(clientName))
}

// migrateLegacyTestPrompts(clientId) -> { ok, migrated, ... }
//
// Preserves clients.test_prompts (Phase 1's confirmed 3-7 term set, still
// live and still used by trackAiVisibility.js -- untouched by this
// migration) as ONE legacy candidate cluster, exactly as originally tested:
//   - discovery_method='legacy_migrated' on both the cluster and every
//     variation
//   - status='candidate' on both -- even though these terms were already
//     "confirmed" in the old system, Phase 2's own benchmark requires an
//     explicit AM approval pass before anything is a Phase-2 benchmark
//     item; see spec: "System may NOT silently add candidates into the
//     benchmark," which applies here too, not just to freshly-discovered
//     clusters.
//   - original wording preserved EXACTLY (no rephrasing, no cleanup)
//   - intent_tags/intent_primary/buyer_journey_tags/buyer_journey_primary
//     all left null/empty -- "do not fabricate topic histories for prompts
//     that were never previously cluster-classified."
//   - brand_mode set via the plain looksBranded() literal-text check above
//     (not fabricated business insight -- just "does this exact string
//     contain the client's own name")
//
// Idempotent: if a legacy-migrated cluster already exists for this client,
// this is a no-op (returns already_migrated:true) rather than creating
// duplicates on repeated calls.
async function migrateLegacyTestPrompts(clientId) {
  const supabase = getSupabaseServerClient()
  const { data: client, error } = await supabase.from('clients').select('id, name, test_prompts').eq('id', clientId).single()
  if (error) throw error

  const prompts = (client.test_prompts || []).filter(p => p && p.trim())
  if (prompts.length === 0) {
    return { ok: true, migrated: false, reason: 'no_legacy_test_prompts', clientId }
  }

  const { getTopicClustersForClient } = require('./topicClusters')
  const existing = await getTopicClustersForClient(clientId)
  if (existing.some(c => c.discovery_method === 'legacy_migrated')) {
    return { ok: true, migrated: false, reason: 'already_migrated', clientId }
  }

  const clusterRow = await insertCandidateTopicCluster({
    clientId,
    name: 'Legacy Tested Terms (Unclassified)',
    primaryService: null,
    whyItMatters: 'Carried over from the AI-visibility test terms confirmed before Topic & Prompt Intelligence existed. Preserved exactly as originally tested -- not yet reviewed or classified into a real topic cluster.',
    geographyScope: null,
    geographyValues: [],
    evidence: [{ type: 'legacy_test_prompts', detail: `Migrated verbatim from clients.test_prompts (${prompts.length} term(s)).` }],
    discoveryMethod: 'legacy_migrated'
  })

  const variationRows = []
  for (let i = 0; i < prompts.length; i++) {
    const vRow = await insertCandidatePromptVariation({
      clientId,
      topicClusterId: clusterRow.id,
      promptText: prompts[i],
      variationType: i === 0 ? 'core' : 'secondary',
      brandMode: looksBranded(prompts[i], client.name) ? 'brand_aware' : 'unbranded',
      intentTags: [],
      intentPrimary: null,
      buyerJourneyTags: [],
      buyerJourneyPrimary: null,
      geography: null,
      discoveryMethod: 'legacy_migrated',
      evidence: [{ type: 'legacy_test_prompts', detail: 'Original wording preserved exactly.' }]
    })
    variationRows.push(vRow)
  }

  return { ok: true, migrated: true, clusterId: clusterRow.id, variationCount: variationRows.length, clientId }
}

module.exports = {
  TARGET_CLUSTER_COUNT_MIN,
  TARGET_CLUSTER_COUNT_MAX,
  MAX_SECONDARY_PER_CLUSTER,
  DISCOVERY_TOOL,
  gatherDiscoveryEvidence,
  computeDedupeKey,
  shouldSuppressCandidate,
  mostRecentProfileVerification,
  enforceCoreSecondaryConvention,
  suggestSystemBusinessPriority,
  buildDiscoverySystemPrompt,
  buildDiscoveryUserMessage,
  normalizeVariation,
  normalizeDiscoveryResult,
  discoverTopicClusters,
  looksBranded,
  migrateLegacyTestPrompts
}
