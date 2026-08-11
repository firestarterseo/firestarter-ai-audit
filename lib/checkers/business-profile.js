// Derives a minimal "who is this business" profile from a page's JSON-LD,
// for use as input to the AI-visibility snapshot checker (ai-visibility-
// snapshot-checker.js). This is the answer to "how would we even know what
// terms to check on a brand-new lead's first audit" — we don't ask the lead
// anything, we reuse what the Schema & Structure checker already extracts.
//
// Zero dependencies. Reuses lightweight-jsonld.js's parseJsonLd, same as
// checker.js does.

const { parseJsonLd, typesOf } = require('./lightweight-jsonld')

// Priority order matters: more specific business types first. A page might
// carry both a generic Organization node and a specific AccountingService/
// Attorney/etc. node (this is the normal Yoast @graph shape) -- we want the
// specific one's address/category, falling back to Organization only if
// nothing more specific is present.
const BUSINESS_TYPE_PRIORITY = [
  'AccountingService', 'Attorney', 'ProfessionalService', 'LocalBusiness', 'Organization'
]

// Rough, deliberately simple schema-type -> plain-English category label.
// This is a first-pass heuristic: schema.org's @type is a general bucket
// ("AccountingService"), not the specific service a human strategist would
// pick ("tax preparation service"). Good enough to seed a snapshot prompt
// automatically; not a substitute for a hand-tuned prompt list.
const CATEGORY_LABELS = {
  AccountingService: 'accounting and tax service',
  Attorney: 'attorney',
  ProfessionalService: 'professional service',
  LocalBusiness: 'local business',
  Organization: 'business'
}

function findBusinessNode(nodes) {
  for (const type of BUSINESS_TYPE_PRIORITY) {
    const match = nodes.find(n => typesOf(n).includes(type))
    if (match) return { node: match, type }
  }
  return { node: null, type: null }
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch (e) {
    return null
  }
}

// extractBusinessProfile(html, pageUrl, overrides) -> {
//   name, category, categoryType, city, region, domain
// } or null if there's neither usable page schema NOR client-provided
// overrides to build a profile from.
//
// `overrides` is the client record's own name/city/region/category fields
// (whatever a strategist typed into the "Add client" form). Those are
// preferred field-by-field over whatever's scraped from the page's JSON-LD,
// for two reasons found in practice, not in theory: (1) most business
// schema nodes -- especially a generic Organization node with no more
// specific subtype -- don't carry address fields at all, so city/region
// come back null and the snapshot prompt silently degrades to a useless
// "best business" query instead of "best <real category> in <real city>";
// (2) a strategist's own category ("Digital Marketing agency") is more
// accurate than the coarse schema-type -> label heuristic below. A client
// with zero page schema but a filled-in form can still get a meaningful
// profile purely from overrides.
function extractBusinessProfile(html, pageUrl, overrides = {}) {
  const { nodes } = parseJsonLd(html)
  const { node, type } = findBusinessNode(nodes)

  const name = overrides.name || node?.name
  if (!name) return null

  const address = node?.address && typeof node.address === 'object' ? node.address : {}
  const domain = hostnameOf(node?.url || pageUrl || '')

  return {
    name,
    categoryType: type,
    category: overrides.category || CATEGORY_LABELS[type] || 'business',
    city: overrides.city || address.addressLocality || null,
    region: overrides.region || address.addressRegion || null,
    domain
  }
}

// generatePrompts(profile) -> string[]
// Deliberately small (one primary, natural "best X in Y" search) for the v1
// snapshot check -- keeps the first build simple to verify and cheap to run.
// Easy to extend with more prompt variations (name + "reviews", "near me",
// etc.) once the primary path is proven against a real Cloro response.
function generatePrompts(profile) {
  if (!profile) return []
  const { category, city, region } = profile
  const place = city && region ? `${city}, ${region}` : (city || region || null)

  const prompts = []
  if (place) {
    prompts.push(`best ${category} in ${place}`)
  } else {
    prompts.push(`best ${category}`)
  }
  return prompts
}

// generatePromptCandidates(profile) -> string[] (up to 7)
// A single guessed phrase is not a reliable AI-visibility signal on its
// own -- verified in practice: the same business scored 0/5 engines on one
// auto-generated phrase and 3/5 on a more natural real-world phrasing,
// same day. This generates a small, varied basket from the same
// category/city/region/name data instead of one guess, as the zero-effort
// default for every client. A strategist can review/edit this basket down
// to a confirmed set of 3-7 terms (see the test-prompts API/UI) for
// clients worth that extra attention; unconfirmed clients still get this
// full basket automatically rather than a single roll of the dice.
function generatePromptCandidates(profile) {
  if (!profile || !profile.name) return []
  const { name, category, city, region } = profile
  const cat = category || 'business'
  const place = city && region ? `${city}, ${region}` : (city || region || null)

  const candidates = []
  if (place) candidates.push(`best ${cat} in ${place}`)
  if (city) {
    candidates.push(`${cat} ${city}`)
    candidates.push(`${city} ${cat}`)
    candidates.push(`best ${cat} ${city}`)
  }
  candidates.push(`${cat} near me`)
  candidates.push(name)
  if (!place) candidates.push(`best ${cat}`)

  // De-dupe (short city/category combos can collide) and cap at 7.
  return Array.from(new Set(candidates.filter(Boolean))).slice(0, 7)
}

module.exports = { extractBusinessProfile, generatePrompts, generatePromptCandidates, CATEGORY_LABELS }
