// Thin wrapper around Anthropic's Messages API for this project's OWN
// internal judgment/classification calls -- distinct from Cloro, which is
// a fixed gateway to the 4 consumer AI engines being TESTED (ChatGPT,
// Gemini, Google, Perplexity) for AI & GEO Visibility, not something this
// app can reuse to run its own prompts. Added 2026-08-15 for the keyword-
// opportunity relevance refinement (see ../keywordRelevance.js) -- kept
// generic/reusable since ROADMAP.md's architecture calls for more
// LLM-judgment steps later (content briefs, entity/citation
// classification).
//
// ANTHROPIC_API_KEY follows the same "server env var only, added directly
// in Vercel, never on disk" pattern as CLORO_API_KEY/AHREFS_API_KEY (see
// lib/supabaseServer.js's header for the canonical statement of this
// convention). Skyler chose Anthropic as the provider 2026-08-15.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
// Model is env-overridable on purpose -- Anthropic's fast/cheap model slug
// changes over time. Verified 2026-08-15 against
// https://platform.claude.com/docs/en/about-claude/models/overview --
// "claude-haiku-5" (the original guess) does NOT exist and caused every
// call to 404/model-not-found, silently degrading every keyword
// opportunity to unrefined pass-through (fail-safe working as designed,
// but meant refinement never actually ran). `claude-haiku-4-5` is a
// documented alias that resolves to a pinned snapshot
// (`claude-haiku-4-5-20251001`) and is safe to use directly. If calls
// start failing again with a model-not-found error, set ANTHROPIC_MODEL
// in Vercel rather than editing this file, after re-checking the docs
// link above for the current fast/cheap tier's exact slug.
const DEFAULT_MODEL = 'claude-haiku-4-5'

// callAnthropicTool(opts) -> Promise<{ result: object|null, error: null | { status, message } }>
//   opts.system: system prompt string
//   opts.user: user message string (this project always passes a JSON
//     string built by the caller, not free text, so the model gets
//     unambiguous structured input)
//   opts.tool: { name, description, input_schema } -- a single tool
//     definition; the call FORCES this tool via tool_choice so the
//     response is always structured JSON matching input_schema, never
//     free text to parse/hope about.
//   opts.apiKey, opts.model, opts.maxTokens
// Never throws -- same "never throws, return {value, error}" contract
// every other external-API wrapper in this project follows (see
// lib/checkers/ahrefs.js's header). Callers decide whether a failure here
// should fall back to unrefined/default behavior -- an LLM judgment layer
// hiccupping should never take down a deterministic audit run.
async function callAnthropicTool({ system, user, tool, apiKey, model, maxTokens = 4096 }) {
  if (!apiKey) return { result: null, error: { status: null, message: 'ANTHROPIC_API_KEY is not configured.' } }

  const resolvedModel = model || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION
      },
      body: JSON.stringify({
        model: resolvedModel,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name }
      })
    })

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      return { result: null, error: { status: res.status, message: bodyText.slice(0, 500) || res.statusText || 'no response body' } }
    }

    const data = await res.json()
    const toolUse = (Array.isArray(data.content) ? data.content : []).find(block => block.type === 'tool_use' && block.name === tool.name)
    if (!toolUse) {
      return { result: null, error: { status: null, message: 'No matching tool_use block in Anthropic response (model may have replied with text instead).' } }
    }
    return { result: toolUse.input, error: null }
  } catch (e) {
    return { result: null, error: { status: null, message: e.message || String(e) } }
  }
}

module.exports = { callAnthropicTool, DEFAULT_MODEL }
