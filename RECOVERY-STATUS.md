# Recovery Status — Phase 3 / Pillar Taxonomy / AI Source & Citation Presence

Last updated: 2026-09-01. Recorded so this recovery effort's exact state does not
need to be reconstructed again in a future session.

## 1. Current GitHub state

`origin/main` is at **`bcbca0b`**. Relevant commit history, most recent first:

| Commit | Summary |
|---|---|
| `bcbca0bf10b68fad1f86fb6ab5881effc0180496` | Restore recovered AI Source & Citation Presence implementation |
| `fc3865c5b43f5692bf0c7dafbc1bf84e2c053482` | Reconstruct shared pillar taxonomy bridge |
| `f8e7681bfc66593a827394f8551aa18a0e2c1f32` | Restore recovered Phase 3 shared opportunity lifecycle architecture |
| `6bb0237c14fb5a5e2873a7e586c6c8dc9b7c9e33` | "AI Source & Citation Presence: MVP closure pass" — **title is misleading**: its actual diff is only `lib/opportunities.zip` (a binary backup snapshot), zero real code changes. Do not trust this commit's message as evidence of what exists in code. |

Status: Phase 3 shared opportunity lifecycle is restored. The shared pillar
taxonomy (`lib/pillarTaxonomy.js`) has been reconstructed (see §6). AI Source
& Citation Presence source code has been recovered and restored as inert,
unwired code.

## 2. Validated code

All of the following were verified in this recovery effort (pure/fixture
tests only — nothing DB-backed was run):

- `npm run test:opportunity-lifecycle-pure` — **12/12 passed**
- `npm run test:source-citation-pure` — **29/29 passed**, including all 12
  evidence-strength-correction tests and the taxonomy-bridge regression test
- Existing Phase 2 pure suites (`test:prompt-cadence`,
  `test:prompt-topic-intelligence-pure`) — still pass, unaffected
- `npm run test:checkers` (all 5 existing pillar checker fixtures) — still
  pass, unaffected
- **AI Source & Citation Presence is currently inert**: `SourceCitationWizard.js`
  is not imported by `page.js` or `PillarsBoard.js`; `syncSourceCitationPillar`
  is referenced only inside its own files; `lib/runAudit.js` is unmodified. No
  production code path calls it.

## 3. Recovered Source & Citation files

Restored from a local backup
(`ai-source-citation-evidence-strength-correction.zip`) after being lost
without ever being committed:

- `README-evidence-strength-correction.md` — the correction's own change-log
  describing the presence-status model widening and the cited-page-inspection
  fetch it adds.
- `lib/sourceCitation.js` — pillar core: evidence-strength-corrected presence
  detection, disposition classification (`observational` /
  `qualified` / `do_nothing` / `strength_protect`), and opportunity
  qualification via the Phase 3 lifecycle.
- `lib/citedPageInspection.js` — real page-fetch-and-inspect module (fetches
  an actual cited URL, checks genuine client presence, classifies fetch
  failures as `unverifiable` rather than absence). Zero dependencies beyond
  Node built-ins.
- `lib/sourceCitation.pure.test.js` — 29 pure-logic tests, no DB required.
- `lib/sourceCitation.test.js` — DB-backed test script. **Not run** in this
  or any recovery-session environment (no Supabase credentials available
  here); per its own header, its assertions were previously verified against
  the real Supabase project in a different, DB-capable session.
- `app/clients/[id]/SourceCitationWizard.js` — wizard UI component. Not
  imported anywhere yet.
- `app/api/clients/[id]/sources/recheck/route.js` — POST route for an
  AM-triggered manual re-check. Not called from anywhere in the app yet.

`package.json` also gained one script: `test:source-citation-pure`. The
recovery zip contained no `package.json` of its own, so there was no
recovered DB-backed script name to carry over — `test:source-citation`
(DB-backed) does not exist yet and should only be added deliberately.

## 4. Database verification — BLOCKED / REQUIRED

**Live Supabase has not been verified in this recovery effort.** No session
involved in this recovery had a Supabase/Postgres MCP tool or credentials
available. Nothing below has been confirmed against the real database —
only derived from code (what the code requires to run) or claimed by the
recovered README (which is not authoritative).

### Phase 3 DB contract requiring verification

**Expected from code** (`lib/opportunityLifecycle.js`):
- Tables: `opportunities`, `opportunity_prepared_work`, `opportunity_history`
- `opportunities` fields referenced by the lifecycle: `originating_pillar`,
  `evidence`, `related_refs`, `topic_cluster_id`, `prompt_variation_id`,
  `priority_assessment`, `priority_treatment`, `execution_capability`,
  `approval_status`, `approved_prepared_work_id`, `execution_status`,
  `execution_state`, `verification_status`, `verification_state`,
  `verified_at`, `resolved_at`, `disposition_reason`, `disposition_detail`,
  `retest_status`, `retest_state`, `ai_visibility_outcome_status`,
  `recurrence_count`, `last_observed_at`
- Expected CHECK constraints/enums: `PRIORITY_TREATMENTS`,
  `EXECUTION_CAPABILITIES`, `APPROVAL_STATUSES`, `EXECUTION_STATUSES`,
  `VERIFICATION_STATUSES`, `RETEST_STATUSES`, `DISPOSITION_REASONS`,
  `ARTIFACT_TYPES`, `PREPARED_WORK_STATUSES` (all defined in
  `opportunityLifecycle.js`)
- Expected uniqueness: `(client_id, fingerprint)` on `opportunities`
- Expected FKs / cascade behavior: not independently confirmed from code —
  requires live-schema inspection
- Expected indexes: not independently confirmed from code — requires
  live-schema inspection
