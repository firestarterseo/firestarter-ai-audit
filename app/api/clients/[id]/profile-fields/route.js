const {
  confirmClientProfileField,
  overrideClientProfileField,
  acceptClientProfileRecommendation,
  dismissClientProfileRecommendation,
  removeStaleClientProfileFieldItem,
  getClientProfileFields
} = require('../../../../../lib/clientProfileFields')
const { getClientIndustryProfile } = require('../../../../../lib/clientIndustryIntelligence')

// A single action route for every Phase 1a state-transition the AM Review
// UI needs (Confirm Field, Edit/Override, Accept Recommendation, Dismiss
// Recommendation, Remove Stale Item, and Confirm All as a client-side loop
// over Confirm Field) -- one route/body-discriminator, same shape as this
// project's existing PATCH-with-multiple-fields convention (see
// competitors/route.js), rather than near-identical route files for each
// thin RPC wrapper.
//
// POST body: { action, fieldKey?, itemIndex?, value?, recommendationId? }
//   action: 'confirm' | 'override' | 'accept_recommendation' | 'dismiss_recommendation' | 'remove_stale_item'
//
// Every action delegates straight to lib/clientProfileFields.js's RPC
// wrappers -- this route does no branching/pinning logic of its own, same
// "server boundary lives in the DB function, not in route code" pattern
// Phase 1a established. 'remove_stale_item' (Phase 1b completion fix,
// 2026-08-17) resolves an open "no longer detected" list-item
// recommendation by actually clearing the slot -- distinct from
// 'accept_recommendation', which would incorrectly set the current value
// to the internal removal sentinel rather than clearing it. See
// clientIndustryIntelligence.js's STALE_ITEM_REMOVAL_SENTINEL.
async function POST(request, { params }) {
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const { action } = body

  try {
    if (action === 'confirm') {
      if (!body.fieldKey) return Response.json({ error: 'fieldKey is required.' }, { status: 400 })
      await confirmClientProfileField({ clientId: id, fieldKey: body.fieldKey, itemIndex: body.itemIndex ?? 0 })
    } else if (action === 'override') {
      if (!body.fieldKey) return Response.json({ error: 'fieldKey is required.' }, { status: 400 })
      if (!body.value || !String(body.value).trim()) return Response.json({ error: 'value is required.' }, { status: 400 })
      await overrideClientProfileField({
        clientId: id,
        fieldKey: body.fieldKey,
        itemIndex: body.itemIndex ?? 0,
        value: String(body.value).trim(),
        evidence: [{ text: 'Manually entered by an AM.', source: 'am_override', collectedAt: new Date().toISOString() }]
      })
    } else if (action === 'accept_recommendation') {
      if (!body.recommendationId) return Response.json({ error: 'recommendationId is required.' }, { status: 400 })
      await acceptClientProfileRecommendation({ recommendationId: body.recommendationId })
    } else if (action === 'dismiss_recommendation') {
      if (!body.recommendationId) return Response.json({ error: 'recommendationId is required.' }, { status: 400 })
      await dismissClientProfileRecommendation({ recommendationId: body.recommendationId })
    } else if (action === 'remove_stale_item') {
      if (!body.recommendationId) return Response.json({ error: 'recommendationId is required.' }, { status: 400 })
      await removeStaleClientProfileFieldItem({ recommendationId: body.recommendationId })
    } else {
      return Response.json({ error: `Unknown action "${action}".` }, { status: 400 })
    }

    const profile = await getClientIndustryProfile(id)
    return Response.json({ profile })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}

// GET -> the raw field rows (used by "Confirm All" client-side to know
// which slots are currently unconfirmed-with-a-value, without duplicating
// that grouping logic in the client component).
async function GET(request, { params }) {
  const { id } = await params
  try {
    const rows = await getClientProfileFields(id)
    return Response.json({ fields: rows })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}

module.exports = { POST, GET }
