// SCHEMA PAGE IDENTITY -- extracted from lib/schemaOpportunity.js (2026-09
// Schema page-work persistence pass) so this repo has exactly ONE
// normalization rule for "what page is this," reusable from both server
// code (lib/schemaOpportunity.js, lib/schemaPageWork.js) and client code
// (app/clients/[id]/SchemaWizard.js, which needs it to match a durable
// schema_page_work row's `normalized_path` back to the raw path string the
// UI's candidate-page list uses -- see that file's hydration effect).
//
// Pure, network-free, zero dependencies -- safe to import from a 'use
// client' component without pulling in @supabase/supabase-js or any
// server-only module (lib/schemaOpportunity.js itself is NOT safe for that:
// it requires lib/opportunityLifecycle.js, which requires
// lib/supabaseServer.js).
//
// Behavior is byte-for-byte unchanged from the original
// lib/schemaOpportunity.js functions -- this is a pure extraction, not a
// rewrite. lib/schemaOpportunity.js re-exports both functions from here so
// every existing caller/test keeps working unmodified.

// normalizeSchemaPagePath(path) -> a stable path key for the fingerprint.
// Structural normalization only (leading slash, no query/hash, no trailing
// slash except the root) -- never content-based, so the fingerprint never
// shifts just because a re-diagnosis produced different check results.
function normalizeSchemaPagePath(path) {
  if (!path) return '/'
  let p = String(path).split('?')[0].split('#')[0]
  if (!p.startsWith('/')) p = `/${p}`
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p || '/'
}

function buildSchemaOpportunityFingerprint(path) {
  return `schema:${normalizeSchemaPagePath(path)}`
}

module.exports = { normalizeSchemaPagePath, buildSchemaOpportunityFingerprint }
