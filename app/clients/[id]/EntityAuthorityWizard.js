'use client'

import { useState } from 'react'
import { CheckRow, IssuesList, pillarHeadline, StepChips } from './PillarsBoard'

// Entity & Citation Authority's wizard-style pillar detail -- same port
// pattern SchemaWizard.js / TechnicalFoundationWizard.js / ContentAuthorityWizard.js
// established, applied to workflow-mockup.html's #pane-entity. This pillar
// went from "not yet built" (a proposed concept pane, GBP/Person-schema
// illustrative content only) to a real, wired-in 6th pillar mid-session --
// see lib/checkers/entity-citation-authority-checker.js's own header. That
// checker measures two REAL signals this project already collects/pays
// for: real backlinks from a recognized authority domain (Ahrefs), and
// what share of tracked AI-visibility mentions cite one. It does NOT check
// Google Business Profile claim status, review/directory profile
// completeness, or Person schema/author bylines -- the mockup's specific
// stat-pill labels ("Claimed: GBP", "Partial: 3/7 review & directory
// profiles", "Missing: 0 pages with Person schema") describe that broader,
// still-illustrative vision, not what's actually built. Copying those
// labels verbatim would fabricate capability that doesn't exist, so this
// wizard uses the SAME 3-stat-pill visual pattern every other wizard this
// session uses (checks-passing ratio + the pillar's own 2 specific real
// signals) instead of the mockup's specific fake numbers.
//
// 2026-08-17: rebuilt to match the mockup's real 4-step flow (Diagnosis /
// Recommended actions / Action detail / Close the loop) instead of the
// 3-step collapse this wizard shipped with earlier -- a direct instruction
// after the mockup's step count and its "pick a group, see its detail"
// interaction were both silently dropped here the same way Content
// Authority's gap-detail interaction was. The mockup's specific 2 groups
// ("Author Credentials" / "Platform Presence") describe Person-schema and
// GBP/directory checks this checker doesn't run -- copying those verbatim
// would still be fabrication. But the checker DOES have its own real,
// already-distinct 2-signal split (backlink authority / AI-citation
// authority, each with its own check + issue above), which maps onto the
// exact same "pick a group -> see its detail" shape the mockup uses, just
// with the two groups that are actually real instead of the two that
// aren't. Neither closes via a one-click publish/claim action (no
// GBP-claiming API, no directory automation exists) -- both are informational,
// closed only by a strategist doing outside work and a fresh audit re-checking
// it, same honest "Close the loop" framing the mockup itself uses for its own
// non-automatable half (platform-presence).
//
// 2026-08-17 (later same day): the mockup's own pane-entity opens with a
// .concept-banner literally saying this whole pillar is "a written proposal
// in ROADMAP.md, not a real check" and calling out ITS two proposed signals
// by name: "author/Person-schema credentials, multi-platform
// entity-verification". Backlinks/AI-citation (this checker's real signals)
// aren't what the mockup's own banner is talking about -- so dropping the
// Person-schema ("Author Credentials") workflow step entirely, just because
// it isn't measured by the real checker, was still under-replicating the
// mockup: the mockup's own step 3 for this concept ("Author Credentials --
// reusing Schema & Structure") is a real, specific, buildable idea (it names
// the exact real component -- SchemaGenerator's JSON-LD + WordPress publish
// flow -- it would reuse with a Person type instead of ProfessionalService).
// So `entityActionGroups()` now returns a 3rd card for it, marked
// `proposed: true` and rendered with the mockup's own `.concept-banner`
// dashed-border visual language (not the solid "Needs attention"/"Clean"
// tags the 2 real cards get) so it reads as "the mockup's own proposal",
// never as a real, already-scored signal. Its step-3 detail keeps the
// mockup's illustrative example page list, explicitly labeled as an example,
// plus the one factually-true sentence about which real component this would
// reuse if built. No fake "Person schema generated" success state -- step 4
// says outright that this specific card is unbuilt, not "closed by a fresh
// audit" like the two real cards.

const STEP_LABELS = ['Diagnosis', 'Recommended actions', 'Action detail', 'Close the loop']