- RLS/policies: per Phase 3 recovery README convention, other tables in this
  project use service-role-only access (RLS enabled, no policies) — **unconfirmed for these tables specifically**

**Confirmed from live DB:** NONE.

### Source & Citation DB contract requiring verification

**Expected from code** (`lib/sourceCitation.js`, `lib/citedPageInspection.js`,
`lib/sourceCitation.test.js`):
- `client_sources` table with (at minimum) columns for presence status/
  confidence, domain presence note, page inspection summary
- `cited_page_inspections` table (new)
- Widened `client_sources.client_presence_status` /
  `client_presence_confidence` CHECK constraints to a 6-value/4-value set
  (old `appears_in_cited_content` split into `ai_response_co_occurrence` and
  `appears_in_cited_content_verified`)
- Pillar id `ai_source_citation_presence` must be a valid `owningPillar`/
  `originatingPillar` value in the `opportunities` table's own constraints
  (satisfied in code via the reconstructed `lib/pillarTaxonomy.js` — but the
  live `opportunities` table's own CHECK constraint, if one exists
  independently of application code, is unconfirmed)
- Indexes/uniqueness on `client_sources`/`cited_page_inspections`: not
  independently confirmed from code
- FKs (e.g. `client_sources`/`cited_page_inspections` → `clients`): not
  independently confirmed from code
- RLS/policies: unconfirmed

**Claimed by recovered README only** (`README-evidence-strength-correction.md`)
— treat as unverified, not fact:
- All of the above schema changes "already applied directly to the live
  Supabase project" (`firestarter-ai-audit`, project `xmzmywmtnaeholshukow`)
- Approximately 16 real Firestarter SEO client source records re-synced
  under the corrected model
- The 3 pre-existing opportunity rows (none with real AM approval/execution
  activity) were removed, since the corrected model produces zero qualifying
  opportunities for this client today

**Confirmed from live DB:** NONE. No table, column, constraint, row count,
or deletion claim above has been checked against the real database in this
recovery effort.

## 5. Activation gates

Before AI Source & Citation Presence is activated (wired into any page, API
route call site, or `runAudit.js`), all of the following must happen, in
order:

1. Live Supabase schema must be verified (read-only) against both the
   Phase 3 and Source & Citation contracts above.
2. Any required migrations or fixes identified by that verification must be
   identified and reviewed (not necessarily written yet — identification
   first).
3. DB-backed tests (`lib/opportunityLifecycle.test.js`,
   `lib/sourceCitation.test.js`) must actually pass against the verified
   schema.
4. Only after 1–3 are complete may production wiring (`SourceCitationWizard`
   into `page.js`/`PillarsBoard.js`, `syncSourceCitationPillar` into
   `runAudit.js`, the recheck route being called from the UI) be considered.

## 6. Entity & Brand Authority

- An approved methodology/correction spec for Entity & Brand Authority
  exists (provided directly by the project owner earlier in this recovery
  effort, including the two architectural corrections: competitor evidence
  must be structurally distinguishable from client evidence, and page-level
  association strength must roll up to target-level via a categorical
  rubric, not `MAX()`).
- **Implementation has not started.** No `entity_brand_authority` code,
  tests, or wiring exist anywhere in this repo.
- Do not start Entity & Brand Authority implementation until the DB
  verification (§4) and the Source & Citation recovery/activation decisions
  (§5) are resolved.
- `lib/pillarTaxonomy.js`'s `PILLAR_IDS` intentionally does **not** yet
  include `'entity_brand_authority'` — no recovered file or test references
  it, so it was deliberately left out of the taxonomy-bridge reconstruction
  rather than guessed at. Add it only when that pillar's own work begins.

## 7. Recovery artifacts

Local recovery workspace on the user's machine ("bosshog"):

```
C:\Users\skyle\OneDrive\Desktop\firestarter-ai-audit-recovery\
```

Contents as of this recovery effort:
- `phase3-shared-execution-architecture\` — the original Phase 3 recovery
  source folder (`OpportunityCard.js`, `opportunityLifecycle.js`,
  `opportunityLifecycle.pure.test.js`, `opportunityLifecycle.test.js`,
  `package.json`, `StatusTrack.js`). All 5 non-package.json files are now
  restored to the repo (§1); this folder itself has not been deleted.
- `ai-source-citation-evidence-strength-correction.zip` and
  `..._1.zip` — byte-identical duplicates, the Source & Citation recovery
  source. All 7 files inside are now restored to the repo (§3); these zips
  have not been deleted.
- `pillar-taxonomy-bridge-fc3865c.bundle` and
  `source-citation-restore-bcbca0b.bundle` — git bundles used to get the
  taxonomy-bridge and Source & Citation commits onto `origin/main` from a
  session whose git-proxy could not push directly to this repo. Safe to
  delete once confirmed no longer needed.

**`lib/pillarTaxonomy.js` itself was never found anywhere** — not in git
history (all refs, dangling objects), not in Downloads, not in this
recovery workspace, not in VS Code local history/workspaceStorage/backups,
not in any sibling project folder. It was reconstructed from code evidence
only (see the commit `fc3865c` message for the full reasoning); this is
noted here so a future session doesn't re-search for an original that does
not exist.

## 8. Next session instructions

The first task in a Supabase-capable session (one with a Postgres/Supabase
MCP tool or equivalent, actually connected) should be **READ-ONLY**
verification of the Phase 3 and Source & Citation database contracts
described in §4 above — table existence, columns, types, constraints/enums,
uniqueness, foreign keys, cascade behavior, indexes, and RLS/policies — plus
investigating whether the README's specific historical production-data
claims (§4) can be confirmed or refuted. No schema changes, no data
writes, no migrations, until that verification is complete and reviewed.

No credentials, connection strings, or secrets are recorded in this
document or anywhere in this repository.
