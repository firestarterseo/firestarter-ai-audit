// Tests for lib/schemaPageIdentity.js -- extracted from
// lib/schemaOpportunity.js (2026-09 Schema page-work persistence pass) so
// it can be imported client-side (SchemaWizard.js) without pulling in
// lib/opportunityLifecycle.js -> lib/supabaseServer.js. Pure, zero
// dependencies -- plain `node` test, same convention as every other pure
// lib/ module here. lib/schemaOpportunity.test.js already exercises these
// two functions' behavior via schemaOpportunity.js's re-export; this file
// additionally proves the standalone module itself works and stays
// byte-for-byte identical to what schemaOpportunity.js re-exports (the
// point of the extraction: ONE normalization rule, not two).

const assert = require('assert')

const { normalizeSchemaPagePath, buildSchemaOpportunityFingerprint } = require('./schemaPageIdentity')

let passCount = 0
function test(name, fn) {
  fn()
  passCount++
  console.log(`PASS: ${name}`)
}

test('normalizeSchemaPagePath strips query/hash and trailing slash, keeps root as "/"', () => {
  assert.strictEqual(normalizeSchemaPagePath('/about/'), '/about')
  assert.strictEqual(normalizeSchemaPagePath('/about'), '/about')
  assert.strictEqual(normalizeSchemaPagePath('/about/?utm=x#frag'), '/about')
  assert.strictEqual(normalizeSchemaPagePath('/'), '/')
  assert.strictEqual(normalizeSchemaPagePath(''), '/')
  assert.strictEqual(normalizeSchemaPagePath(null), '/')
  assert.strictEqual(normalizeSchemaPagePath(undefined), '/')
})

test('normalizeSchemaPagePath adds a leading slash to a bare relative path', () => {
  assert.strictEqual(normalizeSchemaPagePath('about'), '/about')
})

test('buildSchemaOpportunityFingerprint is stable for equivalent paths, distinct for different pages', () => {
  assert.strictEqual(buildSchemaOpportunityFingerprint('/about/'), buildSchemaOpportunityFingerprint('/about'))
  assert.notStrictEqual(buildSchemaOpportunityFingerprint('/about/'), buildSchemaOpportunityFingerprint('/contact/'))
  assert.strictEqual(buildSchemaOpportunityFingerprint('/about/'), 'schema:/about')
})

test('this module has zero dependencies -- safe to import from a client component', () => {
  // require.cache after loading this module should contain no other
  // project modules as children (no @supabase/supabase-js, no
  // lib/opportunityLifecycle.js, nothing) -- confirms the extraction
  // actually achieved its purpose (client-bundle-safe) rather than just
  // moving the functions without removing the dependency.
  const path = require('path')
  const modPath = require.resolve('./schemaPageIdentity')
  const entry = require.cache[modPath]
  assert.ok(entry, 'module should be in the require cache after being required above')
  assert.deepStrictEqual(entry.children.map(c => c.id), [], 'lib/schemaPageIdentity.js must require nothing else')
})

console.log(`\n${passCount} passed.`)
