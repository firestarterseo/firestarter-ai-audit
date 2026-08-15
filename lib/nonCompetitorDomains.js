// Domains that should NEVER be treated as a "competitor," regardless of how
// often they show up in AI-citation data or Ahrefs organic-competitors
// overlap -- directories, review platforms, press, and social networks are
// not competing businesses, they're places a competing business (or this
// client) might have a LISTING. A citation of yelp.com tells us "some
// business's Yelp profile got cited," not which business, so it's useless
// (and actively misleading) as a competitor-domain signal either way.
//
// This has heavy overlap with lib/authorityDomains.js on purpose -- most
// domains that are a strong THIRD-PARTY CITATION SOURCE (Forbes, G2, Yelp)
// are, for the same underlying reason, not a real competing business.
// Kept as a separate list rather than importing AUTHORITY_DOMAINS directly,
// since the two lists serve different questions ("is this citation
// authoritative" vs "is this domain a real business we should compare
// against") and may diverge over time -- e.g. a niche industry directory
// could reasonably be added here without belonging on the authority list,
// or vice versa.
const { AUTHORITY_DOMAINS } = require('./authorityDomains')

const SOCIAL_AND_GENERIC_PLATFORM_DOMAINS = new Set([
  // Social / video platforms -- a business's social profile, not its site
  'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com',
  'youtube.com', 'tiktok.com', 'pinterest.com', 'nextdoor.com', 'reddit.com',
  // Generic directories / search / mapping -- aggregators, not businesses
  'yellowpages.com', 'superpages.com', 'manta.com', 'mapquest.com',
  'bing.com', 'chamberofcommerce.com', 'foursquare.com', 'apple.com'
])

// Agency directories, B2B data brokers, and local press -- found 2026-08-13
// via real Firestarter SEO citation data. Each of these got auto-detected
// as a "competitor" even though the actual citation was either a roundup
// article naming several agencies (builtincolorado.com, agencies.semrush.com
// -- Semrush's own agency directory subdomain) or a directory/press PROFILE
// of Firestarter itself (designrush.com, zoominfo.com, techfinder.net,
// coloradoan.com's feature article) -- i.e. evidence the client showed up
// somewhere, not evidence of a distinct competing business at that domain.
// See competitorDetection.js's brand-slug-in-URL heuristic for the
// generalizable half of this fix -- it independently catches the
// profile/press-mention cases; this static list is still needed for
// roundup-article domains where the citation URL never contains the
// client's own name at all (builtincolorado.com, agencies.semrush.com).
// This list will need similar one-off additions as other clients in other
// cities surface their own local newspaper/directory -- there's no fully
// general way to detect "this is press/a directory" from the URL alone.
const AGENCY_DIRECTORY_AND_PRESS_DOMAINS = new Set([
  'designrush.com', 'zoominfo.com', 'techfinder.net',
  'agencies.semrush.com', 'coloradoan.com'
])

// MULTI_INDUSTRY_DIRECTORY_DOMAINS -- added 2026-08-15, per direct client
// request: "Can we create a large list excluding directories like this for
// all industries? nothing analogous exists yet for legal or home
// services." This is a deliberate, one-time departure from this file's own
// previously-stated philosophy (see AGENCY_DIRECTORY_AND_PRESS_DOMAINS's
// comment above: "expand this list over time as real client citations
// surface sources worth recognizing, rather than trying to guess
// exhaustively now"). That reactive approach is right for ambiguous,
// long-tail cases (a random local roundup blog, a niche regional
// directory) where getting it wrong either way is low-stakes and evidence
// is the only way to know. It's the WRONG approach for well-known,
// unambiguous, single-purpose directory/marketplace platforms: FindLaw is
// a lawyer directory, not a law firm, whether or not a Firestarter client
// happens to practice law yet. Waiting for a real divorce-attorney or
// home-services client to get miscounted first (the exact bug already
// found and fixed once for agencies -- designrush.com/zoominfo.com/
// techfinder.net) is a needless, avoidable repeat of the same failure
// mode, not a meaningfully more careful process. Each domain below is
// included because its entire business model is "we are a directory/
// marketplace/aggregator for businesses in this vertical," which is a
// static, independently-verifiable fact -- not a guess about any specific
// client's situation -- so the risk of proactively seeding it is very low
// (unlike, say, guessing which SPECIFIC agencies or firms are Firestarter
// clients' competitors, which genuinely does need real evidence).
//
// Organized by vertical for readability/maintainability, but all merged
// into one flat NON_COMPETITOR_DOMAINS set below -- there's no per-vertical
// behavior difference, a client only ever needs the union of all of them
// since isNonCompetitorDomain() doesn't know (and doesn't need to know)
// what industry a given client is in.
const LEGAL_DIRECTORY_DOMAINS = new Set([
  'findlaw.com', 'justia.com', 'martindale.com', 'superlawyers.com',
  'lawyers.com', 'legalmatch.com', 'nolo.com', 'lawinfo.com',
  'avvo.com', 'rocketlawyer.com', 'lawyer.com'
])

const HOME_SERVICES_DIRECTORY_DOMAINS = new Set([
  'thumbtack.com', 'porch.com', 'houzz.com', 'taskrabbit.com',
  'networx.com', 'homeguide.com', 'homeadvisor.com', 'angi.com',
  'buildzoom.com', 'fixr.com'
])

