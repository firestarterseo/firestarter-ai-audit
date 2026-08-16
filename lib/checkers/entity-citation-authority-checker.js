// Entity & Citation Authority pillar checker.
//
// Added 2026-08-16 as the 6th pillar (see PILLAR_ORDER in
// app/clients/[id]/page.js and the pillar/opportunities CHECK constraints
// in Supabase). Sits right after Schema & Structure, since both pillars
// are ultimately about the same thing from two different angles: making
// the business a legible, verifiable entity. Schema does it on-site
// (structured markup Google/AI can parse directly); this pillar does it
// off-site (whether independent third parties actually vouch for the
// business anywhere Google/AI would notice).
//
// Deliberately reuses two data sources this project ALREADY collects and
// already pays for, rather than adding a new vendor:
//
//   1. Real backlinks from recognized authority domains (Ahrefs, already
//      integrated for Competitive Position/Content Authority) -- see
//      getAuthorityBacklinks() in lib/checkers/ahrefs.js, added alongside
//      this checker. getBacklinksStats (used by content-checker.js's
//      Referring Domains check) only ever returns aggregate counts; this
//      pillar needs to know WHICH domains link, cross-referenced against
//      lib/authorityDomains.js's curated list (Clutch, G2, Trustpilot,
//      BBB, etc.) -- a real backlink from one of those is a fundamentally
//      different signal than backlink volume alone.
//
//   2. AI-citation authority tier (ai_visibility_tracked_runs, already
//      collected weekly for AI & GEO Visibility). That pillar's own
//      rowCitationTier() (see ai-visibility-checker.js) already
//      distinguishes "cited from a recognized authority domain" as its top
//      tier -- but AI & GEO Visibility's score blends that signal together
//      with mention rate, answer position, and sentiment, so a client can
//      never see "how much of my AI presence is backed by a real authority
//      citation" as its own number. This pillar isolates just that one
//      signal and gives it its own score.
//
// Both signals are optional/independent -- a client with an Ahrefs key but
// no AI-visibility tracking history yet (or vice versa) still gets graded
// on whichever signal IS available, at half the possible points (the
// `partial`/`possiblePoints` contract already established elsewhere in
// this project, e.g. Technical Foundation). Only when NEITHER signal is
// available does this pillar return the standard "not yet graded" empty
// contract (grade/score both null, excluded from the overall average) --
// same as every other data-gap case in this project.

const { getAuthorityBacklinks } = require('./ahrefs')
const { isAuthorityDomain } = require('../authorityDomains')

function scoreToGrade(score) {
  if (score >= 97) return 'A+'
  if (score >= 93) return 'A'
  if (score >= 90) return 'A-'
  if (score >= 87) return 'B+'
  if (score >= 83) return 'B'
  if (score >= 80) return 'B-'
  if (score >= 77) return 'C+'
  if (score >= 73) return 'C'
  if (score >= 70) return 'C-'
  if (score >= 67) return 'D+'
  if (score >= 63) return 'D'
  if (score >= 60) return 'D-'
  return 'F'
}

// authorityUrlsForRow(row) -> string[] of this row's third-party source
// URLs that are on the recognized-authority list. Mirrors the
// third-party-URL derivation ai-visibility-checker.js's rowCitationTier()
// already uses (preferring the persisted thirdPartySourceUrls field,
// falling back to sourceUrls minus ownDomainSourceUrls for older rows that
// predate it) -- kept as a literal duplicate rather than a shared import,
// same "these two checkers are intentionally decoupled" reasoning that
// file's own header comment already gives for ENGINE_WEIGHTS.
function authorityUrlsForRow(row) {
  if (!row.brand_mentioned || row.sentiment === 'negative') return []
  const raw = row.raw || {}
  const ownUrls = Array.isArray(raw.ownDomainSourceUrls) ? raw.ownDomainSourceUrls : []
  const thirdPartyUrls = Array.isArray(raw.thirdPartySourceUrls)
    ? raw.thirdPartySourceUrls
    : (Array.isArray(raw.sourceUrls) ? raw.sourceUrls.filter(u => !ownUrls.includes(u)) : [])
  return thirdPartyUrls.filter(isAuthorityDomain)
}