// entityActionGroups(pillar) -- the checker's own 2 real signals, recast as
// the mockup's 2 selectable action-group cards. Each group's `issue` is
// this checker's own real issues[] entry for that signal (undefined when
// that signal is already clean, i.e. no gap to act on).
function entityActionGroups(pillar) {
  const checks = pillar?.checks || []
  const issues = pillar?.issues || []
  const raw = pillar?.raw || {}

  const backlinkCheck = checks.find(c => /backlink/i.test(c.label || ''))
  const backlinkIssue = issues.find(i => /backlink/i.test(i.message || ''))
  const authorityDomains = Array.isArray(raw.authorityReferringDomains) ? raw.authorityReferringDomains : []

  const citationCheck = checks.find(c => /cited by ai engines/i.test(c.label || ''))
  const citationIssue = issues.find(i => /authority domain/i.test(i.message || '') && /AI/i.test(i.message || ''))

  return [
    {
      key: 'backlinks',
      name: 'Authority Backlinks',
      meta: 'Real backlinks from recognized authority domains (Ahrefs)',
      check: backlinkCheck,
      issue: backlinkIssue,
      cleanNote: authorityDomains.length > 0 ? `${authorityDomains.length} recognized authority domain(s) already link here.` : null
    },
    {
      key: 'aicitation',
      name: 'AI Citation Consistency',
      meta: 'Share of tracked AI mentions that cite a recognized authority domain',
      check: citationCheck,
      issue: citationIssue,
      cleanNote: typeof raw.aiAuthorityCitationShare === 'number' && raw.aiAuthorityCitationShare >= 1
        ? 'AI engines already cite a recognized authority domain in every tracked mention.'
        : null
    },
    // Proposed, not built -- see the 2026-08-17 header comment. Kept out of
    // any pass/fail math (no `check`, no real `issue`); the wizard renders
    // this card and its detail with the mockup's own dashed concept-banner
    // language instead of the "Needs attention"/"Clean" tags the 2 real
    // cards above get.
    {
      key: 'authorcreds',
      name: 'Author Credentials',
      meta: 'Person schema + visible bylines (proposed -- not built)',
      proposed: true,
      check: null,
      issue: null,
      cleanNote: null
    }
  ]
}

function gradeClass(grade) {
  if (!grade) return 'grade-none'
  if (grade.startsWith('A')) return 'grade-a'
  if (grade.startsWith('B')) return 'grade-b'
  if (grade.startsWith('C')) return 'grade-c'
  if (grade.startsWith('D')) return 'grade-d'
  return 'grade-f'
}

// entityStatPills(pillar) -- real backlink-domain count and AI-citation
// share, straight from `_raw` (persisted as `pillar.raw`, same convention
// every other pillar's `_raw` already uses) -- both fields have existed
// since this checker's very first version, so this works on every past
// run, not just future ones.
function entityStatPills(pillar) {
  const checks = pillar?.checks || []
  const realChecks = checks.filter(c => c.status !== 'not_verified')
  const checksTotal = realChecks.length
  const checksPassing = realChecks.filter(c => c.status === 'pass').length
  const passRatio = checksTotal > 0 ? checksPassing / checksTotal : null

  const raw = pillar?.raw || {}
  const authorityDomains = Array.isArray(raw.authorityReferringDomains) ? raw.authorityReferringDomains : []
  const backlinkChecked = checks.some(c => /backlink/i.test(c.label || '') && c.status !== 'not_verified')
  const backlinkCount = backlinkChecked ? authorityDomains.length : null

  const aiShare = typeof raw.aiAuthorityCitationShare === 'number' ? raw.aiAuthorityCitationShare : null

  return [
    {
      key: 'checks',
      tone: passRatio === null ? null : passRatio >= 1 ? 'good' : passRatio > 0 ? 'caution' : 'gap',
      eyebrow: passRatio === null ? '● Not checked' : passRatio >= 1 ? '▲ Passing' : passRatio > 0 ? '● Partial' : '▼ Failing',
      value: checksTotal > 0 ? `${checksPassing} / ${checksTotal}` : '--',
      desc: 'real authority signals checked this run'
    },
    {
      key: 'backlinks',
      tone: backlinkCount === null ? null : backlinkCount >= 3 ? 'good' : backlinkCount > 0 ? 'caution' : 'gap',
      eyebrow: backlinkCount === null ? '● Not checked' : backlinkCount >= 3 ? '▲ Strong' : backlinkCount > 0 ? '● Partial' : '▼ None found',
      value: backlinkCount === null ? '--' : String(backlinkCount),
      desc: 'recognized authority domains linking here (Clutch, G2, BBB, etc.)'
    },
    {
      key: 'aicitation',
      tone: aiShare === null ? null : aiShare >= 0.75 ? 'good' : aiShare > 0 ? 'caution' : 'gap',
      eyebrow: aiShare === null ? '● Not checked' : aiShare >= 0.75 ? '▲ Consistent' : aiShare > 0 ? '● Inconsistent' : '▼ Never',
      value: aiShare === null ? '--' : `${Math.round(aiShare * 100)}%`,
      desc: 'tracked AI mentions citing an authority domain'
    }
  ]
}

