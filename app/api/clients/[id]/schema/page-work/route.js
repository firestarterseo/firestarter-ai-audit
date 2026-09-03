const { getPageWorkForClient } = require('../../../../../../lib/schemaPageWork')

// GET -> every durable schema_page_work row for this client, read-only.
// Phase 5 (2026-09) hydration endpoint -- exists so SchemaWizard.js can
// restore queue/analysis/final-status/opportunity-linkage state on load
// (and after a refresh) WITHOUT re-fetching the client's live site or
// re-deriving anything -- this is a plain read of already-durable state.
//
// Deliberately returns ONLY the fields SchemaWizard.js's hydration merge
// effect actually needs (Section 8) -- never the full row, so this
// endpoint can never become an accidental second place that leaks
// Phase-3-only fields (there are none on this table, but the shape here
// is the contract, not "whatever the table happens to have").
//
// No path/page parameter -- this is a whole-client bulk read, called once
// per SchemaWizard.js mount (see that file's hydration useEffect).
async function GET(request, { params }) {
  const { id } = await params
  try {
    const rows = await getPageWorkForClient(id)
    const pages = rows.map((row) => ({
      normalizedPath: row.normalized_path,
      pageUrl: row.page_url,
      classification: row.classification,
      targetProfile: row.target_profile,
      queueStatus: row.queue_status,
      analysisStatus: row.analysis_status,
      analyzedAt: row.analyzed_at,
      finalStatus: row.final_status,
      latestAnalysis: row.latest_analysis,
      opportunityId: row.opportunity_id
    }))
    return Response.json({ pages })
  } catch (e) {
    console.error('[schema/page-work] get failed:', e)
    return Response.json({
      error: 'Could not load durable Schema page-review state right now.',
      errorClass: 'persistence',
      phase: 'get_read',
      code: (e && typeof e.code === 'string') ? e.code : null
    }, { status: 500 })
  }
}

module.exports = { GET }
