// SCHEMA ARTIFACT INTEGRITY (2026-09-24 correction). Pure, network-free,
// zero dependencies -- shared by lib/schemaDeployableArtifact.js (APPROVED
// -> DEPLOYED, checked before every WordPress write) and
// lib/schemaLiveVerification.js (APPROVED -> LIVE, checked on every
// Verify Live). Both questions are really the same primitive: "does this
// schema node still say what it said when the AM approved it?" -- this
// file is the one place that answers that, so the two call sites can never
// silently drift onto two different definitions of "matches."
//
// ROOT CAUSE THIS FILE CORRECTS: lib/schemaDeployableArtifact.js used to
// strip any node property literally named "description" (NEVER_DEPLOY_KEYS),
// because "description" is ALSO the name of an unrelated, internal,
// envelope-level field every prepared-work item already carries (see
// SANITIZATION BOUNDARY below). Once a real generator (Service) started
// putting a genuine schema.org Service.description property directly on
// the node itself, that name-based blacklist silently deleted real,
// approved, AM-visible content on every deploy -- with no error, no
// warning, and nothing in the UI to reveal it happened. A blacklist of
// property NAMES can never be safe here, because schema.org's own
// vocabulary (name, description, url, identifier, status, action, type...)
// overlaps with plausible internal-metadata field names by construction --
// the fix is structural (WHERE a field lives), never a growing list of
// names to avoid.
//
// SANITIZATION BOUNDARY (the actual, structural rule):
//   prepared-work ITEM (the envelope)         <- internal metadata lives HERE
//   { description, evidence, reason, ... ,
//     node: { "@type": "Service", "description": "...", provider: {...} } }
//                ^ everything inside `node` IS the real schema node
//
// Internal/control fields (description, evidence, reason, action, or
// anything else this pipeline's own generators ever add to an item) live
// on the ITEM, as siblings of `node` -- never inside it. Every generator in
// lib/schemaPreparedWork.js already constructs `node` this way (a clean
// object built ONLY from real schema.org properties + @context/@type) --
// so the correct boundary is simply: read `entry.node` and NOTHING else
// from the entry, and never filter ANY key out of `node` by name. This
// file's helpers below implement exactly that -- no blacklist, no
// allowlist of node property names either (a future profile's own
// properties must never require this file's permission to survive).

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

// buildApprovedNodes(payload) -> the node list EXACTLY as approved (every
// ADD entry's own `.node`, untouched) -- the one authoritative source of
// "what did the AM actually approve." Never reads `.description`,
// `.evidence`, or any other envelope field on an entry.
function buildApprovedNodes(payload) {
  const add = Array.isArray(payload?.add) ? payload.add : []
  return add
    .map(entry => (isPlainObject(entry) ? entry.node : null))
    .filter(node => isPlainObject(node))
}

// extractDeployableNodes(jsonLd) -> flat node array from either a
// single-node deployable artifact or a multi-node @graph one.
function extractDeployableNodes(jsonLd) {
  if (!isPlainObject(jsonLd)) return []
  if (Array.isArray(jsonLd['@graph'])) return jsonLd['@graph']
  return [jsonLd]
}

