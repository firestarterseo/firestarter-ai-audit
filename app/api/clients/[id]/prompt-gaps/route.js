const { getSupabaseServerClient } = require('../../../../../lib/supabaseServer')
const { getPromptCandidates, getPersistedPromptGapAnalyses, analyzePromptGap } = require('../../../../../lib/promptGapAnalysis')

// GET -> { candidates, analyses }. Pure reads, no live fetches, no cost --
// safe to call on every page render (see PromptGapAnalysisPanel.js).
async function GET(request, { params }) {
  const { id } = await params
  const supabase = getSupabaseServerClient()
  const { data: client, error: clientError } = await supabase.from('clients').select('id').eq('id', id).single()
  if (clientError || !client) {
    return Response.json({ error: clientError?.message || 'Client not found.' }, { status: 404 })
  }

  try {
    const [candidates, analyses] = await Promise.all([
      getPromptCandidates(id),
      getPersistedPromptGapAnalyses(id)
    ])
    return Response.json({ candidates, analyses })
  } catch (e) {
    return Response.json({ error: e.message || String(e) }, { status: 400 })
  }
}

// POST { promptText } -> runs one real, on-demand Prompt-Level Gap Analysis
// pass for a single tracked prompt and persists it. This is the ONLY place
// this can fire -- never from a page render, cron job, or batch loop (see
// lib/promptGapAnalysis.js's module header on cost discipline). One call can
// fire one live Cloro SERP lookup, up to two live page fetches, and two live
// Ahrefs calls.
async function POST(request, { params }) {
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const promptText = typeof body.promptText === 'string' ? body.promptText.trim() : ''
  if (!promptText) {
    return Response.json({ error: 'promptText is required.' }, { status: 400 })
  }

  const supabase = getSupabaseServerClient()
  const { data: client, error: clientError } = await supabase.from('clients').select('id').eq('id', id).single()
  if (clientError || !client) {
    return Response.json({ error: clientError?.message || 'Client not found.' }, { status: 404 })
  }

  try {
    const analysis = await analyzePromptGap(id, promptText, { actor: 'am_manual' })
    return Response.json({ analysis })
  } catch (e) {
    return Response.json({ error: e.message || String(e) }, { status: 400 })
  }
}

module.exports = { GET, POST }
