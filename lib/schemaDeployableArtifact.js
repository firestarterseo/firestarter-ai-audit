// PHASE 7 -- WORDPRESS SCHEMA EXECUTION (2026-09-04).
//
// APPROVED PREPARED WORK -> FINAL DEPLOYABLE JSON-LD.
//
// (2026-09-24) See lib/schemaArtifactIntegrity.js's header for the
// sanitization-boundary correction this module now relies on, and for
// verifyApprovedToDeployableIntegrity -- the explicit APPROVED -> DEPLOYED
// integrity gate this module now runs before ever returning ok:true.
//
// lib/schemaPreparedWork.js's payload is an INTERNAL control structure --
// { supported, keep, add, modify, remove, canonicalEntity,
//   unresolvedDependencies, scriptSnippet, ... } -- built for an AM to
// review, not for a browser to render. This module is the one, explicit,
// deterministic place that turns an AM-APPROVED version of that structure
// into the actual `application/ld+json` payload the WordPress plugin is
// asked to store and render. Nothing here ever ships `add`/`modify`/`keep`/
// `unresolvedDependencies` themselves onto the live page -- see
// buildDeployableSchema's own contract below.
//
// WHY MODIFY/REMOVE ARE NEVER AUTO-DEPLOYED (Phase 7 instruction #3/#4):
// a `modify` entry (see lib/schemaPreparedWork.js#buildEntityRelationshipModifyProposal
// and its LOCATION_HUB @type-broadening case) is a PARTIAL patch meant to
// be merged into an EXISTING node this pipeline does not own -- one already
// declared by Yoast, RankMath, a theme, or another plugin. There is no safe,
// general way for this system to locate that exact live node and merge a
// patch into it without risking a duplicate node, a conflicting @id, or
// outright corrupting markup we do not control (explicit guardrail:
// "Avoid... replacing Yoast/RankMath schema wholesale... invalid nested
// JSON-LD"). `remove` carries the identical risk and is never populated by
// today's generator anyway. So: any prepared work carrying a non-empty
// `modify` or `remove` is EXECUTION BLOCKED here, every time, regardless of
// approval -- approval means "an AM signed off on the DIAGNOSIS and
// proposal," not "this system is now allowed to guess how to safely apply
// a patch it was never built to apply." Only a pure-ADD proposal (the
// About/Contact reference implementation's actual shape) is safely,
// deterministically deployable: each `add` entry is already a
// self-contained, valid JSON-LD node (built by
// lib/schemaPreparedWork.js#buildSubtypePageProposal) that only ever POINTS
// at an existing canonical entity via a bare {"@id": ...} reference -- it
// never inlines or rewrites that entity's own fields. This is exactly
// Phase 7 instruction #16's "Firestarter-managed schema owns only what it
// injected, and may reference canonical @ids from other existing schema
// without owning the entire page graph."

const { verifyApprovedToDeployableIntegrity } = require('./schemaArtifactIntegrity')

const BLOCKED_REASONS = {
  NOT_AN_OBJECT: 'ARTIFACT_NOT_AN_OBJECT',
  NOT_SUPPORTED: 'ARTIFACT_NOT_SUPPORTED',
  HAS_MODIFY: 'ARTIFACT_HAS_MODIFY',
  HAS_REMOVE: 'ARTIFACT_HAS_REMOVE',
  NO_ADD_NODES: 'ARTIFACT_NO_ADD_NODES',
  INVALID_NODE: 'ARTIFACT_INVALID_NODE',
  DUPLICATE_ID: 'ARTIFACT_DUPLICATE_ID',
  INTEGRITY_MISMATCH: 'ARTIFACT_INTEGRITY_MISMATCH'
}

// EXECUTION_BLOCKED_MESSAGE -- the literal phrase Phase 7 instruction #3
// requires callers surface verbatim when an approved artifact cannot be
// safely turned into deployable JSON-LD.
const EXECUTION_BLOCKED_MESSAGE = 'EXECUTION BLOCKED — APPROVED ARTIFACT INSUFFICIENT'

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

// validAddNode(node) -> true if `node` is structurally sound enough to
// deploy as-is: a plain object with a real @type (string, or a non-empty
// array of strings). Everything else about the node (whatever properties
// it carries) passes through completely unchanged -- this function only
// ever gates on shape, never rewrites content.
function validAddNode(node) {
  if (!isPlainObject(node)) return false
  const type = node['@type']
  if (typeof type === 'string' && type.trim()) return true
  if (Array.isArray(type) && type.length > 0 && type.every(t => typeof t === 'string' && t.trim())) return true
  return false
}

// ensureContext(node) -> `node`, guaranteed to carry "@context":
// "https://schema.org" (lib/schemaPreparedWork.js's own generator already
// sets this on every node it builds; this is a defensive default for any
// future generator that omits it, never an override of a node that already
// declares its own @context).
function ensureContext(node) {
  if (node['@context']) return node
  return { '@context': 'https://schema.org', ...node }
}

