# AI Source & Citation Presence — Evidence-Strength Correction — files to merge

Drop these files into your local repo at the same paths (overwriting the existing
ones), then commit and push as usual — `auto-push.ps1` will pick it up if it's running.

## New files
- `lib/citedPageInspection.js` — the new real page-fetch-and-inspect module.
  Fetches an actual cited URL, extracts text (regex-only, no new dependency),
  checks whether the client entity genuinely appears, classifies the
  relationship type, and honestly categorizes fetch failures (robots-blocked,
  auth-required, JS-rendering-required, rate-limited, network-failure,
  blocked-access, deleted-page) as `unverifiable` — never as absence. Includes
  a bounded-concurrency, deduped, cached orchestration function
  (`inspectCitedUrlsForClient`) that only ever runs from audit/research
  processing or an explicit re-check action, never from a page render.
- `app/api/clients/[id]/sources/recheck/route.js` — a new POST route for an
  AM-triggered "re-check cited pages now" action (wired into the wizard's
  Source Landscape step).

## Edited files
- `lib/sourceCitation.js` — the core evidence-strength correction:
  - `PRESENCE_STATUSES`/`PRESENCE_CONFIDENCE` widened to 6/4 values. The old
    `appears_in_cited_content` (which was really just AI-response
    co-occurrence) is split into `ai_response_co_occurrence` (weak) and
    `appears_in_cited_content_verified` (strong, page-level verified).
  - `determineClientPresence` rewritten to check verified page inspections
    FIRST, before falling back to the weaker co-occurrence state.
  - `determineTreatment`'s Strength/Protect gate corrected to require
    verified presence (or a client-owned page cited), never mere
    co-occurrence.
  - `qualifiesAsOpportunity`/`doNothingReason` replaced by a single
    `classifySourceDisposition` function with a new 4th outcome —
    `'observational'` — for sources whose evidence doesn't establish a real
    gap either way. No opportunity row gets created for these.
  - `syncClientSources` now invokes cited-page inspection (bounded, deduped,
    persisted) before computing presence, and `qualifySourceOpportunities`
    skips opportunity creation entirely for observational sources.
  - `getSourceLandscape`'s presence counts updated to the corrected 6-value
    set, plus a new `observationalCount`.
- `lib/sourceCitation.pure.test.js` — rewritten: corrected the tests that
  exercised the old conflated model, and added all 12 new tests the
  correction requires.
- `lib/sourceCitation.test.js` — DB-backed script redesigned around four
  synthetic sources, one per corrected outcome (observational / qualified /
  do_nothing / strength_protect), so the correction is exercised end-to-end
  against the real Phase 3 lifecycle.
- `app/clients/[id]/SourceCitationWizard.js` — presence labels/tones updated
  for the corrected 6-value status set; added a domain-presence-note display,
  a page-inspection-summary line, an observational-count callout, and the
  new "Re-check cited pages now" button (explicit click only — never fires
  on render).

## Database
Already applied directly to the live Supabase project (`firestarter-ai-audit`,
project `xmzmywmtnaeholshukow`) — nothing further to run there:
- Widened `client_sources`'s `client_presence_status`/`client_presence_confidence`
  CHECK constraints to the corrected value sets, renamed the pre-existing 3
  sample rows' old values to the corrected names, and added
  `domain_presence_note`/`page_inspection_summary` columns.
- New `cited_page_inspections` table (RLS enabled, no policies — service-role
  only, same convention as every other table in this project).
- All 16 real Firestarter SEO sources were re-synced under the corrected
  model and persisted to `client_sources`/`cited_page_inspections` (see the
  full report for the before/after breakdown). The 3 pre-existing
  opportunity rows (none of which had any real AM approval/execution
  activity) were removed, since the corrected model produces zero qualifying
  opportunities for this client today — see report section L.

## Before deploying
`npm run build` passes cleanly with these files in place (verified in the
sandbox), and the full pure test suite (`npm run test:source-citation-pure`,
29 tests including the 12 new correction tests) passes. Recommend a Vercel
**preview** deploy first to sanity-check the corrected wizard labels against
real Firestarter data before promoting to production.
