// Phase 1b -- Client / Industry Intelligence.
//
// Automatic-first classification of the 8 approved Client/Industry
// Intelligence fields (see lib/clientProfileFields.js for the exact field
// list and the confirmable-field persistence infrastructure this module is
// built on top of -- Phase 1a). The normal AM experience this produces is
// "HERE'S WHAT WE DETECTED," never "PLEASE FILL OUT THIS CLIENT PROFILE":
// this module researches a client first, and an AM only steps in to
// confirm or correct by exception.
//
// REUSE, NOT REBUILD: this module deliberately does none of its own HTML
// fetching/parsing or business-type inference -- it composes the same
// real capabilities the audit pipeline already proved out:
//   - lib/checkers/business-profile.js's extractBusinessProfile /
//     extractTitleAndMeta / enrichProfileWithAhrefs (JSON-LD business-node
//     detection, title/meta scraping, Ahrefs enrichment)
//   - lib/checkers/lightweight-jsonld.js's parseJsonLd/typesOf/hasProp
//     (this module adds ONE small supplementary scan on top --
//     summarizeJsonLdSignals below -- for areaServed/description/multi-
//     address signals that business-profile.js doesn't already surface,
//     since those are specific to classification, not to prompt
//     generation)
//   - lib/checkers/ahrefs.js's getOrganicKeywords (used directly here,
//     not through topPromptCandidates, since classification wants the raw
//     volume/local/branded fields that topPromptCandidates strips out for
//     its own prompt-phrasing purpose)
//   - lib/llm/anthropic.js's callAnthropicTool (the existing forced-tool-
//     use pattern; classification is exactly one call, not one call per
//     field)
//
// EVIDENCE HIERARCHY (explicit ranking, per the approved spec -- note this
// is NOT the same ranking business-profile.js's own generatePromptCandidates
// uses internally for prompt phrasing; that one ranks Ahrefs above title/
// meta because a validated ranking keyword is a better SEARCH PROMPT than
// scraped copy. Classification is a different question -- "what kind of
// business is this" -- where a structured, machine-declared type
// (JSON-LD @type / address / areaServed) is more direct evidence than
// prose the business wrote about itself, which is in turn more direct than
// a pattern inferred from keywords it happens to rank for):
//   1. Explicit structured business type / address / areaServed (JSON-LD)
//   2. Clear page copy (title, meta description, on-page business-node
//      description)
//   3. Ahrefs organic keyword patterns (real, ranking-validated, but only
//      an indirect signal of what the business actually is)
//   4. LLM interpretation of ambiguous copy -- last resort, and the LLM is
//      told explicitly that it may not invent facts beyond what's in 1-3.
//
// "The LLM may synthesize evidence. The LLM must NOT become the evidence
// itself." -- every field the LLM returns must cite which of the above it
// drew from; confidence reflects the quality of that citation, not the
// model's self-reported confidence.
//
// WRITE PATH: every persisted value goes through Phase 1a's
// writeSystemDetectedField (lib/clientProfileFields.js), which is the ONLY
// path automated classification may use to write. This module never
// touches client_profile_fields directly -- see persistField() below.

const { parseJsonLd, typesOf, hasProp } = require('./checkers/lightweight-jsonld')
const { extractBusinessProfile, extractTitleAndMeta } = require('./checkers/business-profile')
const { getOrganicKeywords } = require('./checkers/ahrefs')
const { callAnthropicTool } = require('./llm/anthropic')
const { getSupabaseServerClient } = require('./supabaseServer')
const {
  FIELD_KEYS,
  CONFIDENCE_VALUES,
  getClientProfileFields,
  getOpenClientProfileRecommendations,
  writeSystemDetectedField
} = require('./clientProfileFields')

// Scalar fields always live at item_index 0. List fields can have 0..N
// rows, each with its own value/confidence/evidence/confirmation_status --
// see clientProfileFields.js's header for why the table is already
// row-per-item, not row-per-field (this is what lets a multi-location
// client's 3 markets, or a 2-service business's secondary services,
// persist independently without a schema change).
const SCALAR_FIELD_KEYS = ['business_model', 'industry', 'vertical_subindustry', 'specialty', 'primary_customer_use_case']
const LIST_FIELD_KEYS = ['primary_products_services', 'secondary_products_services', 'primary_geography_markets']

