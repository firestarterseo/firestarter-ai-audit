// Content brief generator for a single Competitive Position keyword
// opportunity (see lib/opportunities.js / OpportunitiesManager.js). This is
// the first real piece of the mockup's "Brief & outline" step
// (workflow-mockup.html's #pane-comp) -- built for real 2026-08-16, per
// direct request to expand the Competitive Position workflow past
// "here's the gap" into "here's something to actually publish."
//
// Deliberately scoped smaller than the mockup: no WordPress draft-page
// creation. Skyler confirmed the WP-auto-publish half is the LESS
// important part right now -- copy/paste into a blog editor works fine --
// so this only ever generates a brief (title, angle, meta description, and
// real paste-ready section copy) and saves it to the opportunity row.
// Nothing here calls the WordPress REST API or creates a page anywhere.
//
// Uses the same Anthropic wrapper (lib/llm/anthropic.js) and
// ANTHROPIC_API_KEY already configured and paid for -- this is a second
// consumer of an existing, approved integration, not a new vendor decision.
//
// Persistence note: opportunities.detail gets overwritten wholesale on
// every audit-run sync (see lib/opportunities.js's syncOpportunities --
// it replaces `detail` with the checker's fresh output each run, by
// design, so a strategist's own edits never fight the next sync). A brief
// stored inside `detail` would silently get wiped the next time this
// client's audit runs. That's why this is its own column
// (opportunities.content_brief, added via migration) -- syncOpportunities
// never touches it, so a generated brief survives every future audit run
// until someone explicitly regenerates it.

const { callAnthropicTool } = require('./llm/anthropic')

const CONTENT_BRIEF_TOOL = {
  name: 'write_content_brief',
  description: 'Write a real, publish-ready content brief for a specific keyword opportunity: a page title, URL slug, meta description, the angle to take, and actual paste-ready draft copy broken into sections.',
  input_schema: {
    type: 'object',
    properties: {
      page_title: { type: 'string', description: 'The <title>/H1, written to actually target the keyword naturally.' },
      target_url_slug: { type: 'string', description: 'A realistic URL slug for this page, e.g. "local-seo-services" (no leading/trailing slashes).' },
      meta_description: { type: 'string', description: 'A real meta description, under 160 characters, written to earn the click.' },
      angle: { type: 'string', description: '2-3 sentences: what makes this page worth publishing given this client\'s actual situation (their real service area, category, and why a tracked competitor already ranks for this term) -- not generic SEO advice.' },
      sections: {
        type: 'array',
        description: 'The actual page, broken into sections in reading order. Write real, substantive draft copy for each section (not placeholder text) -- specific enough that a strategist could copy/paste this straight into a blog editor and only need light editing, not a rewrite.',
        items: {
          type: 'object',
          properties: {
            heading_level: { type: 'string', enum: ['H1', 'H2', 'H3'] },
            heading: { type: 'string' },
            content_html: { type: 'string', description: 'The real draft copy for this section, as plain HTML using only <p>, <ul>, <li>, <strong>, <em> tags -- no <html>/<head>/<body> wrapper, ready to paste into a blog editor\'s HTML view.' }
          },
          required: ['heading_level', 'heading', 'content_html']
        }
      }
    },
    required: ['page_title', 'target_url_slug', 'meta_description', 'angle', 'sections']
  }
}

const SYSTEM_PROMPT = `You are a senior SEO content strategist writing a real, ready-to-publish content brief and first-draft copy for a specific client business, targeting one specific keyword opportunity a tracked competitor already ranks well for and this client doesn't rank for at all.

You will be given the client's real business context (name, domain, city/region, category) and the specific keyword opportunity (search volume, which competitor ranks for it and at what position), plus, when available, real evidence already computed by this project's own checkers: a realistic-tier judgment (near_term/aspirational/citation_target) with its reasoning, a funnel-stage classification, and the real live Google-SERP top domains for this exact keyword. Ground the brief in that real evidence when it's present -- e.g. if the tier reasoning already explains why this client can realistically compete, reflect that in the angle; if serp_top_domains shows large publishers dominating, the angle should acknowledge this is a longer-shot ranking play or note where a citation/mention would be the more realistic goal.

Write draft copy that is genuinely usable, not a generic template -- specific to this client's real city/region/category where that's known, specific about what makes their approach worth reading over the competitor's, and long enough to be substantive (aim for enough sections/copy that this reads as a real first draft of a page, not a two-paragraph stub). Never invent facts about the client that weren't given to you (specific credentials, client counts, awards, pricing) -- write around what's actually known instead of fabricating specifics.`

async function generateContentBrief(opportunity, clientContext, { apiKey } = {}) {
  const detail = opportunity?.detail || {}
  const candidatePayload = {
    keyword: opportunity?.title || detail.keyword,
    monthly_search_volume: detail.volume ?? null,
    competitor_domain: detail.competitorDomain ?? null,
    competitor_position: detail.competitorPosition ?? null,
    ...(detail.realisticTier ? { realistic_tier: detail.realisticTier, tier_reason: detail.tierReason || null } : {}),
    ...(detail.funnelStage ? { funnel_stage: detail.funnelStage } : {}),
    ...(detail.serpLandscape ? { serp_landscape: detail.serpLandscape } : {}),
    ...(Array.isArray(detail.serpTopDomains) && detail.serpTopDomains.length > 0 ? { serp_top_domains: detail.serpTopDomains } : {})
  }

  const userPayload = JSON.stringify({ client_context: clientContext, keyword_opportunity: candidatePayload }, null, 2)

  const { result, error } = await callAnthropicTool({
    system: SYSTEM_PROMPT,
    user: userPayload,
    tool: CONTENT_BRIEF_TOOL,
    apiKey,
    maxTokens: 4096
  })

  if (error || !result) {
    return { brief: null, error: error || { status: null, message: 'No brief returned.' } }
  }

  return { brief: result, error: null }
}

module.exports = { generateContentBrief, CONTENT_BRIEF_TOOL }
