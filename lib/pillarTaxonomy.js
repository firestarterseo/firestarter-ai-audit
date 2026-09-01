// Shared pillar-id taxonomy -- single source of truth for every valid
// pillar key used across lib/opportunityLifecycle.js and any pillar module
// that qualifies opportunities into the shared lifecycle (lib/sourceCitation.js,
// future pillars, etc).
//
// Reconstructed 2026-09-01: the original lib/pillarTaxonomy.js referenced by
// lib/sourceCitation.pure.test.js (correction test 11) could not be located
// after a thorough search of git history (all refs, dangling objects),
// Downloads, the OneDrive recovery workspace, VS Code local history /
// workspaceStorage / backups, and every sibling project folder on the
// device -- see the recovery investigation report for the full search log.
// This is a minimum, evidence-backed reconstruction:
//   - The first 6 ids are the pillars lib/opportunityLifecycle.js already
//     hardcoded (order preserved exactly, since correction test 11 uses
//     assert.deepStrictEqual, which is order-sensitive).
//   - 'ai_source_citation_presence' is appended because lib/sourceCitation.js
//     calls qualifyOpportunity({ owningPillar: 'ai_source_citation_presence',
//     originatingPillar: 'ai_source_citation_presence', ... }), and
//     opportunityLifecycle.js's assertOneOf() throws unless that value is a
//     member of PILLARS.
// Deliberately NOT included: 'entity_brand_authority' -- no recovered file
// or test references it, so adding it now would be a guess rather than
// evidence-backed reconstruction. Add it when that pillar's own work begins.
const PILLAR_IDS = [
  'schema_structure',
  'technical_foundation',
  'ai_geo_visibility',
  'content_authority',
  'competitive_position',
  'entity_citation_authority',
  'ai_source_citation_presence'
]

module.exports = { PILLAR_IDS }