// diffSchemaNodes(expected, actual, path, opts) -> [{path, kind, expected,
// actual}, ...]. A generic, order-independent structural diff -- detects a
// removed property, an added property (unless `subsetOnly`), a changed
// scalar value, a changed/removed/added array member, and (since @id/@type
// are just ordinary top-level keys) an @id or @type change falls out of
// the same generic walk rather than needing special-case logic. Never
// relies on key ORDER -- object keys are compared by name, not position.
//
// `subsetOnly` (default false): when true, a key present in `actual` but
// NOT in `expected` is never reported -- used for the APPROVED -> LIVE
// comparison, where the live page (or an unrelated plugin's node sharing
// the same @id, however unlikely) is allowed to carry properties beyond
// what this pipeline approved; only what WAS approved must still match.
// The strict APPROVED -> DEPLOYED comparison (subsetOnly: false) requires
// an exact match in both directions, since the deploy transform is
// supposed to be a lossless, mechanical copy of the approved node.
function diffSchemaNodes(expected, actual, path = '', { subsetOnly = false } = {}) {
  const here = path || '(root)'
  if (expected === actual) return []
  if (expected === null || actual === null || typeof expected !== 'object' || typeof actual !== 'object') {
    if (expected === actual) return []
    return [{ path: here, kind: 'changed', expected, actual }]
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) {
    return [{ path: here, kind: 'changed', expected, actual }]
  }
  if (Array.isArray(expected)) {
    const diffs = []
    const maxLen = subsetOnly ? expected.length : Math.max(expected.length, actual.length)
    for (let i = 0; i < maxLen; i++) {
      const p = `${path || ''}[${i}]`
      const hasExp = i < expected.length
      const hasAct = i < actual.length
      if (hasExp && !hasAct) diffs.push({ path: p, kind: 'removed', expected: expected[i], actual: undefined })
      else if (!hasExp && hasAct) { if (!subsetOnly) diffs.push({ path: p, kind: 'added', expected: undefined, actual: actual[i] }) }
      else diffs.push(...diffSchemaNodes(expected[i], actual[i], p, { subsetOnly }))
    }
    return diffs
  }
  const diffs = []
  const keys = subsetOnly
    ? Object.keys(expected)
    : Array.from(new Set([...Object.keys(expected), ...Object.keys(actual)]))
  for (const key of keys) {
    const p = path ? `${path}.${key}` : key
    const hasExp = Object.prototype.hasOwnProperty.call(expected, key)
    const hasAct = Object.prototype.hasOwnProperty.call(actual, key)
    if (hasExp && !hasAct) diffs.push({ path: p, kind: 'removed', expected: expected[key], actual: undefined })
    else if (!hasExp && hasAct) { if (!subsetOnly) diffs.push({ path: p, kind: 'added', expected: undefined, actual: actual[key] }) }
    else diffs.push(...diffSchemaNodes(expected[key], actual[key], p, { subsetOnly }))
  }
  return diffs
}

// verifyApprovedToDeployableIntegrity(payload, jsonLd) -> {ok, diffs}.
// APPROVED -> DEPLOYED: does the artifact this deploy is about to send
// still say exactly what the AM approved? The ONE mechanical normalization
// this deploy layer is allowed to apply -- ensureContext's @context
// default/hoist -- is accounted for explicitly here, never mistaken for
// semantic loss; everything else must match exactly (strict, not subset --
// the deploy transform must never ADD content the AM never saw either).
function verifyApprovedToDeployableIntegrity(payload, jsonLd) {
  const approvedNodes = buildApprovedNodes(payload)
  const deployedNodes = extractDeployableNodes(jsonLd)
  const isGraph = isPlainObject(jsonLd) && Array.isArray(jsonLd['@graph'])

  if (approvedNodes.length !== deployedNodes.length) {
    return {
      ok: false,
      diffs: [{ path: '(root)', kind: 'node_count_mismatch', expected: approvedNodes.length, actual: deployedNodes.length }]
    }
  }

  const diffs = []
  for (let i = 0; i < approvedNodes.length; i++) {
    const approvedNode = approvedNodes[i]
    const approvedId = typeof approvedNode['@id'] === 'string' ? approvedNode['@id'] : null
    const deployedNode = approvedId ? deployedNodes.find(n => isPlainObject(n) && n['@id'] === approvedId) : deployedNodes[i]
    if (!deployedNode) {
      diffs.push({ path: `add[${i}]`, kind: 'node_missing', expected: approvedId || `(node at index ${i}, no @id)`, actual: null })
      continue
    }
    let expectedNode = approvedNode
    let actualNode = deployedNode
    if (isGraph) {
      // Every @graph member's own @context is hoisted to the wrapper --
      // compare both sides without it rather than flagging the hoist as
      // "removed."
      const { '@context': _e, ...expRest } = approvedNode
      const { '@context': _a, ...actRest } = deployedNode
      expectedNode = expRest
      actualNode = actRest
    } else if (!approvedNode['@context']) {
      // Single-node deploy: a MISSING @context gets the default filled in
      // -- additive, never a semantic change -- so an approved node with
      // no @context at all is compared as if it already had the default.
      expectedNode = { '@context': 'https://schema.org', ...approvedNode }
    }
    diffs.push(...diffSchemaNodes(expectedNode, actualNode, `add[${i}]`))
  }
  return { ok: diffs.length === 0, diffs }
}

module.exports = {
  buildApprovedNodes,
  extractDeployableNodes,
  diffSchemaNodes,
  verifyApprovedToDeployableIntegrity
}