// entityDiagnosisText(pillar, pills) -- 2026-08-16: workflow-mockup.html's
// #pane-entity Diagnosis step has a .diagnosis-text paragraph (line 448),
// but its actual copy is explicitly marked "<i>Illustrative only</i>" and
// describes GBP-claim/Person-schema signals this checker doesn't measure
// (see the file header comment above). Copying that text verbatim would
// fabricate capability that doesn't exist, so this composes a REAL sentence
// from entityStatPills()'s own already-computed checks/backlinks/aicitation
// values instead -- same "ground every diagnosis-text in real data" rule
// every other wizard's version of this helper follows.
function entityDiagnosisText(pillar, pills) {
  const checks = pills.find(p => p.key === 'checks')
  const backlinks = pills.find(p => p.key === 'backlinks')
  const aicitation = pills.find(p => p.key === 'aicitation')
  const parts = []
  if (checks && checks.value !== '--') parts.push(`${checks.value} real authority signals are checked and passing`)
  if (backlinks && backlinks.value !== '--') parts.push(`${backlinks.value} recognized authority domain(s) link here`)
  if (aicitation && aicitation.value !== '--') parts.push(`tracked AI mentions cite one ${aicitation.value} of the time`)
  if (parts.length === 0) return null
  return parts.join(', ') + '.'
}