// buildDeployableSchema(payload) -> { ok: true, jsonLd, nodeCount } |
// { ok: false, blocked: true, code, reason }.
//
// `payload` is the EXACT payload of the AM-approved opportunity_prepared_work
// row (never re-derived from a fresh diagnosis -- Phase 7 instruction #2's
// "maintain provenance": what gets deployed must trace back to exactly what
// was approved). This function is pure and synchronous -- no I/O, no
// network, nothing to mock in tests.
//
// CONTRACT: on ok:true, `jsonLd` contains ONLY real schema.org node
// content -- never the literal keys "add", "modify", "keep", or
// "unresolvedDependencies" at any level (Phase 7 instruction #3's "never
// paste internal control structures... directly onto the live website"),
// and it is always valid, JSON.stringify-safe data (plain objects/arrays/
// strings/numbers/booleans/null only -- guaranteed by only ever copying
// fields out of already-parsed JSON payloads).
function buildDeployableSchema(payload) {
  if (!isPlainObject(payload)) {
    return { ok: false, blocked: true, code: BLOCKED_REASONS.NOT_AN_OBJECT, reason: 'Approved prepared work is missing or is not a valid object.' }
  }
  if (payload.supported !== true) {
    return { ok: false, blocked: true, code: BLOCKED_REASONS.NOT_SUPPORTED, reason: 'Approved prepared work was never marked as a supported, content-defensible proposal.' }
  }
  if (Array.isArray(payload.modify) && payload.modify.length > 0) {
    return {
      ok: false, blocked: true, code: BLOCKED_REASONS.HAS_MODIFY,
      reason: 'This prepared work includes MODIFY changes to schema already on the page. Patching existing third-party markup cannot be safely automated -- only pure-ADD prepared work can be deployed automatically. Execute this page\'s schema change manually.'
    }
  }
  if (Array.isArray(payload.remove) && payload.remove.length > 0) {
    return {
      ok: false, blocked: true, code: BLOCKED_REASONS.HAS_REMOVE,
      reason: 'This prepared work includes REMOVE changes to schema already on the page. Removing existing markup cannot be safely automated. Execute this page\'s schema change manually.'
    }
  }
  const add = Array.isArray(payload.add) ? payload.add : []
  if (add.length === 0) {
    return { ok: false, blocked: true, code: BLOCKED_REASONS.NO_ADD_NODES, reason: 'Approved prepared work has no ADD nodes -- there is nothing to deploy.' }
  }

  const nodes = []
  const seenIds = new Set()
  for (const entry of add) {
    const rawNode = isPlainObject(entry) ? entry.node : null
    if (!validAddNode(rawNode)) {
      return { ok: false, blocked: true, code: BLOCKED_REASONS.INVALID_NODE, reason: 'Approved prepared work contains an ADD entry with no valid node (must be an object with a real "@type").' }
    }
    // SANITIZATION BOUNDARY (2026-09-24 correction -- see
    // lib/schemaArtifactIntegrity.js's header for the full root-cause
    // writeup): `rawNode` (entry.node) IS the real schema node -- every
    // generator in lib/schemaPreparedWork.js already builds it from ONLY
    // real schema.org properties + @context/@type, with all internal/
    // envelope metadata (description, evidence, ...) kept as SIBLINGS of
    // `node` on the entry itself, never inside it. This used to also run
    // rawNode through stripInternalKeys(), a name-based blacklist that
    // deleted any key literally called "description" -- which broke the
    // moment a real generator (Service) legitimately put a genuine
    // schema.org Service.description property directly on the node.
    // There is no blacklist here anymore: nothing is ever filtered out of
    // a node by property name.
    const node = ensureContext(rawNode)
    const id = typeof node['@id'] === 'string' ? node['@id'] : null
    if (id) {
      if (seenIds.has(id)) {
        return { ok: false, blocked: true, code: BLOCKED_REASONS.DUPLICATE_ID, reason: `Approved prepared work contains more than one ADD node with the same "@id" (${id}) -- refusing to deploy a duplicate node.` }
      }
      seenIds.add(id)
    }
    nodes.push(node)
  }

  // A single node deploys as itself -- the simplest, most direct valid
  // JSON-LD document. Multiple nodes deploy as one @graph so they render
  // in a single <script> block as one coherent document rather than
  // several independently-parsed ones.
  const jsonLd = nodes.length === 1
    ? nodes[0]
    : { '@context': 'https://schema.org', '@graph': nodes.map(n => { const { '@context': _ctx, ...rest } = n; return rest }) }

  // Final structural safety check (instruction #17): must round-trip
  // through JSON without throwing and without producing `undefined` (which
  // JSON.stringify would silently drop, but which signals a value that
  // never belonged in a schema payload to begin with).
  let serialized
  try {
    serialized = JSON.stringify(jsonLd)
  } catch (e) {
    return { ok: false, blocked: true, code: BLOCKED_REASONS.INVALID_NODE, reason: `Final schema could not be serialized to JSON: ${e.message}` }
  }
  if (!serialized || serialized === '{}' ) {
    return { ok: false, blocked: true, code: BLOCKED_REASONS.INVALID_NODE, reason: 'Final schema serialized to an empty object.' }
  }

  // APPROVED -> DEPLOYED INTEGRITY GATE (2026-09-24): an explicit,
  // standing safeguard against semantic drift between what the AM
  // approved and what this function is about to hand the caller to
  // publish -- independent of, and in addition to, the sanitization-
  // boundary fix above (defense in depth: this would have caught the
  // stripped-description defect on its own, and will catch any FUTURE
  // transform bug the same way, without anyone having to remember why).
  // A mismatch here is a real deploy-time bug, never a normal validation
  // outcome -- it blocks exactly like every other check above, with the
  // literal diffs included so the failure is diagnosable, not just named.
  const integrity = verifyApprovedToDeployableIntegrity(payload, jsonLd)
  if (!integrity.ok) {
    return {
      ok: false, blocked: true, code: BLOCKED_REASONS.INTEGRITY_MISMATCH,
      reason: 'The deployable artifact does not semantically match the approved prepared work -- refusing to publish a degraded artifact.',
      diffs: integrity.diffs
    }
  }

  return { ok: true, jsonLd, nodeCount: nodes.length }
}

module.exports = {
  EXECUTION_BLOCKED_MESSAGE,
  BLOCKED_REASONS,
  buildDeployableSchema
}
