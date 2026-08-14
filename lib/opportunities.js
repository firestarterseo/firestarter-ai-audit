// Turns ephemeral per-audit-run findings (today: pillar_scores.issues/
// evidence JSON, recomputed fresh every run, nothing persists a single
// finding's identity across runs) into durable, individually-trackable
// rows in the `opportunities` table. Added 2026-08-15 as the first
// concrete step of the "audit -> execution" architecture in ROADMAP.md --
// the Opportunities table is the prerequisite the prioritized backlog,
// content-brief execution, Asana workflow, and closed-loop verification
// layers all depend on.
//
// v1 scope: wired to ONE source -- Competitive Position's missing-keyword
// opportunities (buildKeywordOpportunities in
// lib/checkers/competitive-position-checker.js). That's the single
// "close-the-gap"-shaped output already being computed (each item is
// literally a content-brief target) and it has a natural, stable
// fingerprint (the keyword text itself). Generalizing to other pillars'
// issues (schema fixes, technical fixes, entity-verification gaps) is a
// straightforward fast-follow once this pattern is proven -- those
// checkers don't yet emit a stable per-issue key, only free-text messages
// with embedded dynamic numbers, so they need a small update first (see
// ROADMAP.md's "Opportunities table" backlog entry).
//
// Fingerprint/status policy (deliberately conservative):
//   - New fingerprint this run -> insert, status 'open'.
//   - Existing fingerprint, status 'open'/'in_progress' -> refresh
//     detail/last_seen only, status untouched.
//   - Existing fingerprint, status 'dismissed' -> refresh detail/
//     last_seen only, status stays dismissed -- a strategist's "not worth
//     it" call shouldn't get silently overridden by the next audit run.
//   - Existing fingerprint, status 'done' -> refresh detail/last_seen
//     only, status stays done -- don't second-guess completed work
//     automatically just because the underlying keyword still shows up.
//   - Previously open/in_progress fingerprint NOT in this run's list ->
//     auto-closed: status 'done', closed_at now, detail gets a
//     resolved_reason -- the tool no longer detects this gap. This is
//     "verify, don't guess" applied to the tool's own recommendations,
//     not just the grades. Rows already dismissed/done are left alone
//     (already terminal) even if also absent this run.
//
// Callers MUST only invoke syncOpportunities for a (client, pillar, type)
// slice when this run's check actually executed -- passing an empty
// `items` array when the underlying data source failed or was skipped
// would incorrectly auto-close every open opportunity in that slice. See
// runAudit.js's use of competitivePositionResult._raw.keywordOpportunitiesChecked
// for how this is guarded for the keyword-opportunity source.

const { getSupabaseServerClient } = require('./supabaseServer')

// normalizeKeywordFingerprint(keyword) -> stable dedupe key for a
// content_brief opportunity sourced from a keyword-opportunity candidate.
// Same lowercase/trim normalization buildKeywordOpportunities itself
// already applies before comparing keyword text.
function normalizeKeywordFingerprint(keyword) {
  return `keyword:${String(keyword || '').toLowerCase().trim()}`
}

// keywordOpportunitiesToItems(keywordOpportunities) -> generic sync items
// shaped for syncOpportunities below. keywordOpportunities is
// competitive-position-checker.js's buildKeywordOpportunities output,
// Array<{ keyword, volume, competitorDomain, competitorPosition }>,
// OPTIONALLY already run through lib/serpLandscape.js's real-SERP
// annotation and/or lib/keywordRelevance.js's LLM refinement (added
// 2026-08-15) -- when present, the extra fields (relevanceReason/
// funnelStage/geoRecommendation/suggestedLocalVariant/serpLandscape/
// realisticTier/tierReason, plus the raw serpTopDomains evidence) ride
// along into `detail` so OpportunitiesManager.js can show them. Absent
// entirely when refinement didn't run or failed (llmRefined: false) --
// same graceful-degradation contract as the rest of this feature; the UI
// just shows less, never stale/wrong enrichment data.
function keywordOpportunitiesToItems(keywordOpportunities) {
  return (keywordOpportunities || []).map(o => ({
    fingerprint: normalizeKeywordFingerprint(o.keyword),
    title: o.keyword,
    detail: {
      keyword: o.keyword,
      volume: o.volume,
      competitorDomain: o.competitorDomain,
      competitorPosition: o.competitorPosition,
      ...(o.serpChecked ? { serpTopDomains: (o.serpTopDomains || []).slice(0, 5) } : {}),
      ...(o.llmRefined ? {
        relevanceReason: o.relevanceReason,
        funnelStage: o.funnelStage,
        geoRecommendation: o.geoRecommendation,
        suggestedLocalVariant: o.suggestedLocalVariant,
        serpLandscape: o.serpLandscape,
        realisticTier: o.realisticTier,
        tierReason: o.tierReason
      } : {})
    },
    priorityScore: typeof o.volume === 'number' ? o.volume : null
  }))
}

