// PHASE 7 -- WORDPRESS SCHEMA EXECUTION (2026-09-04): LIVE VERIFICATION.
//
// verifyDeployedSchema({ jsonLd, html }) checks whether the schema this
// system deployed (`jsonLd`, from lib/schemaDeployableArtifact.js) is
// ACTUALLY present in a live page's rendered/source HTML (`html`, from a
// real lib/webPageFetch.js#fetchWebPage() call) -- evidence-based, per
// instruction #12: "Do not verify merely because the WordPress API
// returned 200." Pure and synchronous: the caller does the real fetch
// (I/O), this module only inspects already-fetched text, which is what
// makes it directly unit-testable with fixed HTML fixtures.
//
// WHAT "PRESENT" MEANS (instruction #12's own worked example): for every
// node in the deployed artifact (a single node, or every entry of a
// @graph) --
//   - a live node with the SAME @type(s) exists
//   - if the deployed node declared an @id, a live node with that EXACT
//     @id exists
//   - every bare {"@id": ref} relationship property on the deployed node
//     (e.g. `about: {"@id": "..."}`) resolves to the SAME @id somewhere on
//     the matching live node
// A node that is only PARTIALLY present (right @type, but a relationship
// reference now points somewhere else, or is missing) is reported as a
// mismatch, not silently treated as a pass -- "verified" must mean the
// approved change is genuinely, fully live.

const { parseJsonLd } = require('./checkers/lightweight-jsonld')
const { diffSchemaNodes } = require('./schemaArtifactIntegrity')

function typesOf(node) {
  if (!node || node['@type'] == null) return []
  return Array.isArray(node['@type']) ? node['@type'].map(String) : [String(node['@type'])]
}

function sameTypeSet(a, b) {
  if (a.length === 0 || a.length !== b.length) return false
  const setB = new Set(b)
  return a.every(t => setB.has(t))
}

// flattenDeployed(jsonLd) -> [node, ...] -- a single deployed node, or
// every entry of a deployed @graph, normalized to a flat array so the same
// matching logic below handles both shapes identically.
function flattenDeployed(jsonLd) {
  if (jsonLd && Array.isArray(jsonLd['@graph'])) return jsonLd['@graph']
  return jsonLd ? [jsonLd] : []
}

// relationshipRefs(node) -> [{ prop, id }, ...] for every top-level
// property on `node` whose value is a bare {"@id": "..."} reference (the
// ONLY relationship shape lib/schemaPreparedWork.js's generator ever
// produces -- see its own "never inlines the referenced entity" header).
function relationshipRefs(node) {
  const refs = []
  for (const [prop, value] of Object.entries(node || {})) {
    if (prop === '@id' || prop === '@type' || prop === '@context') continue
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof value['@id'] === 'string') {
      refs.push({ prop, id: value['@id'] })
    }
  }
  return refs
}

// findLiveMatch(deployedNode, liveNodes) -> the best candidate live node
// for `deployedNode`, or null. Matches by @id first (unambiguous when the
// deployed node declared one), falling back to @type-set equality when it
// didn't.
function findLiveMatch(deployedNode, liveNodes) {
  const deployedId = typeof deployedNode['@id'] === 'string' ? deployedNode['@id'] : null
  if (deployedId) {
    return liveNodes.find(n => n && n['@id'] === deployedId) || null
  }
  const deployedTypes = typesOf(deployedNode)
  return liveNodes.find(n => sameTypeSet(deployedTypes, typesOf(n))) || null
}

// verifyDeployedSchema({ jsonLd, html }) ->
//   { ok: true, matched: [{ type, id }] } |
//   { ok: false, reason, missing: [{ type, id, why }] }
function verifyDeployedSchema({ jsonLd, html } = {}) {
  const deployedNodes = flattenDeployed(jsonLd)
  if (deployedNodes.length === 0) {
    return { ok: false, reason: 'Nothing was actually deployed to verify.', missing: [] }
  }

  const { nodes: liveNodes } = parseJsonLd(html || '')
  const missing = []
  const matched = []

  for (const deployedNode of deployedNodes) {
    const deployedTypes = typesOf(deployedNode)
    const live = findLiveMatch(deployedNode, liveNodes)
    if (!live) {
      missing.push({ type: deployedTypes.join('/'), id: deployedNode['@id'] || null, why: 'No live node with a matching @id or @type was found on the page.' })
      continue
    }
    if (!sameTypeSet(deployedTypes, typesOf(live))) {
      missing.push({ type: deployedTypes.join('/'), id: deployedNode['@id'] || null, why: `A live node with a matching @id exists, but its @type (${typesOf(live).join('/') || 'none'}) does not match the deployed @type.` })
      continue
    }
    const refs = relationshipRefs(deployedNode)
    const unresolvedRefs = refs.filter(ref => {
      const liveValue = live[ref.prop]
      const liveId = liveValue && typeof liveValue === 'object' && !Array.isArray(liveValue) ? liveValue['@id'] : null
      return liveId !== ref.id
    })
    if (unresolvedRefs.length > 0) {
      missing.push({
        type: deployedTypes.join('/'), id: deployedNode['@id'] || null,
        why: `Found live, but ${unresolvedRefs.map(r => `"${r.prop}" does not resolve to the expected @id (${r.id})`).join('; ')}.`
      })
      continue
    }
    matched.push({ type: deployedTypes.join('/'), id: deployedNode['@id'] || live['@id'] || null })
  }

  if (missing.length > 0) {
    return { ok: false, reason: `${missing.length} of ${deployedNodes.length} deployed node(s) could not be confirmed live.`, missing, matched }
  }
  return { ok: true, matched }
}