export default function EntityAuthorityWizard({ pillar }) {
  const [step, setStep] = useState(1)
  const [selectedPill, setSelectedPill] = useState(null)
  const pills = pillar ? entityStatPills(pillar) : []
  const groups = pillar && !pillar.noData ? entityActionGroups(pillar) : []
  // selectedGroup -- mirrors selectCluster()'s "pick a group -> step 3 shows
  // that group's detail" interaction. Defaults to whichever group still has
  // a real open issue (mockup defaults to its first card as "selected");
  // falls back to the first group if both are already clean.
  const [selectedGroup, setSelectedGroup] = useState(null)
  const activeGroupKey = selectedGroup || groups.find(g => g.issue)?.key || groups[0]?.key || null
  const activeGroup = groups.find(g => g.key === activeGroupKey) || null

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
      <StepChips labels={STEP_LABELS} step={step} onStep={setStep} />

      {step === 1 && (
        <div>
          {pillar && !pillar.noData ? (
            <div className="card" style={{ padding: 20 }}>
              <div className="grade-row">
                <div className={`grade-badge ${gradeClass(pillar.grade)}`}>
                  {pillar.grade || '--'}
                </div>
                <div>
                  <div className="grade-title">{pillarHeadline('Entity & Citation Authority', pillar)}</div>
                  {pillar.finding && <div className="grade-sub">{pillar.finding}</div>}
                </div>
              </div>
              {entityDiagnosisText(pillar, pills) && (
                <p className="diagnosis-text">{entityDiagnosisText(pillar, pills)}</p>
              )}
              <div className="stat-pill-row">
                {pills.map(p => (
                  <div
                    key={p.key}
                    className={`stat-pill clickable${p.tone ? ` ${p.tone}` : ''}${selectedPill === p.key ? ' active' : ''}`}
                    onClick={() => setSelectedPill(k => k === p.key ? null : p.key)}
                  >
                    <div className="eyebrow">{p.eyebrow}</div>
                    <div className="v">{p.value}</div>
                    <div className="d">{p.desc}</div>
                  </div>
                ))}
              </div>
              {selectedPill && (
                <div className="pill-detail show">
                  {selectedPill === 'checks' && <CheckRow checks={pillar.checks} />}
                  {selectedPill === 'backlinks' && (
                    <p className="pd-lead" style={{ margin: 0 }}>
                      {(pillar.evidence || []).find(e => /authority domain/i.test(e)) || 'Not checked -- AHREFS_API_KEY may not be configured for this run.'}
                    </p>
                  )}
                  {selectedPill === 'aicitation' && (
                    <p className="pd-lead" style={{ margin: 0 }}>
                      {(pillar.evidence || []).find(e => /AI engines cited/i.test(e)) || (pillar.evidence || []).find(e => /AI-visibility/i.test(e)) || 'Not checked -- no AI-visibility tracking data available yet for this client.'}
                    </p>
                  )}
                </div>
              )}
              {Array.isArray(pillar.issues) && pillar.issues.length > 0 && !selectedPill && <IssuesList issues={pillar.issues} />}
            </div>
          ) : (
            <div className="card-empty" style={{ padding: 18 }}>
              <div className="text-small text-muted">
                {pillar?.noData
                  ? pillar.finding
                  : 'Not yet audited -- run an audit to see this pillar\'s real checks.'}
              </div>
            </div>
          )}
          <div className="cta-row">
            <button className="btn btn-primary" onClick={() => setStep(2)}>See recommended actions &rarr;</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          {groups.length > 0 ? (
            <div className="cluster-grid">
              {groups.map(g => (
                <div
                  key={g.key}
                  className={`cluster-card${activeGroupKey === g.key ? ' selected' : ''}${g.proposed ? ' proposed' : ''}`}
                  style={g.proposed ? { border: '1.5px dashed var(--border-strong)', background: 'repeating-linear-gradient(135deg, rgba(29,21,37,0.02), rgba(29,21,37,0.02) 10px, rgba(29,21,37,0.04) 10px, rgba(29,21,37,0.04) 20px)' } : undefined}
                  onClick={() => setSelectedGroup(g.key)}
                >
                  <div className="name">{g.name}</div>
                  <div className="meta">{g.meta}</div>
                  {g.proposed ? (
                    <span className="tag watch">Proposed -- not built</span>
                  ) : (
                    <span className={`tag ${g.issue ? (g.issue.severity === 'critical' || g.issue.severity === 'moderate' ? 'gap' : 'watch') : 'good'}`}>
                      {g.issue ? (g.issue.severity === 'critical' || g.issue.severity === 'moderate' ? 'Needs attention' : 'Room to improve') : 'Clean'}
                    </span>
                  )}
                  <div className="kws">{g.proposed ? 'No page-by-page byline check exists yet -- see this card\'s detail for the real component it would reuse.' : (g.issue ? g.issue.message : (g.cleanNote || 'No open gap this run.'))}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="card-empty" style={{ padding: 18 }}>
              <div className="text-small text-muted">Not yet audited.</div>
            </div>
          )}
          <div className="cta-row">
            <button className="btn btn-secondary" onClick={() => setStep(1)}>&larr; Back</button>
            <button className="btn btn-primary" onClick={() => setStep(3)}>See action detail &rarr;</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div>
          {activeGroup && activeGroup.proposed ? (
            <div className="card" style={{ padding: 18 }}>
              <div className="brief-title">Author Credentials -- reusing Schema &amp; Structure</div>
              <div className="brief-meta">Proposed -- not built. Nothing below is real audit data.</div>
              <div className="concept-banner" style={{ marginTop: 10, marginBottom: 10 }}>
                <span>
                  This checker doesn&rsquo;t crawl pages for author bylines or Person schema, so there&rsquo;s no real per-page list to show. The example below is illustrative only, copied from the mockup&rsquo;s own proposal, to show the shape a real version of this step would take:
                </span>
              </div>
              <ul className="text-small" style={{ margin: '0 0 10px', paddingLeft: 18, color: 'var(--muted)' }}>
                <li>Example: /blog/local-seo-guide -- no author byline or Person schema</li>
                <li>Example: /blog/ai-search-trends -- no author byline or Person schema</li>
                <li>Example: /about/team -- has bylines, missing Person schema markup</li>
              </ul>
              <p className="text-small" style={{ margin: '10px 0 0', color: 'var(--text)' }}>
                <b>Note:</b> if this were built, generating this schema would reuse the exact same real JSON-LD generator &amp; WordPress publish flow already built and working for Schema &amp; Structure (the <code>SchemaGenerator</code> component -- see that pillar&rsquo;s Generate &amp; review step), just with a Person type instead of ProfessionalService. That reuse is a genuine, real technical fact about this codebase, not a promise of a shipped feature.
              </p>
            </div>
          ) : activeGroup ? (
            <div className="card" style={{ padding: 18 }}>
              <div className="brief-title">{activeGroup.name}</div>
              <div className="brief-meta">{activeGroup.meta}</div>
              {activeGroup.issue ? (
                <>
                  <p className="text-small" style={{ margin: '10px 0 0' }}>{activeGroup.issue.message}</p>
                  <p className="text-tiny text-muted" style={{ margin: '8px 0 0' }}>{activeGroup.issue.why}</p>
                  <p className="text-small" style={{ margin: '10px 0 0', color: 'var(--text)' }}>
                    <b>Recommendation:</b> {activeGroup.issue.recommendation}
                  </p>
                </>
              ) : (
                <p className="text-small" style={{ margin: '10px 0 0' }}>{activeGroup.cleanNote || 'No open gap this run.'}</p>
              )}
            </div>
          ) : (
            <div className="card-empty" style={{ padding: 18 }}>
              <div className="text-small text-muted">Not yet audited.</div>
            </div>
          )}
          <div className="cta-row">
            <button className="btn btn-secondary" onClick={() => setStep(2)}>&larr; Pick a different action</button>
            <button className="btn btn-primary" onClick={() => setStep(4)}>Close the loop &rarr;</button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div>
          {activeGroup && activeGroup.proposed ? (
            <div className="callout">
              <b>This card isn&rsquo;t built:</b> unlike Authority Backlinks and AI Citation Consistency, Author Credentials has no real check behind it at all yet, so there&rsquo;s nothing here that a fresh audit re-verifies. It stays as a proposal until a page-by-page byline/Person-schema check is actually built.
            </div>
          ) : (
            /* .callout, not .concept-banner -- true, real information about a
               real limitation, not illustrative/proposed content. */
            <div className="callout">
              <b>How this actually gets verified:</b> there's no task tracker or auto-claim action wired up here -- closing a real backlink or AI-citation gap is work a strategist does outside this tool (building a review-platform profile, earning press, etc.). Once that happens, re-run the audit for this client and this pillar's grade and checks below will reflect it.
            </div>
          )}
          {activeGroup && activeGroup.proposed ? null : pillar && !pillar.noData ? (
            <div className="card" style={{ padding: 18 }}>
              <div className="text-tiny text-muted" style={{ fontWeight: 600, letterSpacing: 0.5, marginBottom: 8 }}>LAST VERIFIED (most recent audit)</div>
              <CheckRow checks={pillar.checks} />
            </div>
          ) : (
            <div className="card-empty" style={{ padding: 18 }}>
              <div className="text-small text-muted">Not yet audited.</div>
            </div>
          )}
          <div className="cta-row">
            <button className="btn btn-secondary" onClick={() => setStep(3)}>&larr; Back</button>
          </div>
        </div>
      )}
    </div>
  )
}
