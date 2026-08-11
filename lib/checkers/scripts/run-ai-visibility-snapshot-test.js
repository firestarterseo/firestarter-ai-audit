const fs = require('fs')
const path = require('path')
const { buildHtml } = require('../build-fixture-html')
const { extractBusinessProfile, generatePrompts } = require('../business-profile')
const { checkAiVisibilitySnapshot } = require('../ai-visibility-snapshot-checker')

const now = new Date('2026-08-07T00:00:00Z')

const synthetic = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/cloro-synthetic-responses.json'), 'utf8'))
const realChatgpt = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/cloro-live-captures/chatgpt-denvertaxadvisor.json'), 'utf8'))
const realGoogle = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/cloro-live-captures/google-denvertaxadvisor.json'), 'utf8'))
const realGemini = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/cloro-live-captures/gemini-denvertaxadvisor.json'), 'utf8'))
const realPerplexity = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/cloro-live-captures/perplexity-denvertaxadvisor.json'), 'utf8'))
const realCopilot = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/cloro-live-captures/copilot-denvertaxadvisor.json'), 'utf8'))

// Mock caller replaying the synthetic, documented-shape responses -- see
// fixtures/cloro-synthetic-responses.json's _note. gemini/perplexity/
// copilot are still unverified against a real call, so CASES 1-4 below
// still exercise the parsing logic against these synthetic responses.
function makeMockCaller(caseName) {
  return async function mockCaller(engine, promptText) {
    const responses = synthetic[caseName]
    return responses[engine] || { success: false, error: 'no mock response for this engine' }
  }
}

// Real caller replaying all five genuine live captures (chatgpt, google,
// gemini, perplexity, copilot) -- see fixtures/cloro-live-captures/*.json
// for how/when each was run. All five engines are now verified against
// real Cloro output; no synthetic/faked responses remain in this path.
async function realCaller(engine, promptText) {
  if (engine === 'chatgpt') return realChatgpt.response
  if (engine === 'google') return realGoogle.response
  if (engine === 'gemini') return realGemini.response
  if (engine === 'perplexity') return realPerplexity.response
  if (engine === 'copilot') return realCopilot.response
  return { success: false, error: `unknown engine: ${engine}` }
}

async function main() {
  // Real business profile, derived from Denver Tax Advisor's actual
  // captured JSON-LD (fixtures/denvertaxadvisor.jsonld.json) -- same
  // fixture the Schema & Structure checker's tests use. This is the real
  // part of this test: proving the auto-derived-prompt approach produces a
  // sane prompt from real structured data, with no manual input.
  const dtaJsonLd = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/denvertaxadvisor.jsonld.json'), 'utf8'))
  const dtaHtml = buildHtml(dtaJsonLd, { title: 'Denver Tax Advisor (live JSON-LD)' })
  const profile = extractBusinessProfile(dtaHtml, 'https://denvertaxadvisor.com/')
  const prompts = generatePrompts(profile)

  console.log('='.repeat(70))
  console.log('Auto-derived profile + prompt (from real Denver Tax Advisor schema)')
  console.log('='.repeat(70))
  console.log(JSON.stringify({ profile, prompts }, null, 2))

  console.log('\n' + '='.repeat(70))
  console.log('CASE 1: Positive -- mentioned/cited/positive across most engines')
  console.log('(synthetic response content -- see fixture _note; real Cloro call blocked')
  console.log('by sandbox network egress + disconnected browser, pending Playground test)')
  console.log('='.repeat(70))
  const r1 = await checkAiVisibilitySnapshot(profile, prompts, { caller: makeMockCaller('positive_case'), now })
  console.log(JSON.stringify(r1, null, 2))

  console.log('\n' + '='.repeat(70))
  console.log('CASE 2: Negative -- absent from every engine queried')
  console.log('='.repeat(70))
  const r2 = await checkAiVisibilitySnapshot(profile, prompts, { caller: makeMockCaller('negative_case'), now })
  console.log(JSON.stringify(r2, null, 2))

  console.log('\n' + '='.repeat(70))
  console.log('CASE 3: Mixed -- mentioned but rarely cited, one engine call fails')
  console.log('='.repeat(70))
  const r3 = await checkAiVisibilitySnapshot(profile, prompts, { caller: makeMockCaller('mixed_with_failure_case'), now })
  console.log(JSON.stringify(r3, null, 2))

  console.log('\n' + '='.repeat(70))
  console.log('CASE 4: No usable schema at all -- can\'t generate a prompt')
  console.log('='.repeat(70))
  const noSchemaHtml = fs.readFileSync(path.join(__dirname, '../fixtures/no-schema.html'), 'utf8')
  const noProfile = extractBusinessProfile(noSchemaHtml, 'https://example.com/')
  const r4 = await checkAiVisibilitySnapshot(noProfile, generatePrompts(noProfile), { caller: makeMockCaller('positive_case'), now })
  console.log(JSON.stringify(r4, null, 2))

  console.log('\n' + '='.repeat(70))
  console.log('CASE 5: REAL live capture -- chatgpt, google, gemini, perplexity via')
  console.log('Cloro Playground, 2026-08-10 (a real copilot capture also exists in')
  console.log('fixtures/ but copilot was dropped from DEFAULT_ENGINES on 2026-08-11')
  console.log('per direct feedback -- "no one cares about copilot" -- so it is no')
  console.log('longer queried by default; realCaller above still supports replaying')
  console.log('it if ever needed again). This is the actual, fully-verified')
  console.log('real-world run against the engines this project now queries.')
  console.log('='.repeat(70))
  const realNow = new Date('2026-08-10T00:00:00Z')
  const r5 = await checkAiVisibilitySnapshot(profile, prompts, { caller: realCaller, now: realNow })
  console.log(JSON.stringify(r5, null, 2))
}

main()