// ---------------------------------------------------------------------
// APPROVED -> LIVE VERIFICATION (2026-09-24 correction, PART 2).
//
// PROBLEM THIS CORRECTS: verifyDeployedSchema above only ever compares the
// live page against `execution_state.result.deployedJsonLd` -- the
// artifact execution CLAIMS it sent. That allows a real failure mode:
// approved artifact A -> a (now-fixed, but hypothetically future) broken
// transform produces B -> B gets deployed -> B gets verified against
// itself -> "VERIFIED," even though A (what the AM actually approved) was
// never truly published. Three genuinely different facts exist --
// APPROVED, DEPLOYED, LIVE -- and a VERIFIED result must require the
// APPROVED -> LIVE fact specifically, not merely DEPLOYED -> LIVE (which
// is trivially true by construction once something has been deployed and
// re-read back). `deployedJsonLd` remains valuable EVIDENCE of what
// execution attempted -- this does not remove or stop storing it -- it
// simply stops being the sole source of verification truth.
//
// verifyApprovedSchemaLive({approvedNodes, html}) -> the per-page, per-
// property counterpart of verifyDeployedSchema: `approvedNodes` is the
// REAL, currently-approved prepared-work artifact's own node list (see
// lib/schemaArtifactIntegrity.js#buildApprovedNodes -- re-read fresh from
// the approved opportunity_prepared_work row, never the cached
// deployedJsonLd blob), matched against the live page's own parsed JSON-LD
// by @id/@type (same matching discipline as findLiveMatch above), then
// compared PROPERTY BY PROPERTY via diffSchemaNodes in subset mode: only
// the properties the AM actually approved must match; serviceType/
// areaServed (never approved) are never required, and any ADDITIONAL
// property/node the live page happens to carry (an unrelated Yoast/
// RankMath node, or -- remotely -- an extra property on the very node we
// own) is never treated as a failure. `@context` is excluded from the
// comparison on both sides -- a live page's JSON-LD script has its own
// top-level @context, not a per-node concern this comparison needs.
function verifyApprovedSchemaLive({ approvedNodes, html } = {}) {
  const nodes = Array.isArray(approvedNodes) ? approvedNodes : []
  if (nodes.length === 0) {
    return { ok: false, reason: 'Nothing was actually approved to verify against.', missing: [] }
  }

  const { nodes: liveNodes } = parseJsonLd(html || '')
  const missing = []
  const matched = []

  for (const approvedNode of nodes) {
    const approvedTypes = typesOf(approvedNode)
    const live = findLiveMatch(approvedNode, liveNodes)
    if (!live) {
      missing.push({
        type: approvedTypes.join('/'), id: approvedNode['@id'] || null,
        why: 'No live node with a matching @id or @type was found on the page.', diffs: []
      })
      continue
    }
    const { '@context': _ea, ...expectedRest } = approvedNode
    const { '@context': _la, ...liveRest } = live
    const diffs = diffSchemaNodes(expectedRest, liveRest, '', { subsetOnly: true })
    if (diffs.length > 0) {
      missing.push({
        type: approvedTypes.join('/'), id: approvedNode['@id'] || null,
        why: `Found live, but ${diffs.length} approved propert${diffs.length === 1 ? 'y does' : 'ies do'} not match what's actually live.`,
        diffs
      })
      continue
    }
    matched.push({ type: approvedTypes.join('/'), id: approvedNode['@id'] || live['@id'] || null })
  }

  if (missing.length > 0) {
    return { ok: false, reason: `${missing.length} of ${nodes.length} approved node(s) could not be confirmed live exactly as approved.`, missing, matched }
  }
  return { ok: true, matched }
}

module.exports = { verifyDeployedSchema, verifyApprovedSchemaLive }
