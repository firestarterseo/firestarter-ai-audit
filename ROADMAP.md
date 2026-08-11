# Firestarter AI Audit — Purpose & Roadmap

_Last reviewed: 2026-08-11 (updated same day after the user shared the
original planning doc `aireadyroadmap 2.html` and the original 85-client
baseline spreadsheet `AI Audits 3.xlsx` -- this file now reconciles this
build against that original plan rather than existing independently of it.)_

## Where this came from

The old "Grader" (pre-dating this rebuild) graded all 85 of Firestarter's
tracked clients using an LLM given only 3-4 web searches to cover 5 pillars
-- no caching, genuinely noisy (the same site with zero changes scored 74
one run and 58 the next). `AI Audits 3.xlsx` is that old Grader's output:
one row per client (Client, URL, overall Grade/Score, a letter grade per
pillar, three free-text "Top Opportunities"). **These are the baseline
scores every client first saw** -- per the original plan, that first score
is permanent and every future real score has to be understood as a
comparison against it, not a silent replacement. Only 1 client
(Firestarter SEO itself, used for building/testing) exists in this tool's
database today -- none of the real 85 have been imported yet.

## What this tool is for

Firestarter is a Denver-based SEO agency. This is an internal tool with two
jobs:

1. **A sales tool for leads.** Paste in a prospect's URL and get a live,
   real (not guessed) read on where they stand -- including whether ChatGPT,
   Gemini, Google, and Perplexity actually mention them by name for the
   terms that matter. No mainstream SEO audit tool covers AI-answer
   visibility well yet, so this is a genuine differentiator in a pitch.
2. **An ops tool for paying ("tracked") clients.** A recurring weekly job
   builds real trend history instead of one-off snapshots, and produces an
   actual severity-tagged punch-list a strategist can work off of, not just
   a grade.

Everything here is built on a "verify, don't guess" philosophy: every check
either hits a real live endpoint (the site itself, Google PageSpeed
Insights, Ahrefs, or Cloro's AI-engine gateway) or is explicitly marked as
unverified/not-yet-graded. Nothing is ever faked to fill in a gap.

## The five pillars

| Pillar | Status | What it checks |
|---|---|---|
| Schema & Structure | **Built** | JSON-LD completeness -- business entity schema, sameAs, contact info, BreadcrumbList, required-property validity |
| Technical Foundation | **Built** | HTTPS/redirect, robots.txt + sitemap.xml, broken internal links, Core Web Vitals + Lighthouse category scores via PageSpeed Insights |
| AI & GEO Visibility | **Built** | Real prompts (Ahrefs organic keywords first, then page title/meta, then guessed) queried live against ChatGPT/Gemini/Google/Perplexity via Cloro; mention/citation/sentiment, weighted by engine importance |
| Content Authority | **Built** | Word count, content freshness, referring domains (Ahrefs backlinks-stats) |
| Competitive Position | **Not built** | Benchmark against named competitors -- blocked on a design decision, not a data source (see below) |

Supporting infrastructure already in place: Ahrefs API (organic-keywords +
backlinks-stats), PageSpeed Insights, Cloro (5→4 AI engines after dropping
Copilot), weekly recurring cron tracking, lead→tracked promotion, client
delete, severity-tagged issues with plain-English "why it matters," a
"verify these results" breakdown for AI visibility so a strategist can
manually spot-check any grade, and (2026-08-11) a **Schema Generator** --
builds real LocalBusiness/Organization/etc. JSON-LD from a client's own
business facts (address, phone, description, sameAs), previews the exact
grade that markup would earn before it ships, and outputs both a raw
`.json` file and a ready `<script>` snippet for manual delivery. Closes the
single most common gap in the old baseline spreadsheet (schema-related
recommendations on 83/85 clients) directly instead of just reporting it.
Deliberately does not generate FAQPage schema -- see "Notes from the
original plan" below.

## Backlog (not yet built, no date attached)

- **Import + re-baseline the real 85-client roster.** Per the original
  plan, this becomes possible "essentially for free -- no LLM cost, seconds
  per site" once the real checkers exist, which they now mostly do (4/5
  pillars). Right now only 1 client exists in this tool's database.
  Decision needed: where the OLD baseline grade/score (from `AI Audits
  3.xlsx`) gets stored so it stays visible for comparison -- likely a
  `baseline_grade`/`baseline_score`/`baseline_source` column on `clients`,
  clearly labeled as the old LLM-guessed score, never mixed into
  `audit_runs`/`pillar_scores` (which are reserved for this tool's own real,
  verified runs -- mixing in guessed historical data there would break the
  "verify, don't guess" principle every pillar was built on).