// syncOpportunities(opts) -> Promise<{ inserted, refreshed, autoClosed }>
//   opts.clientId, opts.auditRunId, opts.pillar, opts.type: identify which
//     slice of opportunities this call owns -- ONLY rows matching this
//     exact (client_id, pillar, type) are candidates for refresh/auto-close,
//     so syncing one slice never touches another's rows (e.g. a future
//     schema_fix sync won't reopen/close a content_brief row).
//   opts.items: Array<{ fingerprint, title, detail, priorityScore }> --
//     the FULL current-run list for this slice. Anything previously open/
//     in_progress for this slice and NOT present here gets auto-closed.
// Throws on a real Supabase error (matching this project's convention of
// letting real errors surface rather than swallowing them) -- callers
// should wrap in .catch() since this is a non-essential side effect of an
// otherwise-successful audit run, same convention as
// fetchMissingKeywordOpportunities itself.
async function syncOpportunities({ clientId, auditRunId, pillar, type, items }) {
  const supabase = getSupabaseServerClient()
  const now = new Date().toISOString()

  const { data: existingRows, error: existingError } = await supabase
    .from('opportunities')
    .select('id, fingerprint, status, detail')
    .eq('client_id', clientId)
    .eq('pillar', pillar)
    .eq('type', type)
  if (existingError) throw existingError

  const existingByFingerprint = new Map((existingRows || []).map(r => [r.fingerprint, r]))
  const currentFingerprints = new Set((items || []).map(i => i.fingerprint))

  let inserted = 0
  let refreshed = 0

  for (const item of (items || [])) {
    const existing = existingByFingerprint.get(item.fingerprint)
    if (!existing) {
      const { error } = await supabase.from('opportunities').insert({
        client_id: clientId,
        pillar,
        type,
        fingerprint: item.fingerprint,
        title: item.title,
        detail: item.detail || {},
        priority_score: typeof item.priorityScore === 'number' ? item.priorityScore : null,
        status: 'open',
        first_seen_audit_run_id: auditRunId,
        last_seen_audit_run_id: auditRunId,
        updated_at: now
      })
      if (error) throw error
      inserted++
      continue
    }

    // Status is deliberately NOT touched here regardless of its current
    // value (open/in_progress/dismissed/done) -- see this file's header.
    // Only refresh the data that can legitimately change run to run
    // (volume, competitor position, priority) plus last_seen.
    const { error } = await supabase
      .from('opportunities')
      .update({
        title: item.title,
        detail: item.detail || {},
        priority_score: typeof item.priorityScore === 'number' ? item.priorityScore : null,
        last_seen_audit_run_id: auditRunId,
        updated_at: now
      })
      .eq('id', existing.id)
    if (error) throw error
    refreshed++
  }

  // Auto-close: only rows that were open/in_progress AND not resurfaced
  // this run. Already-dismissed/done rows are terminal and left alone
  // even if also absent this run -- no need to "re-close" something
  // already closed.
  const toAutoClose = (existingRows || []).filter(r =>
    (r.status === 'open' || r.status === 'in_progress') && !currentFingerprints.has(r.fingerprint)
  )
  let autoClosed = 0
  for (const row of toAutoClose) {
    const { error } = await supabase
      .from('opportunities')
      .update({
        status: 'done',
        closed_at: now,
        updated_at: now,
        detail: { ...(row.detail || {}), resolved_reason: 'no_longer_detected' }
      })
      .eq('id', row.id)
    if (error) throw error
    autoClosed++
  }

  return { inserted, refreshed, autoClosed }
}

module.exports = { syncOpportunities, keywordOpportunitiesToItems, normalizeKeywordFingerprint }