async function checkEntityCitationAuthority(client, { backlinkApiKey = null, aiVisibilityRows = [] } = {}) {
  const evidence = []
  const findings = []
  const recommendations = []
  const checks = []
  const issues = []
  let earned = 0
  let possible = 0

  const domain = client.domain || client.url

  // --- Signal 1: real backlinks from recognized authority domains (50 pts) ---
  const backlinkResult = await getAuthorityBacklinks(domain, { apiKey: backlinkApiKey })
  if (backlinkApiKey && !backlinkResult.error) {
    possible += 50
    const authorityDomainsFound = backlinkResult.authorityReferringDomains
    const count = authorityDomainsFound.length
    let checkEarned = 0
    if (count >= 3) checkEarned = 50
    else if (count === 2) checkEarned = 35
    else if (count === 1) checkEarned = 20
    earned += checkEarned

    if (count > 0) {
      evidence.push(`${count} recognized authority domain(s) have a real backlink to this site: ${authorityDomainsFound.map(d => d.domain).join(', ')} (via Ahrefs).`)
      checks.push({ label: 'Real backlink(s) from a recognized authority domain', status: 'pass' })
    } else {
      evidence.push(`No backlinks found from any recognized authority domain, out of ${backlinkResult.totalReferringDomainsChecked ?? 0} referring domain(s) checked (via Ahrefs).`)
      checks.push({ label: 'Real backlink(s) from a recognized authority domain', status: 'fail' })
    }
    // Below the full-credit threshold (3+) -- flag as room to improve even
    // when count is 1 or 2, not just when it's zero. Matches the checker.js
    // convention of still surfacing a recommendation short of a perfect
    // check (e.g. its missingFields message), not just an all-or-nothing
    // pass/fail comment.
    if (count < 3) {
      const rec = count === 0
        ? 'Claim or build a profile on a review platform or directory relevant to this business\'s industry (e.g. Clutch, G2, Trustpilot, BBB, Angi, Healthgrades) that already carries real authority in search and AI systems -- a genuine backlink from one outweighs additional volume of any other kind.'
        : `${count} recognized authority domain(s) already link here -- building a presence on 1-2 more (e.g. Clutch, G2, Trustpilot, BBB, Angi, Healthgrades, whichever fits this business's industry) would close the rest of this gap.`
      findings.push(count === 0
        ? 'No real backlinks from a recognized third-party authority domain found.'
        : `Only ${count} recognized authority domain(s) currently link to this site.`)
      recommendations.push(rec)
      issues.push({
        severity: count === 0 ? 'moderate' : 'minor',
        message: count === 0
          ? 'No backlinks from a recognized authority domain (review platform, press, or directory).'
          : `Only ${count} recognized authority domain(s) link to this site.`,
        why: 'Search engines and AI systems weigh a link from a widely-recognized authority far more heavily than backlink volume from unrelated sites or content published only on the business\'s own domain.',
        recommendation: rec
      })
    }
  } else {
    checks.push({ label: 'Real backlink(s) from a recognized authority domain', status: 'not_verified' })
    evidence.push(
      backlinkApiKey
        ? `Could not check backlinks this run: ${backlinkResult.error?.message || 'unknown error'}.`
        : 'AHREFS_API_KEY not configured -- the real-backlink authority signal was not checked this run.'
    )
  }

  // --- Signal 2: AI-citation authority tier (50 pts) ---
  const mentioned = (aiVisibilityRows || []).filter(r => r.brand_mentioned)
  if (aiVisibilityRows && aiVisibilityRows.length > 0 && mentioned.length > 0) {
    possible += 50
    const authorityCitedRows = mentioned.filter(r => authorityUrlsForRow(r).length > 0)
    const share = authorityCitedRows.length / mentioned.length
    const checkEarned = Math.round(share * 50)
    earned += checkEarned

    const citedDomains = [...new Set(authorityCitedRows.flatMap(authorityUrlsForRow).map(u => {
      try { return new URL(u).hostname.replace(/^www\./, '') } catch (e) { return u }
    }))]

    evidence.push(`AI engines cited a recognized authority domain in ${authorityCitedRows.length} of ${mentioned.length} mention(s) tracked (${Math.round(share * 100)}%)${citedDomains.length ? `: ${citedDomains.join(', ')}` : ''}.`)
    checks.push({ label: 'Cited by AI engines from a recognized authority domain', status: authorityCitedRows.length > 0 ? 'pass' : 'fail' })

    // Flagged any time share is below 100%, not just when it's exactly
    // zero -- same "still surface a recommendation short of a perfect
    // check" reasoning as the backlink signal above.
    if (share < 1) {
      const rec = share === 0
        ? 'The same authority-domain presence this pillar\'s backlink check recommends would also close this gap -- AI engines already draw on real-world sources like review platforms and press when answering, not just a business\'s own site.'
        : `Authority-domain citations show up in ${Math.round(share * 100)}% of tracked mentions already -- building that presence further would raise the share closer to consistent.`
      findings.push(share === 0
        ? 'When AI engines mention this business, none of the tracked runs cited a recognized authority domain.'
        : `AI engines cite a recognized authority domain in only ${Math.round(share * 100)}% of mentions tracked -- inconsistent, not absent.`)
      recommendations.push(rec)
      issues.push({
        severity: share === 0 ? 'moderate' : 'minor',
        message: share === 0
          ? 'AI engines mention this business but never cite a recognized authority domain when they do.'
          : `Only ${Math.round(share * 100)}% of tracked AI mentions cite a recognized authority domain.`,
        why: 'A citation from a recognized authority (a review platform, press outlet, or industry directory) is the strongest form of third-party validation AI engines draw on -- without one, even a good mention rate rests on weaker signals (self-citation or a plain third-party mention).',
        recommendation: rec
      })
    }
  } else {
    checks.push({ label: 'Cited by AI engines from a recognized authority domain', status: 'not_verified' })
    evidence.push(
      aiVisibilityRows && aiVisibilityRows.length > 0
        ? 'This business was never mentioned in any tracked AI-visibility run -- no citations to check for authority-domain sourcing.'
        : 'No AI-visibility tracking data available yet for this client -- the AI-citation authority signal was not checked this run.'
    )
  }

  if (possible === 0) {
    return {
      grade: null,
      score: null,
      noData: true,
      finding: 'Not yet graded -- neither an Ahrefs API key nor any AI-visibility tracking data was available to check real third-party authority signals for this client.',
      recommendation: 'Configure AHREFS_API_KEY and/or begin AI-visibility tracking for this client so this pillar can check for real backlinks and citations from recognized authority domains.',
      evidence,
      checks,
      issues,
      _raw: {}
    }
  }

  const partial = possible < 100
  const score = Math.round((earned / possible) * 100)

  const finding = findings.length > 0
    ? findings.join(' ')
    : 'This business has real, verifiable third-party authority backing it, both in backlinks and in what AI engines cite when they mention it.'
  const recommendation = recommendations.length > 0
    ? recommendations.join(' ')
    : 'No action needed -- maintain existing authority-domain relationships and monitor for new citation opportunities.'

  return {
    grade: scoreToGrade(score),
    score,
    partial,
    possiblePoints: possible,
    finding,
    recommendation,
    evidence,
    checks,
    issues,
    _raw: {
      authorityReferringDomains: backlinkResult.authorityReferringDomains || [],
      totalReferringDomainsChecked: backlinkResult.totalReferringDomainsChecked,
      backlinkError: backlinkResult.error,
      aiMentionCount: mentioned.length,
      aiAuthorityCitationShare: mentioned.length > 0 ? mentioned.filter(r => authorityUrlsForRow(r).length > 0).length / mentioned.length : null
    }
  }
}

module.exports = { checkEntityCitationAuthority, scoreToGrade }
