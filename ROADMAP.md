# Firestarter AI Audit — Purpose & Roadmap

_Last reviewed: 2026-08-13 (2026-08-11: reconciled against the original
planning doc `aireadyroadmap 2.html` and the original 85-client baseline
spreadsheet `AI Audits 3.xlsx`. 2026-08-12: WP plugin publish path built
and confirmed live on firestarterseo.com. 2026-08-13: Competitive
Position v1 built -- all five pillars now built; also reworked AI & GEO
Visibility's citation scoring from a binary self-citation flag to a
graduated tier that credits third-party mentions and best-list/authority-
domain citations more heavily than a plain self-referral.)_

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
| Competitive Position | **Built (v1)** | AI-citation head-to-head (60pts) vs auto-detected competitors + Ahrefs organic-keyword-count standing (40pts); GBP ratings comparison deferred (see below) |

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

## Target architecture: audit -> execution (proposed 2026-08-14)

Skyler's framing: if this were built from scratch today, knowing
everything logged in this doc (the pillar-architecture review, the
citation-source research, the DR findings), what would it look like end
to end -- not just a grader, a system that goes from diagnosis to actually
closing the gap and then proving it closed? Eight layers, most already
partially built. This section is the target shape; the concrete build
items are in the Backlog below (existing bullets are cross-referenced
rather than repeated).

1. **Client context profile.** `clients.category` already exists but is
   unused; add `service_area_type` and `ymyl_sensitive` (see the
   vertical/service-area-aware generalization bullet below) so every
   other layer can branch on real client context instead of assuming
   every client looks like Firestarter.
2. **Data collection (verified signals).** Keep everything already built
   (live AI-engine prompts, Ahrefs, PageSpeed, schema extraction) and add
   two feeds: platform-presence checks (claimed/complete listings on the
   review platforms and directories that matter per vertical) and
   brand-mention monitoring (linked + unlinked mentions, not just
   backlinks). One new feed needs zero new API cost:
   `ai_visibility_tracked_runs.raw` already stores every
   `thirdPartySourceUrls`/`sourceUrls` array from every AI-engine call
   ever made (204 rows as of 2026-08-14) -- this is the raw material for
   the Citation Source Gap feature below, already sitting there unmined.
