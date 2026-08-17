const {
  approveTopicCluster,
  rejectTopicCluster,
  rejectPromptVariation,
  editTopicCluster,
  editPromptVariation,
  setTopicClusterBusinessPriorityAm,
  getTopicClustersWithVariations
} = require('../../../../../../lib/topicClusters')

// A single action route for every AM review state-transition, same
// one-route/body-discriminator shape as
// app/api/clients/[id]/profile-fields/route.js -- every action delegates
// straight to lib/topicClusters.js's RPC wrappers; this route does no
// branching/pinning logic of its own ("the server boundary lives in the
// DB function, not in route code," same pattern Phase 1a established).
//
// POST body: { action, clusterId?, variationId?, ... }
//   action: 'approve_cluster' | 'reject_cluster' | 'edit_cluster' |
//           'reject_variation' | 'edit_variation' |
//           'mark_strategic' | 'skip_business_priority'
async function POST(request, { params }) {
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const { action } = body

  try {
    if (action === 'approve_cluster') {
      if (!body.clusterId) return Response.json({ error: 'clusterId is required.' }, { status: 400 })
      await approveTopicCluster({ clusterId: body.clusterId })
    } else if (action === 'reject_cluster') {
      if (!body.clusterId) return Response.json({ error: 'clusterId is required.' }, { status: 400 })
      await rejectTopicCluster({ clusterId: body.clusterId, reason: body.reason || null })
    } else if (action === 'edit_cluster') {
      if (!body.clusterId) return Response.json({ error: 'clusterId is required.' }, { status: 400 })
      await editTopicCluster({
        clusterId: body.clusterId,
        name: body.name ?? null,
        whyItMatters: body.whyItMatters ?? null,
        geographyScope: body.geographyScope ?? null,
        geographyValues: body.geographyValues ?? null
      })
    } else if (action === 'reject_variation') {
      if (!body.variationId) return Response.json({ error: 'variationId is required.' }, { status: 400 })
      await rejectPromptVariation({ variationId: body.variationId, reason: body.reason || null })
    } else if (action === 'edit_variation') {
      if (!body.variationId) return Response.json({ error: 'variationId is required.' }, { status: 400 })
      // IMPORTANT: intentPrimary/buyerJourneyPrimary/geography are passed
      // through AS-IS (undefined when the request body omits them), NOT
      // coerced with `?? null` -- editPromptVariation distinguishes
      // "omitted" (leave unchanged) from "explicitly null" (clear the
      // field) for exactly these three fn_edit_prompt_variation params,
      // which the migration sets directly rather than coalescing. See that
      // function's header comment for the full explanation; coercing
      // omitted fields to null here would silently wipe them on every
      // prompt-text-only edit from the AM review UI.
      await editPromptVariation({
        variationId: body.variationId,
        promptText: body.promptText ?? null,
        brandMode: body.brandMode ?? null,
        intentTags: body.intentTags ?? null,
        intentPrimary: body.intentPrimary,
        buyerJourneyTags: body.buyerJourneyTags ?? null,
        buyerJourneyPrimary: body.buyerJourneyPrimary,
        geography: body.geography
      })
    } else if (action === 'mark_strategic') {
      if (!body.clusterId) return Response.json({ error: 'clusterId is required.' }, { status: 400 })
      await setTopicClusterBusinessPriorityAm({ clusterId: body.clusterId, priority: 'strategic' })
    } else if (action === 'skip_business_priority') {
      if (!body.clusterId) return Response.json({ error: 'clusterId is required.' }, { status: 400 })
      await setTopicClusterBusinessPriorityAm({ clusterId: body.clusterId, priority: 'none' })
    } else {
      return Response.json({ error: `Unknown action "${action}".` }, { status: 400 })
    }

    const clusters = await getTopicClustersWithVariations(id)
    return Response.json({ clusters })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}

module.exports = { POST }
