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

// extractBusinessProfile(html, pageUrl) -> {
//   name, category, categoryType, city, region, domain
// } or null if no usable business schema is present at all (e.g. a page
// with zero structured data -- the Schema & Structure pillar will already
// have flagged that as its own finding; the snapshot checker should treat
// a null profile as "can't generate prompts, not enough info," not crash.
function extractBusinessProfile(html, pageUrl) {
  const { nodes } = parseJsonLd(html)
  const { node, type } = findBusinessNode(nodes)
  if (!node || !node.name) return null

  const address = node.address && typeof node.address === 'object' ? node.address : {}
  const domain = hostnameOf(node.url || pageUrl || '')

  return {
    name: node.name,
    categoryType: type,
    category: CATEGORY_LABELS[type] || 'business',
    city: address.addressLocality || null,
    region: address.addressRegion || null,
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

module.exports = { extractBusinessProfile, generatePrompts, CATEGORY_LABELS }