- **Competitive Position pillar.** The last of the five. Per the original
  plan this is specifically three things: (1) real keyword rank tracking
  against NAMED competitors (buildable now via Ahrefs organic-keywords for
  each competitor domain), (2) a live "best X in [city]" check -- largely
  overlaps what AI & GEO Visibility's `generatePrompts` already does, just
  needs to specifically watch for a named competitor showing up instead of
  the client, (3) Google Business Profile review/rating comparison -- a NEW
  data source, not yet integrated. Confirmed feasible: Places API (New)
  Place Details returns `rating`/`userRatingCount` for any public business
  via a plain API key (same model as PageSpeed Insights, no OAuth/ownership
  needed), but unlike PSI it requires billing enabled on the Google Cloud
  project and is billed per request (~$20/1,000 after a monthly free-call
  allowance under the Enterprise SKU, as of the March 2025 pricing
  restructure). Competitor identification: auto-derive from Ahrefs
  competing-domains + AI-visibility "cited instead" data, with a
  strategist able to review/override -- same pattern as the confirmed
  test-prompts set.
- **Public lead-capture pipeline.** Per the original plan this is more
  specific than "a form somewhere": it replaces the existing embed at
  firestarterseo.com/ai-search/ai-audit/, grades via this tool's shared
  core, then pushes the lead to **ActiveCampaign** and emails **Skyler +
  Kyle** -- notify-only, no separate leads database. Deliberately a
  different pipeline from the internal dashboard (which never touches
  ActiveCampaign) so a client re-checking their own score never re-enters
  the sales funnel.
- **Schema Generator WP plugin delivery path.** The generator core and the
  manual download/snippet path are **built** (2026-08-11) -- see below.
  Still outstanding: the WP plugin path (auto-install, renders sitewide,
  doubles as the Schema pillar's live verification source) and Article/
  BreadcrumbList generation, which need real per-page CMS context this
  tool doesn't have from a single fetched homepage. Also still open: an
  Asana task per manual-delivery client ("exact file, exact placement") --
  blocked on the same Asana workspace issue below.
- **Content & outreach pipeline.** Planned Phase 4 in the original doc --
  auto-researched blog topics/drafts and citation/PR outreach, handed to a
  human via Asana starting at "review, fact-check, and publish," not
  "write from scratch." Hard human-signoff requirement for compliance-
  sensitive verticals (tax, counseling) already called out in the original
  plan.
- **Export audit issues to Asana.** Push each Critical/Moderate/Minor
  finding as an individual Asana task into the matching client's project.
  Tabled 2026-08-11 -- the connected Asana workspace ("BeFound SEO",
  883369811385995) doesn't match Firestarter's own org, so this needs the
  Asana connector re-pointed at the right workspace before it's buildable.
  (The original plan's Phase 3b manual schema-delivery path also creates
  Asana tasks -- worth building both on the same Asana wiring once the
  workspace is sorted.)

## Notes from the original plan worth keeping in mind

- **Schema markup isn't directly read by LLMs as structured data** -- a
  real experiment in the original research showed ChatGPT/Perplexity
  tokenize JSON-LD as plain text. What actually helps AI visibility is
  clear, well-organized *visible* content; schema is a free, harmless
  companion to Google rich results, not the AI-visibility mechanism itself.
  Worth keeping report language honest about this rather than overstating
  what the Schema & Structure pillar buys a client on the AI side.
- **Google retired FAQ rich results in May 2026.** FAQPage schema is still
  valid but no longer produces the visual accordion. (Checked: this
  project's current Schema & Structure checker doesn't push FAQ schema as a
  recommendation, so no stale messaging exists here today -- just don't
  reintroduce it without the caveat.)
- **Named pilot accounts** for proving the full loop end-to-end before
  wider rollout: Denver Tax Advisor, Bird Golf, JDI Windows.
- **FAQPage schema is deliberately not auto-generated** (2026-08-11
  decision), even though it's the single most-recommended item in the old
  baseline spreadsheet (62/85 clients). Two reasons: it needs real per-page
  Q&A content, not just business facts, so it's a different (bigger)
  generator than the business-entity one; and same-day research found no
  confirmed AI-citation benefit for FAQ markup specifically -- a matched-
  control Ahrefs study (~1,885 pages, 30 days) found no significant
  ChatGPT/AI-Mode citation change from adding it, and Otterly.ai's parallel
  test found no AI platform could answer a question whose answer existed
  only in FAQ schema. Consistent with the plain-text-tokenization finding
  above -- it's not that FAQ schema is broken, it's that no schema type
  gets special AI treatment over the same content as visible text.