// Sanity check that the two lists above exactly cover FIELD_KEYS -- fails
// loudly at require-time (not silently at classify-time) if this file and
// clientProfileFields.js's FIELD_KEYS ever drift apart.
;(function assertFieldCoverage() {
  const covered = new Set([...SCALAR_FIELD_KEYS, ...LIST_FIELD_KEYS])
  const missing = FIELD_KEYS.filter(k => !covered.has(k))
  const extra = [...covered].filter(k => !FIELD_KEYS.includes(k))
  if (missing.length || extra.length) {
    throw new Error(`clientIndustryIntelligence.js field lists are out of sync with clientProfileFields.FIELD_KEYS (missing: ${missing.join(',') || 'none'}; extra: ${extra.join(',') || 'none'})`)
  }
})()

// fetchHomepageHtml(url) -- intentionally a trivial, standalone duplicate
// of runAudit.js's own local (unexported) helper of the same name, not a
// reuse violation: this is boilerplate fetch/error-shape, not real
// extraction/research logic, and runAudit.js doesn't export it. Not
// touching runAudit.js keeps this phase's changes isolated from the audit
// pipeline, per the "do not modify unrelated pillars" instruction.
async function fetchHomepageHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'FirestarterAIAudit/1.0' } })
  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`)
  return res.text()
}

// summarizeJsonLdSignals(nodes) -> supplementary structured-data signals
// business-profile.js's extractBusinessProfile doesn't already surface:
// how many DISTINCT addresses appear across all business-type nodes (a
// real multi-location signal -- a single Organization node listing 3
// different LocalBusiness sub-nodes each with their own address is
// structural evidence of "Multi-location," not an inference), declared
// areaServed values (direct evidence for geography/markets and for a
// Service Area business model), and any on-page business-node
// description text (real copy the business used to describe itself in
// structured data, ranked above title/meta since it's explicitly
// machine-declared rather than scraped from arbitrary HTML).
function summarizeJsonLdSignals(nodes) {
  const explicitTypes = Array.from(new Set(nodes.flatMap(n => typesOf(n))))

  const addressStrings = nodes
    .filter(n => hasProp(n, 'address'))
    .map(n => {
      const a = n.address
      if (!a || typeof a !== 'object') return null
      return [a.addressLocality, a.addressRegion].filter(Boolean).join(', ') || null
    })
    .filter(Boolean)
  const distinctAddresses = Array.from(new Set(addressStrings))

  const areaServedValues = Array.from(new Set(
    nodes.flatMap(n => {
      const a = n.areaServed
      if (!a) return []
      const list = Array.isArray(a) ? a : [a]
      return list.map(x => (typeof x === 'string' ? x : x?.name)).filter(Boolean)
    })
  ))

  const descriptions = Array.from(new Set(
    nodes.map(n => (typeof n.description === 'string' ? n.description.trim() : null)).filter(Boolean)
  )).slice(0, 3)

  return {
    explicitTypes,
    distinctAddressCount: distinctAddresses.length,
    distinctAddresses: distinctAddresses.slice(0, 10),
    areaServedValues: areaServedValues.slice(0, 10),
    descriptions
  }
}

// gatherClientEvidence(client) -> bounded evidence bundle for exactly ONE
// classification pass. Call budget: at most one homepage fetch + one
// Ahrefs organic-keywords call -- no per-page crawling, no per-field calls.
// A failed evidence source degrades this bundle (fewer sourcesAvailable
// entries) but never throws -- classification can still proceed on
// whatever evidence IS available, per the "one evidence source failing
// should not block the whole pass" requirement.
async function gatherClientEvidence(client) {
  const evidence = {
    homepageFetched: false,
    homepageError: null,
    businessProfile: null,
    title: null,
    metaDescription: null,
    jsonLdSignals: null,
    ahrefsConfigured: !!process.env.AHREFS_API_KEY,
    ahrefsKeywords: [],
    sourcesAvailable: []
  }

  let html = null
  try {
    html = await fetchHomepageHtml(client.url)
    evidence.homepageFetched = true
    evidence.sourcesAvailable.push('homepage_html')
  } catch (e) {
    evidence.homepageError = e.message || String(e)
  }

  if (html) {
    const profile = extractBusinessProfile(html, client.url, {
      name: client.name,
      city: client.city,
      region: client.region,
      category: client.category
    })
    evidence.businessProfile = profile
    if (profile) evidence.sourcesAvailable.push('jsonld_business_node_or_client_fields')

    const { title, description } = extractTitleAndMeta(html)
    evidence.title = title
    evidence.metaDescription = description
    if (title || description) evidence.sourcesAvailable.push('page_title_meta')

    const { nodes } = parseJsonLd(html)
    const signals = summarizeJsonLdSignals(nodes)
    evidence.jsonLdSignals = signals
    if (signals.explicitTypes.length) evidence.sourcesAvailable.push('jsonld_explicit_types')
    if (signals.distinctAddressCount > 0) evidence.sourcesAvailable.push('jsonld_addresses')
    if (signals.areaServedValues.length) evidence.sourcesAvailable.push('jsonld_area_served')
  }

  const domainForAhrefs = client.domain || evidence.businessProfile?.domain
  if (domainForAhrefs && evidence.ahrefsConfigured) {
    // getOrganicKeywords never throws -- returns [] on any failure (no
    // rankings yet, bad key, network error). Used directly rather than
    // through business-profile.js's topPromptCandidates, since
    // classification needs the raw volume/local/branded fields that
    // helper strips for its own (different) prompt-phrasing purpose.
    const rows = await getOrganicKeywords(domainForAhrefs, { apiKey: process.env.AHREFS_API_KEY, limit: 25 })
    const unbranded = rows.filter(r => !r.branded).slice(0, 15)
    evidence.ahrefsKeywords = unbranded
    if (unbranded.length) evidence.sourcesAvailable.push('ahrefs_organic_keywords')
  }

  return evidence
}

const FIELD_DESCRIPTIONS = {
  business_model: 'Primary business model classification. Prefer one of: Local, Service Area, Multi-location, National, Online-Ecommerce. If the real evidence indicates a genuine hybrid (e.g. a primarily local business that also sells online), describe that plainly instead of forcing a single false-precise label -- do not guess if evidence does not support any of these.',
  industry: 'Broad industry classification (e.g. "Dental", "Legal Services", "Home Services", "E-commerce Retail").',
  vertical_subindustry: 'A more specific business category within the broad industry (e.g. "Orthodontics" within "Dental").',
  specialty: 'A specific specialty or niche within the vertical, ONLY if the evidence clearly supports one (e.g. "Invisalign / clear aligners"). Return null when no meaningful specialty is evidenced -- do not invent one.',
  primary_customer_use_case: 'What the primary customer is trying to accomplish when they seek this business out. Expected to be uncertain more often than the other fields -- return null rather than fabricate when evidence does not clearly support a specific use case.',
  primary_products_services: 'The business\'s primary products or services, as a list. Each item is independently evidenced -- do not pad the list to look complete.',
  secondary_products_services: 'Secondary/ancillary products or services, as a list. Return an empty list when the evidence does not clearly support any secondary offerings -- do not guess.',
  primary_geography_markets: 'The geographic markets served, as a list. A single local market, a service area, several named markets for a multi-location business, a national market, or (for a pure ecommerce business with no meaningful geography) an empty list -- do not force a geography that is not evidenced.'
}

function fieldSchema(description) {
  return {
    type: 'object',
    description,
    properties: {
      value: { type: ['string', 'null'], description: 'The classified value, or null if evidence does not support a defensible answer.' },
      confidence: { type: ['string', 'null'], enum: [...CONFIDENCE_VALUES, null], description: 'Must reflect the QUALITY of the underlying evidence (direct structured/explicit evidence vs. page copy vs. an inferred keyword pattern), not how confident you feel. Null only when value is null.' },
      evidence: { type: ['string', 'null'], description: 'The SPECIFIC evidence this value is drawn from (quote or closely paraphrase the actual JSON-LD field, page text, or keyword) -- not a restatement of the value itself. Null only when value is null.' }
    },
    required: ['value', 'confidence', 'evidence']
  }
}

function listFieldSchema(description) {
  return {
    type: 'array',
    description,
    items: fieldSchema('One item in this list.')
  }
}

const CLASSIFICATION_TOOL = {
  name: 'classify_client_industry_profile',
  description: 'Return a complete Client/Industry Intelligence classification for one business, using ONLY the evidence provided. Every field must be null (with null confidence/evidence) when the evidence does not defensibly support an answer -- do not fabricate values to fill out the profile.',
  input_schema: {
    type: 'object',
    properties: Object.fromEntries(
      [...SCALAR_FIELD_KEYS, ...LIST_FIELD_KEYS].map(key => [
        key,
        key === 'primary_products_services' || key === 'secondary_products_services' || key === 'primary_geography_markets'
          ? listFieldSchema(FIELD_DESCRIPTIONS[key])
          : fieldSchema(FIELD_DESCRIPTIONS[key])
      ])
    ),
    required: FIELD_KEYS
  }
}

function buildSystemPrompt() {
  return `You are classifying a real business's industry/profile for an internal SEO agency tool, using ONLY the evidence bundle provided in the user message -- you have no other knowledge of this specific business beyond what's given.