const MEDICAL_DIRECTORY_DOMAINS = new Set([
  'healthgrades.com', 'zocdoc.com', 'webmd.com', 'vitals.com',
  'ratemds.com', 'caredash.com', 'wellness.com', 'psychologytoday.com',
  'doctor.com', 'findatopdoc.com', 'sharecare.com'
])

const REAL_ESTATE_DIRECTORY_DOMAINS = new Set([
  'zillow.com', 'realtor.com', 'redfin.com', 'trulia.com', 'homes.com',
  'apartments.com', 'loopnet.com', 'movoto.com', 'realestate.com'
])

const AUTOMOTIVE_DIRECTORY_DOMAINS = new Set([
  'cars.com', 'cargurus.com', 'edmunds.com', 'carfax.com',
  'autotrader.com', 'dealerrater.com', 'kbb.com', 'truecar.com'
])

const FINANCIAL_SERVICES_DIRECTORY_DOMAINS = new Set([
  'nerdwallet.com', 'bankrate.com', 'valuepenguin.com',
  'thebalancemoney.com', 'insurance.com', 'policygenius.com',
  'creditkarma.com', 'wallethub.com'
])

const HOSPITALITY_DIRECTORY_DOMAINS = new Set([
  'opentable.com', 'tripadvisor.com', 'resy.com', 'booking.com',
  'expedia.com', 'zomato.com'
])

const EDUCATION_DIRECTORY_DOMAINS = new Set([
  'niche.com', 'greatschools.org', 'ratemyprofessors.com',
  'collegeboard.org', 'noodle.com'
])

// General e-commerce marketplaces -- relevant for retail/e-commerce
// clients the same way a directory is relevant for a service business: a
// citation of "sold on Amazon" or an Etsy shop listing is evidence of a
// channel the client (or anyone) sells through, not a distinct competing
// retailer.
const MARKETPLACE_DOMAINS = new Set([
  'amazon.com', 'etsy.com', 'ebay.com', 'walmart.com', 'target.com'
])

const MULTI_INDUSTRY_DIRECTORY_DOMAINS = new Set([
  ...LEGAL_DIRECTORY_DOMAINS,
  ...HOME_SERVICES_DIRECTORY_DOMAINS,
  ...MEDICAL_DIRECTORY_DOMAINS,
  ...REAL_ESTATE_DIRECTORY_DOMAINS,
  ...AUTOMOTIVE_DIRECTORY_DOMAINS,
  ...FINANCIAL_SERVICES_DIRECTORY_DOMAINS,
  ...HOSPITALITY_DIRECTORY_DOMAINS,
  ...EDUCATION_DIRECTORY_DOMAINS,
  ...MARKETPLACE_DOMAINS
])

const NON_COMPETITOR_DOMAINS = new Set([
  ...AUTHORITY_DOMAINS,
  ...SOCIAL_AND_GENERIC_PLATFORM_DOMAINS,
  ...AGENCY_DIRECTORY_AND_PRESS_DOMAINS,
  ...MULTI_INDUSTRY_DIRECTORY_DOMAINS
])

// Domain-shaped patterns, not just exact hostnames -- "Built In" runs one
// tech-company/jobs directory per metro area (builtincolorado.com,
// builtinboston.com, builtinaustin.com, ...), all the same underlying
// directory, not a competing business. A flat list would need a new entry
// every time a client in a new city surfaces a different regional edition;
// this pattern catches the whole network at once.
const NON_COMPETITOR_DOMAIN_PATTERNS = [
  /^builtin[a-z]+\.com$/
]

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch (e) {
    return null
  }
}

// normalizeDomain(domain) -> hostname, accepting either a bare domain
// ("www.firestarterseo.com") or a full URL. Client records in this
// project store `domain` inconsistently -- sometimes with a leading
// "www.", sometimes without (confirmed directly against real rows:
// Firestarter SEO's is "www.firestarterseo.com", Denver SEO Pros' is
// "denverseopro.com") -- so any code comparing a citation's hostnameOf()
// (which always strips "www.") against a raw client.domain string has to
// normalize client.domain the same way first, or a client's own domain
// silently fails to match itself and gets detected as its own
// "competitor" (a real bug found 2026-08-13 via exactly that mismatch).
function normalizeDomain(domain) {
  if (!domain) return null
  const withProtocol = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`
  return hostnameOf(withProtocol)
}

// isNonCompetitorDomain(url) -> true if this URL's hostname is a known
// directory/press/social/review platform (or a subdomain/pattern-match of
// one) -- i.e. NOT a candidate for "this is a competing business's own
// site."
function isNonCompetitorDomain(url) {
  const host = hostnameOf(url)
  if (!host) return true // an unparseable URL can't be a usable competitor domain either
  if (NON_COMPETITOR_DOMAINS.has(host)) return true
  for (const d of NON_COMPETITOR_DOMAINS) {
    if (host.endsWith(`.${d}`)) return true
  }
  return NON_COMPETITOR_DOMAIN_PATTERNS.some(p => p.test(host))
}

module.exports = { NON_COMPETITOR_DOMAINS, MULTI_INDUSTRY_DIRECTORY_DOMAINS, isNonCompetitorDomain, hostnameOf, normalizeDomain }
