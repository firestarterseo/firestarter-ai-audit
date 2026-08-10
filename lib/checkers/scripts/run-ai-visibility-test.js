const fs = require('fs')
const path = require('path')
const { checkAiGeoVisibility } = require('../ai-visibility-checker')

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures', name), 'utf8'))
}

// Pinned "now" so the staleness math is honest and deterministic, not
// dependent on when this script happens to run — same pattern used in
// run-content-test.js.
const now = new Date('2026-08-07T00:00:00Z')

console.log('='.repeat(70))
console.log('CASE 1: Bird Golf — real rows queried live from sourcehq (Supabase)')
console.log('Real precedent: tracking went silent after 2026-06-29 22:26 UTC.')
console.log('Expect: STALE warning, ~39 days since last run.')
console.log('='.repeat(70))
const birdGolf = readFixture('birdgolf.ai_visibility_runs.json')
const r1 = checkAiGeoVisibility(birdGolf.rows, { now })
console.log(JSON.stringify(r1, null, 2))

console.log('\n' + '='.repeat(70))
console.log('CASE 2: Tiara Yachts — real rows, client still actively tracked')
console.log('Real data: most recent run 2026-08-06, 1 day before "now".')
console.log('Expect: NO staleness warning (fresh-data negative control).')
console.log('='.repeat(70))
const tiaraYachts = readFixture('tiarayachts.ai_visibility_runs.json')
const r2 = checkAiGeoVisibility(tiaraYachts.rows, { now })
console.log(JSON.stringify(r2, null, 2))

console.log('\n' + '='.repeat(70))
console.log('CASE 3: Negative control — synthetic client mentioned nowhere,')
console.log('no run_at on any row at all.')
console.log('Expect: stale=true via "cannot verify freshness" fallback path.')
console.log('='.repeat(70))
const badRows = [
  { engine: 'chatgpt:gpt-5.4-mini', brand_mentioned: false, brand_cited: false, answer_position: 0, total_named: 5, sentiment: 'n/a' },
  { engine: 'chatgpt:gpt-5.4-mini', brand_mentioned: false, brand_cited: false, answer_position: 0, total_named: 6, sentiment: 'n/a' },
  { engine: 'gemini:gemini-3.5-flash', brand_mentioned: false, brand_cited: false, answer_position: 0, total_named: 4, sentiment: 'n/a' },
  { engine: 'gemini:gemini-3.5-flash', brand_mentioned: false, brand_cited: false, answer_position: 0, total_named: 7, sentiment: 'n/a' },
  { engine: 'perplexity:sonar-pro', brand_mentioned: false, brand_cited: false, answer_position: 0, total_named: 5, sentiment: 'n/a' }
]
const r3 = checkAiGeoVisibility(badRows, { now })
console.log(JSON.stringify(r3, null, 2))

console.log('\n' + '='.repeat(70))
console.log('CASE 4: No tracking set up at all (empty)')
console.log('='.repeat(70))
const r4 = checkAiGeoVisibility([], { now })
console.log(JSON.stringify(r4, null, 2))