Evidence hierarchy -- prefer evidence in this order, and say so in each field's "evidence" text:
1. Explicit structured data (JSON-LD @type, address, areaServed) -- the business's own machine-declared facts. Most direct.
2. Clear page copy (title, meta description, on-page business description) -- real copy the business wrote about itself.
3. Ahrefs organic keyword patterns -- real search-ranking data, but only an INDIRECT signal of what the business actually is.
4. Your own interpretation of ambiguous copy -- last resort only, and only when 1-3 leave a reasonable inference available.

Rules:
- You MAY synthesize across these sources. You MUST NOT invent a fact that isn't traceable to one of them.
- confidence must reflect the evidence tier above, not how sure you personally feel: use "confirmed_by_direct_evidence" only when tier 1 (or unambiguous tier-2 statement) directly supports the value; "likely" for solid tier-2/tier-3 support; "uncertain" for thin or tier-4-only support.
- Every field may be null. Returning null is the CORRECT answer when the evidence doesn't defensibly support a value -- do not populate a field just to make the profile look complete.
- For list fields (primary_products_services, secondary_products_services, primary_geography_markets): only include items you can point to real evidence for. An empty list is a valid, honest answer.
- Do not force a single business_model label if the real evidence describes a genuine hybrid -- describe it plainly instead (e.g. "Multi-location + Online-Ecommerce").`
}

function buildUserMessage(client, evidence) {
  // A plain JSON string, matching this project's existing convention for
  // callAnthropicTool's `user` param (see lib/llm/anthropic.js's header) --
  // the model gets unambiguous structured input, not free text to guess at.
  return JSON.stringify({
    client: {
      name: client.name,
      url: client.url,
      city: client.city || null,
      region: client.region || null,
      legacyCategory: client.category || null
    },
    evidence: {
      sourcesAvailable: evidence.sourcesAvailable,
      businessProfile: evidence.businessProfile
        ? {
            categoryType: evidence.businessProfile.categoryType,
            category: evidence.businessProfile.category,
            city: evidence.businessProfile.city,
            region: evidence.businessProfile.region,
            domain: evidence.businessProfile.domain,
            titleTerms: evidence.businessProfile.titleTerms,
            metaPhrase: evidence.businessProfile.metaPhrase
          }
        : null,
      pageTitle: evidence.title,
      pageMetaDescription: evidence.metaDescription,
      jsonLdExplicitTypes: evidence.jsonLdSignals?.explicitTypes || [],
      jsonLdDistinctAddressCount: evidence.jsonLdSignals?.distinctAddressCount || 0,
      jsonLdDistinctAddresses: evidence.jsonLdSignals?.distinctAddresses || [],
      jsonLdAreaServed: evidence.jsonLdSignals?.areaServedValues || [],
      jsonLdDescriptions: evidence.jsonLdSignals?.descriptions || [],
      ahrefsOrganicKeywords: (evidence.ahrefsKeywords || []).map(k => ({ keyword: k.keyword, volume: k.volume, local: k.local }))
    }
  })
}

function normalizeFieldItem(raw) {
  if (!raw || raw.value == null || String(raw.value).trim() === '') return { value: null, confidence: null, evidence: null }
  const value = String(raw.value).trim()
  const confidence = CONFIDENCE_VALUES.includes(raw.confidence) ? raw.confidence : 'uncertain'
  const evidenceText = raw.evidence != null ? String(raw.evidence).trim() : null
  return { value, confidence, evidence: evidenceText || null }
}

function normalizeClassificationResult(rawResult) {
  const normalized = {}
  for (const key of SCALAR_FIELD_KEYS) {
    normalized[key] = normalizeFieldItem(rawResult?.[key])
  }
  for (const key of LIST_FIELD_KEYS) {
    const items = Array.isArray(rawResult?.[key]) ? rawResult[key] : []
    normalized[key] = items.map(normalizeFieldItem).filter(item => item.value != null)
  }
  return normalized
}

// STALE_ITEM_REMOVAL_SENTINEL -- Phase 1b completion fix (2026-08-17).
//
// The gap: a later classification pass returning FEWER list items than
// before (e.g. primary_geography_markets shrinking from [Denver, Aurora,
// Lakewood] to [Denver, Aurora]) left "Lakewood" in CURRENT profile state
// forever, because nothing ever cleared the live row -- Phase 1a's
// append-only HISTORY was being conflated with an append-only CURRENT
// STATE. Those are not the same thing: "history preserves it" must not
// mean "current state shows it forever."
//
// Fix is positional list reconciliation in persistClassification below:
// for each list field, item_index i is treated as the same "slot" across
// classification passes (matching Phase 1a's own row-per-item-index
// model -- there is no other stable identity for a list item in this
// schema, and inventing one would be over-engineering beyond what's
// needed here). A slot with no corresponding new item this pass is
// handled per Phase 1a's OWN pinning invariant, unchanged:
//   - UNCONFIRMED: safe to clear immediately -- calls the EXISTING
//     writeSystemDetectedField with value=null/confidence=null, which
//     fn_write_client_profile_field_system's "unconfirmed" branch already
//     handles correctly (no schema/RPC change needed for this path).
//   - CONFIRMED / OVERRIDDEN: must never be silently cleared. Writing this
//     sentinel string (never a real classification value) through the
//     EXISTING write path deliberately lands in the "confirmed/overridden
//     + value differs" conflict branch -- current value is left
//     completely untouched, and a normal Phase 1a reviewable
//     recommendation is created/refreshed, flagging "no longer detected"
//     instead of a real alternative value. An AM resolves it via the new
//     removeStaleClientProfileFieldItem (actually remove it, clearing to
//     null/unconfirmed -- see that function's header in
//     lib/clientProfileFields.js) or the EXISTING
//     dismissClientProfileRecommendation (keep it, ignore the suggestion).
const STALE_ITEM_REMOVAL_SENTINEL = '__phase1b_no_longer_detected__'

// isStaleRemovalRecommendation(recommendation) -- true when an open
// recommendation is this "no longer detected" flag rather than a normal
// new-value conflict. The UI (ClientIntelligenceCard) duplicates this
// exact sentinel string (see that file's own header note) since a Client
// Component cannot import this server-only module -- keep both in sync if
// this ever changes.
function isStaleRemovalRecommendation(recommendation) {
  return !!recommendation && recommendation.recommended_value === STALE_ITEM_REMOVAL_SENTINEL
}

// predictWriteOutcome(existingRow, item) -- mirrors
// fn_write_client_profile_field_system's branching WITHOUT touching the
// database, for dry-run validation (see classifyClientIndustryProfile's
// dryRun option). Kept in careful sync with that function's actual
// branches -- if the migration's logic ever changes, this prediction must
// change with it.
function predictWriteOutcome(existingRow, item) {
  if (!existingRow) return 'would_insert'
  const sameValue = existingRow.value === item.value && existingRow.confidence === item.confidence
  if (existingRow.confirmation_status === 'unconfirmed') {
    return sameValue ? 'would_be_unchanged' : 'would_update'
  }
  if (existingRow.confirmation_status === 'stale_recommendation_pending') {
    return 'would_refresh_open_recommendation'
  }
  // confirmed or overridden
  return existingRow.value === item.value ? 'would_reconfirm_no_conflict' : 'would_create_conflict_recommendation'
}

// predictRemovalOutcome(existingRow) -- the dry-run counterpart of the
// stale-item reconciliation path below: what WOULD happen to a slot that
// was previously populated but has no corresponding item in this pass.
function predictRemovalOutcome(existingRow) {
  if (!existingRow || existingRow.value == null) return 'would_stay_empty'
  if (existingRow.confirmation_status === 'unconfirmed') return 'would_remove_stale_unconfirmed'
  if (existingRow.confirmation_status === 'stale_recommendation_pending') return 'would_refresh_stale_removal_recommendation'
  // confirmed or overridden
  return 'would_flag_stale_removal_recommendation'
}

// persistClassification(client, normalizedFields, opts) -> writes[]
// Every non-null field/item is written through Phase 1a's
// writeSystemDetectedField -- the ONLY path automated classification may
// use. Null SCALAR fields are simply skipped (no row created), which is
// exactly how "no meaningful specialty exists" gets represented -- an
// absent slot, not a fabricated one. LIST fields additionally reconcile
// positionally against whatever was there before (see
// STALE_ITEM_REMOVAL_SENTINEL above) so a shrinking list doesn't leave
// stale items in current state forever. dryRun predicts every outcome via
// predictWriteOutcome/predictRemovalOutcome instead of calling the write
// RPCs, for safe pre-write validation against real clients.
async function persistClassification(client, normalizedFields, { dryRun = false } = {}) {
  const writes = []
  // Reconciliation always needs to know what currently exists (to detect
  // slots that disappeared), not just on dryRun -- unlike the original
  // Phase 1b implementation, which only fetched existing rows for dry-run
  // prediction.
  const existingRows = await getClientProfileFields(client.id)
  const existingBySlot = new Map(existingRows.map(r => [`${r.field_key}:${r.item_index}`, r]))

  async function persistOne(fieldKey, itemIndex, item) {
    if (item.value == null) return
    if (dryRun) {
      const existing = existingBySlot.get(`${fieldKey}:${itemIndex}`) || null
      writes.push({
        fieldKey,
        itemIndex,
        value: item.value,
        confidence: item.confidence,
        status: predictWriteOutcome(existing, item),
        dryRun: true
      })
      return
    }
    const status = await writeSystemDetectedField({
      clientId: client.id,
      fieldKey,
      itemIndex,
      value: item.value,
      confidence: item.confidence,
      evidence: item.evidence ? [{ text: item.evidence, source: 'llm_classification', collectedAt: new Date().toISOString() }] : []
    })
    writes.push({ fieldKey, itemIndex, value: item.value, confidence: item.confidence, status, dryRun: false })
  }

  // reconcileStaleSlot -- a list-field slot (item_index i) that was
  // previously populated but has no corresponding item in this pass. Never
  // called for scalar fields (scalars have no "shrinking list" concept --
  // a null scalar classification is simply skipped, unchanged from
  // before).
  async function reconcileStaleSlot(fieldKey, itemIndex, existing) {
    if (!existing || existing.value == null) return // already empty -- nothing to reconcile
    if (dryRun) {
      writes.push({ fieldKey, itemIndex, value: null, status: predictRemovalOutcome(existing), dryRun: true, reconciliation: true })
      return
    }
    if (existing.confirmation_status === 'unconfirmed') {
      // Safe to clear immediately -- see STALE_ITEM_REMOVAL_SENTINEL's
      // header. Uses the plain existing write path with a null value, NOT
      // the sentinel (the sentinel is only for confirmed/overridden items,
      // where a real, non-null value is required to route through the
      // conflict branch instead of silently overwriting).
      const rawStatus = await writeSystemDetectedField({ clientId: client.id, fieldKey, itemIndex, value: null, confidence: null, evidence: [] })
      writes.push({ fieldKey, itemIndex, value: null, status: 'removed_stale_unconfirmed', rawStatus, dryRun: false, reconciliation: true })
      return
    }
    // confirmed, overridden, or stale_recommendation_pending -- must never
    // be silently cleared. Flag it via the sentinel through the existing
    // write path, which correctly refuses to touch the current value.
    const rawStatus = await writeSystemDetectedField({
      clientId: client.id,
      fieldKey,
      itemIndex,
      value: STALE_ITEM_REMOVAL_SENTINEL,
      confidence: 'uncertain',
      evidence: [{ text: 'Not detected in the most recent classification pass.', source: 'llm_classification', collectedAt: new Date().toISOString() }]
    })
    const labelByRawStatus = {
      conflict_recommendation_created: 'stale_removal_recommendation_created',
      conflict_recommendation_updated: 'stale_removal_recommendation_updated',
      recommendation_refreshed: 'stale_removal_recommendation_refreshed'
    }
    writes.push({ fieldKey, itemIndex, value: existing.value, status: labelByRawStatus[rawStatus] || rawStatus, rawStatus, dryRun: false, reconciliation: true })
  }

  for (const fieldKey of SCALAR_FIELD_KEYS) {
    await persistOne(fieldKey, 0, normalizedFields[fieldKey])
  }
  for (const fieldKey of LIST_FIELD_KEYS) {
    const items = normalizedFields[fieldKey] || []
    const existingForField = existingRows.filter(r => r.field_key === fieldKey)
    const maxSlot = Math.max(items.length, existingForField.length)
    for (let i = 0; i < maxSlot; i++) {
      if (i < items.length) {
        await persistOne(fieldKey, i, items[i])
      } else {
        const existing = existingBySlot.get(`${fieldKey}:${i}`) || null
        await reconcileStaleSlot(fieldKey, i, existing)
      }
    }
  }
  return writes
}

// classifyClientIndustryProfile(client, opts) -> classification result.
// Takes a full client row (matching this project's existing orchestrator
// convention -- see runAudit(client, opts) -- rather than a bare id), so
// batch callers (listClientsNeedingClassification below) can pass rows
// straight through with no extra fetch. Safe to call independently per
// client: bounded external calls (at most 1 homepage fetch + 1 Ahrefs call
// + 1 Anthropic call), never throws (a failure returns an honest {ok:
// false} result instead), and idempotent/retry-safe (re-running against
// the same evidence either changes nothing, updates still-unconfirmed
// values, or raises a Phase 1a conflict recommendation -- never silently
// clobbers a confirmed/overridden value).
async function classifyClientIndustryProfile(client, { dryRun = false } = {}) {
  if (!client || !client.id || !client.url) {
    return { ok: false, clientId: client?.id || null, error: { status: null, message: 'A client with id and url is required.' }, evidenceAvailable: [], writes: [], dryRun }
  }

  const evidence = await gatherClientEvidence(client)

  const { result, error } = await callAnthropicTool({
    system: buildSystemPrompt(),
    user: buildUserMessage(client, evidence),
    tool: CLASSIFICATION_TOOL,
    apiKey: process.env.ANTHROPIC_API_KEY
  })

  if (error || !result) {
    // Honest failure: no writes attempted, nothing existing touched, no
    // partial/misleading classification presented as complete.
    return {
      ok: false,
      clientId: client.id,
      error: error || { status: null, message: 'No classification result returned.' },
      evidenceAvailable: evidence.sourcesAvailable,
      homepageError: evidence.homepageError,
      writes: [],
      dryRun
    }
  }

  const normalized = normalizeClassificationResult(result)
  const writes = await persistClassification(client, normalized, { dryRun })

  return {
    ok: true,
    clientId: client.id,
    evidenceAvailable: evidence.sourcesAvailable,
    homepageError: evidence.homepageError,
    ahrefsConfigured: evidence.ahrefsConfigured,
    classification: normalized,
    writes,
    dryRun
  }
}

function toFieldShape(row) {
  if (!row) return null
  return {
    value: row.value,
    confidence: row.confidence,
    evidence: row.evidence,
    confirmationStatus: row.confirmation_status,
    lastVerifiedAt: row.last_verified_at
  }
}

function buildSummaryChip({ industry, verticalSubindustry, specialty, businessModel, primaryGeographyMarkets, client }) {
  const geo = (primaryGeographyMarkets && primaryGeographyMarkets[0] && primaryGeographyMarkets[0].value)
    || [client?.city, client?.region].filter(Boolean).join(', ')
    || null
  const parts = [geo, industry?.value, verticalSubindustry?.value, specialty?.value, businessModel?.value].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

// getClientIndustryProfile(clientId) -- the canonical READ interface other
// pillars/UI will use. Handles every combination the spec calls out: no
// profile yet, partially classified, uncertain fields, null fields, a mix
// of confirmed/unconfirmed fields, multi-value services/geographies,
// pending recommendations, and legacy clients.
//
// clients.category is exposed as `legacyCategory` unconditionally, AND
// (only when there is no real `industry` profile row yet) surfaced as a
// fallback `industry` value -- but tagged with
// confirmationStatus: 'legacy_unconfirmed_category' and
// isLegacyCategoryFallback: true, a status string that does not exist in
// Phase 1a's confirmation_status enum and is never persisted anywhere --
// it exists purely so callers of this read-model can never mistake a
// legacy category guess for an AM-confirmed new-profile value.
async function getClientIndustryProfile(clientId) {
  const supabase = getSupabaseServerClient()
  const { data: client, error: clientError } = await supabase
    .from('clients')
    .select('id, name, city, region, category')
    .eq('id', clientId)
    .single()
  if (clientError) throw clientError

  const rows = await getClientProfileFields(clientId)
  const recommendations = await getOpenClientProfileRecommendations(clientId)

  const byField = new Map()
  for (const row of rows) {
    if (!byField.has(row.field_key)) byField.set(row.field_key, [])
    byField.get(row.field_key).push(row)
  }

  const scalarField = key => {
    const list = byField.get(key) || []
    const row = list.find(r => r.item_index === 0) || null
    return toFieldShape(row)
  }
  // A row with value=null is a reserved-but-empty slot -- either never
  // populated, or reconciled away by persistClassification's stale-item
  // handling (see STALE_ITEM_REMOVAL_SENTINEL's header) after a later
  // classification pass stopped detecting it. Either way it must not
  // render as a current list item -- "history preserves it, current state
  // does not." The row itself (and its full history) still exists; this
  // filter only affects this READ projection.
  const listField = key => (byField.get(key) || [])
    .filter(r => r.value != null)
    .slice()
    .sort((a, b) => a.item_index - b.item_index)
    .map(r => ({ itemIndex: r.item_index, ...toFieldShape(r) }))

  const businessModel = scalarField('business_model')
  const verticalSubindustry = scalarField('vertical_subindustry')
  const specialty = scalarField('specialty')
  const primaryCustomerUseCase = scalarField('primary_customer_use_case')
  const primaryProductsServices = listField('primary_products_services')
  const secondaryProductsServices = listField('secondary_products_services')
  const primaryGeographyMarkets = listField('primary_geography_markets')

  const industryRow = scalarField('industry')
  const industry = industryRow || (client.category
    ? {
        value: client.category,
        confidence: null,
        evidence: [],
        confirmationStatus: 'legacy_unconfirmed_category',
        lastVerifiedAt: null,
        isLegacyCategoryFallback: true
      }
    : null)

  const hasAnyProfileData = rows.some(r => r.value != null)

  return {
    clientId,
    hasAnyProfileData,
    businessModel,
    industry,
    verticalSubindustry,
    specialty,
    primaryProductsServices,
    secondaryProductsServices,
    primaryCustomerUseCase,
    primaryGeographyMarkets,
    openRecommendations: recommendations,
    legacyCategory: client.category ?? null,
    summary: buildSummaryChip({ industry, verticalSubindustry, specialty, businessModel, primaryGeographyMarkets, client })
  }
}

// listClientsNeedingClassification() -> client rows with zero
// client_profile_fields rows yet. A discovery helper only -- deliberately
// NOT a batch runner. A future admin entry point or (once the cron
// execution model is verified) a scheduled job can iterate this list and
// call classifyClientIndustryProfile(client) once per client; this phase
// stops at making that safe and possible, per "do not build an unverified
// cron workload / elaborate queueing platform."
async function listClientsNeedingClassification() {
  const supabase = getSupabaseServerClient()
  const { data: clients, error } = await supabase.from('clients').select('*')
  if (error) throw error

  const { data: profiledRows, error: profiledError } = await supabase
    .from('client_profile_fields')
    .select('client_id')
  if (profiledError) throw profiledError

  const profiledClientIds = new Set((profiledRows || []).map(r => r.client_id))
  return (clients || []).filter(c => !profiledClientIds.has(c.id))
}

module.exports = {
  SCALAR_FIELD_KEYS,
  LIST_FIELD_KEYS,
  CLASSIFICATION_TOOL,
  gatherClientEvidence,
  summarizeJsonLdSignals,
  classifyClientIndustryProfile,
  getClientIndustryProfile,
  listClientsNeedingClassification,
  // Phase 1b completion fix (2026-08-17) -- multi-value list
  // reconciliation. STALE_ITEM_REMOVAL_SENTINEL/isStaleRemovalRecommendation
  // are also needed by the AM review UI (ClientIntelligenceCard.js
  // duplicates the sentinel string itself, since a Client Component can't
  // import this server-only module -- see that file's own note) and by
  // the profile-fields API route.
  STALE_ITEM_REMOVAL_SENTINEL,
  isStaleRemovalRecommendation,
  // exported for the test script only -- lets the write-path and
  // normalization logic be exercised directly without requiring a live
  // Anthropic call (ANTHROPIC_API_KEY is a Vercel-only env var, never
  // available to automated tests run outside the deployed app -- same
  // constraint Phase 1a's own test script documents for
  // SUPABASE_SERVICE_ROLE_KEY).
  normalizeClassificationResult,
  normalizeFieldItem,
  persistClassification,
  predictWriteOutcome,
  predictRemovalOutcome
}