3. **Scoring -- six pillars instead of five, kept rule-based on purpose.**
   The existing five, refined per the pillar-architecture review above,
   plus a new sixth pillar (see Backlog: "Entity & Citation Authority
   pillar"). Scoring stays formula-driven, never an LLM guessing a grade
   -- that principle doesn't change, it's what makes a grade defensible
   in front of a client.
4. **Opportunities become first-class, durable rows -- not JSON text.**
   Checked the live schema (2026-08-14): every issue/evidence/
   recommendation today lives inside `pillar_scores.issues` /
   `.evidence`, a jsonb blob attached to one audit run -- nothing
   persists an individual finding's identity across runs, so there's no
   way to mark a specific gap "in progress" or "closed" versus having it
   silently regenerate in next week's blob. See Backlog: "Opportunities
   table" -- this is the architectural linchpin that turns a report into
   a backlog.
5. **Prioritization -- one ranked backlog per client, not five separate
   pillar lists.** Once findings are rows, they can be ranked together
   (severity x estimated impact / effort) across all pillars at once. See
   Backlog: "Cross-pillar prioritized backlog."
6. **Execution -- turn a prioritized opportunity into the specific
   artifact that closes it.** Content briefs (see "close the gap"
   automation above), citation/directory-target checklists (see Citation
   Source Gap), one-click schema generation (already built for business-
   entity; needs a Person/author-credential variant per the pillar
   review).
7. **Workflow -- push to where it actually gets done.** Asana sync (see
   existing "Export audit issues to Asana" bullet -- same workspace
   blocker applies here), status flowing both directions so a task
   completed in Asana flips the opportunity row closed.
8. **Gated auto-execution, then closing the loop back to verification.**
   Schema auto-publish already works end-to-end; AI-drafted content
   staged to WordPress as a draft is the next tier, gated behind
   mandatory human review always (not just for `ymyl_sensitive` clients
   -- the generic-content risk applies everywhere). Most important layer:
   each opportunity row should carry a snapshot of the score component it
   ties to, and the next scheduled audit should automatically check
   whether that specific gap closed and surface a before/after -- turning
   the tool from "a new grade every week" into proof that a specific
   billed action moved a specific number. Ties into "verify, don't guess"
   more directly than anything else in this doc.

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
- **Google Places/GBP ratings comparison for Competitive Position.**
  Deferred from the pillar's v1 (built 2026-08-13, see the pillar table
  above and `lib/checkers/competitive-position-checker.js`'s header for
  the full locked-decisions writeup) pending the Places API application
  and Google Cloud billing being set up on Skyler's own project (he
  confirmed access to the project but hadn't submitted the GBP
  application as of 2026-08-13). Confirmed feasible whenever that's
  ready: Places API (New) Place Details returns `rating`/`userRatingCount`
  for any public business via a plain API key (same model as PageSpeed
  Insights, no OAuth/ownership needed), but unlike PSI it requires billing
  enabled and is billed per request (~$20/1,000 after a monthly free-call
  allowance under the Enterprise SKU, as of the March 2025 pricing
  restructure). The `client_competitors` table already has a reserved
  (currently unused) `google_place_id` column for this. What v1 actually
  shipped instead: an AI-citation head-to-head (60pts, reusing the same
  confirmed AI-visibility test prompts/tracked runs already collected for
  AI & GEO Visibility, no new Cloro cost) and an Ahrefs organic-keyword-
  count standing (40pts, reusing the single Ahrefs organic-competitors
  call already made during competitor auto-detection -- no second paid
  call). Competitors are auto-detected on every audit from AI-citation
  "cited instead" data and Ahrefs organic-competitors overlap
  (`lib/competitorDetection.js`), stored in their own `client_competitors`
  table, and grade as soon as 2+ are auto-detected -- manual confirmation
  was explicitly rejected as a grading gate ("I don't want this excluded.
  I want it to work") and is only ever optional polish (add/rename/
  deactivate via the Competitive Position tile's competitor manager).
- **Public lead-capture pipeline.** Per the original plan this is more
  specific than "a form somewhere": it replaces the existing embed at
  firestarterseo.com/ai-search/ai-audit/, grades via this tool's shared
  core, then pushes the lead to **ActiveCampaign** and emails **Skyler +
  Kyle** -- notify-only, no separate leads database. Deliberately a
  different pipeline from the internal dashboard (which never touches
  ActiveCampaign) so a client re-checking their own score never re-enters
  the sales funnel.
- **Schema Generator WP plugin delivery path.** The generator core, the
  manual download/snippet path, AND the WP plugin auto-publish path are all
  **built and verified live** (2026-08-12) -- a small companion plugin
  (wordpress-plugin/firestarter-ai-schema, installed once per client site)
  authenticated via WordPress's native Application Passwords, plus a
  one-click "Publish to WordPress" button in the tool. Confirmed working
  end-to-end on firestarterseo.com itself: connect -> publish -> live,
  valid LocalBusiness JSON-LD actually rendering in the page's <head>,
  verified via view-source. Two real bugs found and fixed during this test
  (v1.0.1): the plugin's status endpoint had no cache-control headers, so
  an intermediate cache could serve a stale "not published" response right
  after a real successful publish; and a timestamp bug showed "last
  updated" several hours off from "last published" (UTC vs. local-time
  parsing, not an actual data problem). Also doubles as the Schema pillar's
  live verification source per the original plan, via the plugin's public
  /status endpoint. Still outstanding: Article/BreadcrumbList generation,
  which needs real per-page CMS context this tool doesn't have from a
  single fetched homepage, and an Asana task per manual-delivery (non-WP)
  client -- blocked on the same Asana workspace issue below.
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
- **Competitive Position "close the gap" automation** (discussed
  2026-08-14, not yet built). Direct feedback: the pillar diagnoses gaps
  (keyword-count standing, missing-keyword opportunities) but stops at
  "here's the gap" -- nothing turns a finding into action. Skyler confirmed
  he wants a combination of the below, not just one -- "automate as much
  as possible" -- so this is a build order, not a scope cut. Sequenced by
  actual SEO impact per unit of effort (discussed and agreed 2026-08-14):
  1. **Structured keyword-opportunity UI -- BUILT 2026-08-15.** Pulled
     the existing `buildKeywordOpportunities` list out of buried evidence
     text into real per-client tracked rows (`opportunities` table +
     `OpportunitiesManager.js`) with Open/In progress/Done/Dismissed
     status, instead of one paragraph inside a collapsed "Raw technical
     details" panel. See "Opportunities table" below for the full build
     writeup -- this shipped as that table's first wired-up source.
  2. **AI-generated content briefs per keyword opportunity.** Agreed as
     the single most SEO-impactful step -- turns "target this keyword"
     into something a writer can actually execute (suggested title,
     H2/outline, target word count, the specific competitor angle it
     needs to beat). Directly attacks the diagnosed root cause (content
     depth/breadth), unlike the UI step above which only improves
     visibility of the diagnosis.
  3. **Push an opportunity straight to an Asana task.** Operational, not
     SEO-impactful by itself, but keeps a brief from dying in the
     dashboard. Same Asana-workspace blocker as "Export audit issues to
     Asana" above (BeFound SEO workspace mismatch) -- worth wiring once
     that's resolved, ideally on the same Asana plumbing as that item.
  4. **Auto-draft the page and stage it in WordPress** (reusing the
     `wpPublish.js` pipeline already built for schema). The furthest
     automation, deliberately sequenced last and gated behind mandatory
     human review: AI-drafted content that isn't meaningfully edited
     risks reading generic/interchangeable across an 85-client roster --
     exactly what helpful-content systems tend to discount. Treat as an
     accelerant once briefs are proven out, not a default action.
  - **Same pattern should extend to the referring-domain/backlink side**
    too -- the deferred "link prospects" feature (specific backlink-
    prospect domains that link to tracked competitors but not the client,
    from paginated Ahrefs backlink data -- a bigger lift than the keyword
    version since it needs per-domain backlink pagination). Agreed to run
    this as a parallel track once the content-brief workflow above is
    flowing, not blocking on it.
  - **The keyword-count sub-check's SCORE (not just the opportunity list)
    has the same scale-mismatch problem -- BUILT 2026-08-15.** Raised
    2026-08-14, reviewing a real run: Firestarter's own 89-vs-2538 ratio
    against thriveagency.com, a much larger national agency; confirmed as
    a live bug 2026-08-15 when the first real keyword-opportunity list
    came back almost entirely sourced from Thrive, including off-topic
    noise ("erp," "b2b") that a huge, differently-scaled competitor's
    keyword list is noisier on. Shipped: `getDomainMetrics`
    (`lib/checkers/ahrefs.js`) now also returns `domain_rating` (same call
    already made for `org_keywords`, zero extra Ahrefs cost -- not yet
    verified against a live response, flagged in that file's comments).
    New `selectScaleComparableCompetitors` in `lib/competitorDetection.js`
    ranks competitors by proximity to the client's OWN domain rating
    (closest first) instead of raw keyword count, with a documented
    fallback to the old behavior when the client's own domain rating is
    unavailable. Applied in TWO places: the keyword-count score now
    averages against the 5 closest-scale checked competitors
    (`MAX_SCALE_COMPARABLE_COMPETITORS`), not all 10; and
    `fetchMissingKeywordOpportunities` now picks its 3 diffing targets by
    scale proximity instead of "whoever has the most keywords" -- this is
    the part that was actually causing "almost all from Thrive," since
    picking the biggest competitor to diff against structurally
    guarantees its keywords dominate the result. Decision restated: don't
    make the 40-point
    ratio itself vertical/relevance-aware -- that trades the "verify,
    don't guess" objectivity this whole project is built on for something
    subjective and hard to defend. Instead fix the competitor SET feeding
    that ratio -- it currently averages against every auto-detected active
    competitor regardless of scale, so a client compared against a much
    bigger player gets a near-zero ratio that reflects a scale gap, not a
    genuinely closable content gap. Fix: scope the denominator to
    competitors within a reasonable `domain_rating` band of the client's
    own domain -- `domain_rating` is already fetched by
    `getOrganicCompetitors` in `lib/checkers/ahrefs.js`, so this needs no
    new API cost, just a filter applied before averaging. Deliberately do
    NOT apply this same filter to the AI-citation head-to-head (60pts)
    sub-check -- "an AI engine cited a bigger competitor instead of you"
    is a real, valid loss regardless of size gap, so that comparison
    should keep using the full auto-detected list as-is.
  - **Vertical/service-area-aware generalization, now grounded in the
    real roster** (2026-08-14: read `AI Audits.xlsx`, the actual
    85-client baseline spreadsheet referenced in "Import + re-baseline"
    above -- previously only discussed hypothetically). Confirms this
    isn't an edge case. The roster spans: hyperlocal single-location
    trades (A & M Window Service, Rocky Mountain Plumbing & Drains,
    Electric Doc, and most of the roster); hyperlocal businesses that are
    genuinely multi-location and need per-location treatment, not one
    city (Colorado Orthodontics -- 4 offices; Iowa Land Company -- 5
    offices; SeaGate Homes -- multiple FL counties); national/non-geo-
    bound B2B and product companies where a Denver-style local modifier
    would be actively wrong, not just unhelpful (Brycer's fire-protection-
    compliance SaaS niche; Q Nav; Tiara Yachts' dealer network;
    International Jet; MidAmerican Printing Systems); and a real cluster
    of YMYL/compliance-sensitive clients where the hard human-signoff
    requirement already called out for tax/counseling in the original
    plan has to extend further -- at least 3 law firms (Cambridge Law,
    Philip Goldberg PC, Underhill Law), several financial/wealth firms
    (Paragon Capital Management, High Pass Asset Management, RMP
    Accounting, Mountain Insurance), and a cluster of healthcare/mental-
    health/addiction-recovery clients (AMK Counseling, Foundations, Stout
    Street, Midwest Vascular, Center of Functional Medicine, BE
    Aesthetics, Garcia Weight Loss, Boulder Sports Clinic, Colorado
    Orthodontics). Confirms the service-area-type + YMYL-sensitivity
    client-level fields discussed 2026-08-14 are worth adding to the
    client model before the 85-client import, not after -- retrofitting
    them onto 85 already-imported rows is much more work than deriving
    them once during import.
  - **Cautionary precedent already sitting in the old baseline data.**
    `AI Audits.xlsx`'s "Top Opportunities 1" column recommends schema
    markup, in near-identical wording, on roughly 70 of the 85 rows
    regardless of industry -- a law firm, a yacht manufacturer, and a dog-
    training school all got essentially the same advice. That's the exact
    failure mode already described above in "Where this came from" (the
    old LLM-only Grader). The new Competitive Position keyword-
    opportunity/content-brief work must not recreate it in a new spot --
    a national head-term list ranked by raw volume with no vertical
    awareness would be the same mistake wearing a new module.

- **"Citation Source Gap" -- a new feature, arguably more mission-aligned
  than the keyword-count comparison** (proposed 2026-08-14, grounded in
  real 2026 research, not built). The core question Skyler raised: where
  do LLMs actually get their information (company sites/schema, Google
  Business Profile, Reddit/Quora, "top lists"), and how does this tool
  meaningfully move a client's real AI-mention rate, not just an Ahrefs
  keyword count? Pulled current research to answer that rather than
  guess:
  - **Domain authority (DR) is NOT a useful proxy for AI-citation
    likelihood.** Surfer's study of 5M AI citations across 20,000 prompts
    (AI Mode, Google AI Overviews, ChatGPT, Perplexity) found near-zero-
    to-slightly-negative correlation between domain authority metrics and
    citation frequency -- removing the top 5% strongest domains pushed
    correlation even closer to zero, suggesting AI engines don't simply
    favor big, powerful domains the way classic search ranking does.
    (https://surferseo.com/blog/domain-authority-impact-on-ai-citations/)
    This matters for scope: DR is still the right, objective signal for
    the keyword-count SCORE fix above (comparing content depth against
    scale-appropriate peers is a legitimate, verifiable SEO comparison) --
    but it should NOT be used as a stand-in for "will this business get
    cited by ChatGPT." Different question, different signal.
  - **Off-page, third-party sources dominate AI citations -- a client's
    own website is a minority driver.** Per Search Engine Journal, owned
    content accounts for only ~23% of AI Overview citations; the other
    ~77% comes from off-page sources, with Reddit alone at ~21% of local-
    query citations.
    (https://www.searchenginejournal.com/ai-overviews-now-answer-most-local-searches-how-to-get-your-business-cited/580757/)
    A 2026 cross-study aggregate (Peec AI 30M sources + SEMrush 325K
    prompts + Profound 1.4M citations + SE Ranking 129K domains, via
    Contently) ranks Reddit as the single most-cited domain across major
    AI engines (~20% of Perplexity citations), with Quora showing a "4.1x
    ChatGPT citation multiplier" versus other community platforms, review
    platforms (G2/Capterra/Trustpilot/Yelp) generating 4.6-6.3 citations
    for present brands vs. 1.8 for absent ones, and YouTube showing the
    strongest single correlation with AI visibility (0.737 in an Ahrefs
    study). (https://contently.com/2026/04/29/top-sources-llms-cite/)
    Google Business Profile itself is a smaller lever than assumed --
    AI Overviews pull from a much more diverse source mix than the old
    local-pack model, so GBP completeness alone won't move the needle
    much on its own.
  - **What this means for the tool.** The AI & GEO Visibility checker
    already captures exactly this kind of evidence for every tracked run
    (`raw.thirdPartySourceUrls`/`raw.sourceUrls` in
    `ai-visibility-checker.js` / used by competitive-position-checker.js's
    head-to-head sub-check) -- no new API cost to start mining it more
    aggressively. Proposed feature: aggregate every observed third-party
    citation domain across a client's (and its tracked competitors')
    AI-visibility runs, bucket by type (Reddit thread, Quora thread,
    YouTube, review platform, industry directory/"best of" list, editorial/
    PR, GBP/Maps, other), and surface it as a specific, prioritized gap
    list -- "competitors get cited via r/[subreddit] and G2 for this kind
    of query; you have zero presence on either" -- same shape as the
    keyword-opportunity and (deferred) link-prospects features, but for
    citation surfaces specifically, and closer to the tool's actual stated
    mission than an Ahrefs total-keyword-count ratio is. The old baseline
    spreadsheet's free-text "Top Opportunities" already hand-identified
    good vertical-specific seed lists worth reusing here (Justia/Super
    Lawyers for law, Clutch/G2/UpCity for B2B IT, Healthline/Examine.com
    for health/supplements, Angi/HomeGuide/Thumbtack for home services,
    recovery.com/SAMHSA for addiction treatment, WeddingWire/TheKnot for
    weddings) -- validates that those old, LLM-guessed recommendations
    were directionally right even though the old Grader's overall
    scoring was noisy.
  - Reframes urgency on the deferred GBP-ratings sub-check too: per this
    research, the star-rating NUMBER (blocked on Places API billing) is
    likely less impactful than GBP/listing *presence and consistency*
    across directories, which costs nothing to check and may be worth
    doing as a cheaper subset before the paid ratings comparison.
- **LLM-based keyword-opportunity relevance refinement -- BUILT
  2026-08-15.** Drafted 2026-08-14, wired in 2026-08-15 once Skyler chose
  Anthropic as the provider. Replaces the static `isOffTopicKeyword`
  blocklist and the raw-volume-only ranking in `buildKeywordOpportunities`
  (`lib/checkers/competitive-position-checker.js`) with an actual
  relevance/realism judgment call, cheap to run since the candidate pool
  is already capped at `MAX_KEYWORD_OPPORTUNITIES` (15) -- one Anthropic
  call per audit run, not per keyword. Purely additive to the existing
  evidence/recommendation layer -- does not change the numeric score,
  same convention as the rest of this feature. Deliberately did NOT
  patch "erp"/"b2b"-style noise into `OFF_TOPIC_KEYWORD_PATTERNS` as a
  quick fix even after confirming they were showing up in a real client
  run -- that blocklist is Firestarter-specific and a static list can't
  generalize across the 85-client roster (erp is legitimate for an ERP
  consultant, worthless for an SEO agency); this is the actual fix, a
  hardcoded patch would just be the same mistake in a different spot.

  New files:
  - `lib/llm/anthropic.js` -- generic `callAnthropicTool()` wrapper
    around Anthropic's Messages API, using forced tool-use
    (`tool_choice: {type: 'tool', ...}`) for reliable structured JSON
    output instead of parsing freeform text. Plain `fetch`, no SDK
    dependency added, matching how Ahrefs/Cloro are already called in
    this codebase. Model defaults to `claude-haiku-5`, overridable via
    an `ANTHROPIC_MODEL` env var without a code change.
  - `lib/keywordRelevance.js` -- `refineKeywordOpportunities()`, the
    actual classification call: judges each candidate keyword for
    topical relevance, funnel stage, local-intent fit (flags a national
    head term for a local business and suggests a local variant), and
    realistic winnability given the domain-rating gap to the competitor.

  Wired into `lib/runAudit.js`: after Competitive Position computes its
  keyword opportunities, they're passed through
  `refineKeywordOpportunities()` before syncing to the `opportunities`
  table. **Fails safe on every failure mode** -- missing
  `ANTHROPIC_API_KEY`, network error, malformed response, or the model
  skipping a keyword -- by passing that item through unfiltered
  (`llmRefined: false`) rather than silently dropping a real,
  deterministically-computed opportunity. This layer can only ever
  *remove* a keyword it explicitly classified as irrelevant; it can
  never zero out the list because of its own hiccup. Same "a
  non-essential side effect failing shouldn't break the audit"
  convention as the rest of this feature.

  `OpportunitiesManager.js` updated to show the enrichment when present
  (realistic-tier badge, funnel stage, suggested local variant,
  relevance/tier reasoning) and degrade gracefully to just the raw
  keyword/volume/competitor line when it isn't (rows synced before this
  shipped, or a run where the call failed).

  **Requires Skyler to add `ANTHROPIC_API_KEY` to Vercel's environment
  variables** -- this is the one manual step I can't do myself.
  `ANTHROPIC_MODEL` is optional, only needed to override the default
  model slug.

  Prompt actually shipped (client context today is name/domain/city/
  region/category from the existing `clients` row plus this run's own
  Ahrefs domain rating -- not yet the richer `service_area_type`/
  `ymyl_sensitive` fields below, which are still backlog):

  ```
  SYSTEM:
  You are a senior local/regional SEO strategist reviewing candidate
  keyword opportunities for a client business. You will be given the
  client's business context and a list of keywords a tracked competitor
  ranks well for that the client does not rank for at all. Judge each
  keyword on its own merits -- a high-volume keyword a competitor ranks
  for is NOT automatically relevant or realistically winnable for this
  client. Be skeptical of generic head terms and off-topic matches.

  CLIENT CONTEXT:
  - business_name, domain
  - primary_services: string[]  (derived from the client's own top
    existing ranking keywords / site content -- NOT a fixed taxonomy)
  - service_area_type: "hyperlocal_single_location" |
    "hyperlocal_multi_location" | "regional" | "national_remote"
  - ymyl_sensitive: boolean
  - client_domain_rating: number

  CANDIDATE KEYWORDS (max 15):
  - keyword, monthly_search_volume, competitor_domain,
    competitor_domain_rating, competitor_position

  For EACH candidate keyword, return:
  - relevant: boolean -- does this genuinely relate to what this
    specific client sells/does? (kills off-topic matches like "erp" or
    "b2b" for an SEO agency, regardless of volume)
  - relevance_reason: one sentence
  - funnel_stage: "informational" | "commercial" | "transactional"
  - geo_recommendation: "none" | "suggest_local_variant" -- flag when
    service_area_type is hyperlocal and this keyword is an unmodified
    national head term; if so also return suggested_local_variant
    (e.g. "seo agency" -> "seo agency denver")
  - realistic_tier: "near_term" | "aspirational" -- near_term if the
    domain-rating gap and competitor position suggest this is winnable
    with realistic content effort; aspirational if the gap is large
    (e.g. a boutique local business vs. a much bigger, better-funded
    competitor)
  - tier_reason: one sentence

  Return strict JSON: an array of objects, one per candidate keyword,
  in the same order given.
  ```

  This also gives the content-brief generator (see "close the gap"
  automation above) exactly the inputs it needs -- relevance, funnel
  stage, and a realistic local variant -- instead of a flat, volume-
  sorted list.
- **Model-ID bug found and fixed same day (2026-08-15).** The Anthropic
  wiring above shipped with `DEFAULT_MODEL = 'claude-haiku-5'` in
  `lib/llm/anthropic.js` -- that model ID doesn't exist. Every
  classification call was silently failing (model-not-found), which
  `refineKeywordOpportunities`'s fail-safe design correctly caught by
  passing every keyword through unrefined (`llmRefined: false`) -- so the
  audit never broke, it just meant refinement never actually ran, and a
  live run still showed "erp"/"b2b" with no tier tags. Confirmed the
  correct current slug against
  https://platform.claude.com/docs/en/about-claude/models/overview
  (`claude-haiku-4-5`, an alias pinned to `claude-haiku-4-5-20251001`) and
  fixed the default. Worth remembering: the fail-safe design did its job
  here -- it just means "nothing looks refined" can ALSO mean "the call is
  silently failing," not only "no data yet." Worth checking `llmRefined`/
  `llmError` on a few rows after any future model-default change.
- **Real SERP-landscape evidence via Cloro -- BUILT 2026-08-15.** Skyler's
  direct question: for a lot of these keyword candidates, is the real
  competition even the tracked agency Ahrefs diffed against, or is it
  actually media/reference publishers (Search Engine Journal, SEMrush,
  HubSpot, Moz, WordStream...) that dominate informational, top-of-funnel
  terms? Judging "realistic_tier" off thriveagency.com's Ahrefs position
  when the real #1-3 Google results are publishers Thrive isn't even
  among was misleading -- Ahrefs' tracked-competitor diffing structurally
  can't see this, since it only ever reports positions for domains already
  on the tracked-competitor list.

  Fix: `lib/serpLandscape.js` fires one live Cloro "google" call PER
  candidate keyword (using the keyword text itself as the query) and
  extracts the real, current top organic-result domains --
  `defaultCloroCaller`/`extractEngineSignal` reused directly from
  `lib/checkers/ai-visibility-snapshot-checker.js` (now exported) rather
  than re-deriving the same google-shape parsing a second time; that
  parsing was already verified 2026-08-10 against a real live capture.
  This is the SAME Cloro API/key already paid for and called weekly for
  AI & GEO Visibility -- no new provider, no new env var.

  Wired into `lib/runAudit.js` BEFORE `refineKeywordOpportunities`, so the
  LLM call gets real `serp_top_domains` evidence per keyword instead of
  inferring everything from the tracked competitor's brand name alone.
  `lib/keywordRelevance.js`'s schema gained a `serp_landscape` field
  (`peer_agency_competitive` | `publisher_dominated` | `mixed` | `unknown`
  -- "unknown" used deliberately over a confident guess when the Cloro
  check wasn't available for a keyword) and `realistic_tier` gained a
  third value, `citation_target`: when the real SERP is publisher-
  dominated, the honest recommendation isn't "write a page and try to
  out-rank Search Engine Journal," it's "get mentioned/quoted inside that
  publisher's existing content" -- a citation/PR play, not a content play.
  `OpportunitiesManager.js` shows a "SERP: publisher-dominated" /
  "SERP: peer agencies" badge plus the actual top-5 ranking domains found,
  so a strategist can verify the call rather than take it on faith.

  **Cost tradeoff, confirmed with Skyler before building:** this is one
  ADDITIONAL live Cloro call per candidate keyword (capped at
  `MAX_KEYWORD_OPPORTUNITIES`, 15), on EVERY audit run, across all
  clients -- real ongoing Cloro usage on top of the existing weekly AI-
  visibility tracking, not a one-time cost. Chosen deliberately over the
  free-but-guessed version because a judgment this consequential (which
  keywords are even worth pursuing) is worth grounding in real evidence.
  Fails safe per keyword, same as everything else in this feature: a
  failed Cloro call just leaves that keyword's `serpLandscape` as
  `'unknown'` rather than blocking the opportunity or the audit run.
- **Public lead-capture pipeline needs to inherit all of the above once
  built.** Skyler flagged (2026-08-14) that the public "AI audit" embed
  (see "Public lead-capture pipeline" above -- still backlog, not yet
  built as of this writing) needs to stay current with these changes.
  Since that pipeline is planned to grade "via this tool's shared core"
  (same checkers as the internal dashboard, per the original plan), the
  competitor-scale-band fix, the keyword-opportunity relevance prompt,
  and the citation-source-gap feature should all live in the shared
  checker/lib layer rather than the dashboard UI specifically -- so
  building the lead-capture pipeline on top of that shared core (whenever
  it's built) inherits these automatically instead of needing a second
  implementation. Clarified with Skyler (2026-08-14): no urgent separate
  fix needed on the currently-live embed at
  firestarterseo.com/ai-search/ai-audit/ -- "no one actually uses it but
  us" (i.e. it isn't in real prospect-facing use today), so this stays a
  future-build note only, not an active bug -- make sure whenever the
  real Public lead-capture pipeline gets built, it's built on the shared
  core with all of the above already in it, rather than patching the old
  embed separately first.

- **Pillar-architecture review against current GEO/AI-citation research**
  (2026-08-14, discussion only, nothing built). Skyler's question: stepping
  back, are the 5 pillars actually the right things to measure to move a
  client's real LLM/AI visibility? Checked against a correlation study
  aggregating Wellows (750M+ citations), Evertune (75,000 brands), and
  BrightEdge (863,000 keywords):
  E-E-A-T/author-credential signals r=0.81, topical authority r=0.41,
  backlinks r=0.37, brand mentions (linked+unlinked) r=0.334, domain
  authority r=0.18 (barely predictive -- consistent with the DR finding
  logged above).
  (https://authoritytech.io/curated/domain-authority-vs-eeat-ai-citation-signal-audit-2026)
  Three concrete mechanisms behind the E-E-A-T number: brands verified
  across 4+ independent platforms are 2.8x more likely to be cited than
  single-platform brands; visible author credentials + Person schema lift
  citation rates ~40% and make pages 3x more likely in AI Overviews;
  pages with original statistics/proprietary research get 4.31x more
  citations per URL than directory-style listings. Cross-checked against
  Search Engine Land's 2026 GEO framework (assess baseline citation gaps
  -> optimize content structure/entity authority/technical foundations/
  freshness -> measure citation frequency & share of voice & sentiment ->
  iterate), which treats citation frequency as the real north-star metric,
  same conclusion the AI & GEO Visibility pillar already assumes.
  (https://searchengineland.com/mastering-generative-engine-optimization-in-2026-full-guide-469142)
  Also referenced Ahrefs' framing of brand mentions as "what backlinks are
  to traditional SEO" for AI search specifically.
  (https://ahrefs.com/blog/audit-brand-mentions/)

  Verdict, pillar by pillar:
  - **Schema & Structure** -- aimed at something real (the `sameAs`
    entity-linking piece IS the mechanism behind multi-platform
    verification) but currently scoped to business-entity/LocalBusiness
    schema only; deliberately skips Person/author-credential schema,
    which is the one schema type shown to have an outsized, measurable
    citation effect. Gap to close, not a reason to distrust the pillar.
  - **Technical Foundation** -- a floor, not a lever. Crawlability/speed
    gate whether a site can be cited at all but don't differentiate
    citation frequency among sites that already pass -- keep as a gate,
    don't expect it to move the needle further.
  - **AI & GEO Visibility** -- the strongest pillar in the set, not close.
    Measures the actual outcome (does an AI engine mention/cite this
    business) rather than a proxy for it -- exactly the field's real
    north-star metric.
  - **Content Authority** -- the biggest mismatch. Word count/freshness/
    referring-domains are legitimate but weak proxies for what actually
    correlates (topical authority r=0.41, and especially original/expert
    content -- 4.31x citation multiplier). Two equal-length pages score
    identically today even if one has a named expert byline with original
    data and the other is generic filler.
  - **Competitive Position** -- split, as already covered above: the
    AI-citation head-to-head half is well-aimed (direct observed
    win/loss on real citations); the keyword-count half has the same
    weak-proxy problem as domain rating.

  **Two real, well-evidenced levers have NO explicit check anywhere in
  the current 5 pillars** and are the highest-value additions before
  investing further in anything leaning on total keyword count or domain
  rating: (1) author/entity-credential check -- Person schema + visible
  bylines/credentials; (2) multi-platform entity-verification check --
  same underlying idea as the "Citation Source Gap" feature proposed
  above, now with a concrete 2.8x citation multiplier behind counting how
  many independent platforms a business is verifiably, consistently
  present on. Also: evolve Content Authority to weight originality/
  expertise/statistics over raw length and recency.
- **Opportunities table -- BUILT 2026-08-15.** New `opportunities` table
  live in Supabase (migration `create_opportunities_table`), plus
  `lib/opportunities.js` (fingerprint/status/auto-close sync logic),
  wired into `runAudit.js` right after `pillar_scores` is written. v1
  populates ONE source only -- Competitive Position's missing-keyword
  opportunities (`type: 'content_brief'`) -- which also finishes the
  "Structured keyword-opportunity UI" step 1 from the "close the gap"
  automation sequence above: `app/clients/[id]/OpportunitiesManager.js`
  renders them as real tracked rows (Open/In progress/Done/Dismissed)
  inside the Competitive Position pillar, via a new
  `app/api/clients/[id]/opportunities/route.js` (GET list, PATCH status).
  Gated correctly on `competitivePositionResult._raw.keywordOpportunitiesChecked`
  (added to the checker's `_raw` the same day) so a run where the Ahrefs
  calls failed/were skipped never gets confused with a run that genuinely
  found zero gaps -- only the latter is allowed to auto-close previously-
  open rows. Manual status changes always win over the next audit's
  auto-refresh/auto-close (see lib/opportunities.js's header for the full
  policy). Original design notes below, kept for the still-open parts:
  `opportunities(id, client_id, pillar, type, status, title, detail jsonb,
  priority_score, first_seen_audit_run_id, last_seen_audit_run_id,
  closed_at, ...)`. `type` covers content_brief / citation_target /
  schema_fix / technical_fix / entity_verification, etc. The point is
  identity across runs: re-running an audit should match a newly-detected
  finding against an existing open row (same client + pillar + a stable
  fingerprint of the finding) and update it, not create a duplicate --
  that's what makes "in progress" / "closed" statuses meaningful instead
  of cosmetic. `runAudit.js` and each checker would need to emit
  fingerprinted findings instead of (or in addition to) the current
  plain `issues` jsonb array on `pillar_scores`. This is the prerequisite
  for the prioritization, execution, workflow, and verification layers
  below -- probably the right place to start building.
- **Cross-pillar prioritized backlog** (depends on the Opportunities
  table above). One ranked list per client blending all open
  opportunities across all 5(soon 6) pillars by severity x estimated
  impact / effort, instead of a strategist reading five separate
  per-pillar issue lists. UI-only once the table exists -- no new data
  collection.
- **Entity & Citation Authority pillar** (proposed 2026-08-14, the 6th
  pillar from the pillar-architecture review above -- not yet built).
  Scores what's currently unscored anywhere: author/Person-schema +
  visible-credential presence, and multi-platform entity-verification
  count (GBP, review platforms, relevant directories, Wikipedia/Wikidata
  where applicable, social) -- the two levers research puts well ahead of
  domain rating and raw keyword count (r=0.81 and a 2.8x citation
  multiplier respectively, see above). Needs new data collection (the
  platform-presence checks noted in the architecture section above)
  before it can grade the entity-verification half; the author-credential
  half can likely reuse/extend the existing Schema & Structure crawl
  (checking for Person schema + byline elements on the live page) with no
  new API cost.
- **Closed-loop verification** (proposed 2026-08-14, depends on the
  Opportunities table). Each opportunity row snapshots the score
  component it's tied to when created; the next scheduled audit run
  checks that specific component again and marks the row closed /
  still-open / regressed automatically, surfaced as a before/after in the
  dashboard rather than just a new grade. Most direct application yet of
  "verify, don't guess" to the tool's own recommendations, and doubles as
  a client-retention asset -- proof a specific billed action moved a
  specific number, not just a new report that looks different.

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
