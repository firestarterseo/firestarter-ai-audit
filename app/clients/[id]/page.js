import Link from 'next/link'
import { getClientWithRuns, getClientCompetitors, getClientOpportunities, sanitizeClient } from '../../../lib/data'
import { normalizeDomain } from '../../../lib/nonCompetitorDomains'
import { getClientIndustryProfile } from '../../../lib/clientIndustryIntelligence'
import RunAuditButton from './RunAuditButton'
import ClientActions from './ClientActions'
import SchemaWizard from './SchemaWizard'
import EntityAuthorityWizard from './EntityAuthorityWizard'
import PillarsBoard from './PillarsBoard'
import TechnicalFoundationWizard from './TechnicalFoundationWizard'
import ContentAuthorityWizard from './ContentAuthorityWizard'
import AiGeoVisibilityWizard from './AiGeoVisibilityWizard'
import CompetitivePositionWizard from './CompetitivePositionWizard'

export const dynamic = 'force-dynamic'

const PILLAR_LABELS = {
  schema_structure: 'Schema & Structure',
  entity_citation_authority: 'Entity & Citation Authority',
  technical_foundation: 'Technical Foundation',
  ai_geo_visibility: 'AI & GEO Visibility',
  content_authority: 'Content Authority',
  competitive_position: 'Competitive Position'
}

// Entity & Citation Authority sits right after Schema & Structure: both are
// ultimately about making the business a legible, verifiable entity, just
// from two different angles -- on-site markup (Schema) vs. off-site proof
// (real backlinks + AI citations from recognized authority domains -- see
// lib/checkers/entity-citation-authority-checker.js). The other 5 keep
// their original relative order.
const PILLAR_ORDER = ['schema_structure', 'entity_citation_authority', 'technical_foundation', 'ai_geo_visibility', 'content_authority', 'competitive_position']

// As of 2026-08-13, Competitive Position is built (see
// lib/checkers/competitive-position-checker.js) -- it just may not have
// enough auto-detected competitors yet to grade, same "not yet graded"
// empty-data contract every other pillar already uses (result.noData),
// not a "this feature doesn't exist" state. Nothing belongs in this set
// anymore, but it's kept (empty) rather than removed outright in case a
// genuinely not-yet-built pillar shows up again later.
const NOT_YET_BUILT = new Set([])

function gradeClass(grade) {
  if (!grade) return 'grade-none'
  if (grade.startsWith('A')) return 'grade-a'
  if (grade.startsWith('B')) return 'grade-b'
  if (grade.startsWith('C')) return 'grade-c'
  if (grade.startsWith('D')) return 'grade-d'
  return 'grade-f'
}

function gradeColor(grade) {
  if (grade?.startsWith('A')) return 'var(--grade-a)'
  if (grade?.startsWith('B')) return 'var(--grade-b)'
  if (grade?.startsWith('C')) return 'var(--grade-c)'
  if (grade?.startsWith('D')) return 'var(--grade-d)'
  return grade ? 'var(--grade-f)' : 'var(--grade-none)'
}

function HistoryRow({ run }) {
  return (
    <div className="card text-small" style={{ display: 'flex', gap: 12, padding: '10px 14px', color: 'var(--text)' }}>
      <span>{new Date(run.run_at).toLocaleString()}</span>
      <span className="text-muted">{run.trigger_source}</span>
      <span style={{ marginLeft: 'auto', fontWeight: 600, color: gradeColor(run.overall_grade) }}>
        {run.overall_grade || '--'}
      </span>
    </div>
  )
}

// `runs` is newest-first (see lib/data.js). The original (oldest) run's
// grade and the current (newest) run's score are the two numbers that
// actually answer "is this getting better," so they're surfaced as their
// own tile up top. The full run-by-run list is entirely hidden by
// default behind a single native <details> disclosure -- same pattern
// already used for raw evidence elsewhere on this page -- rather than
// showing some rows always and others behind a toggle.
function HistoryPanel({ runs }) {
  if (!Array.isArray(runs) || runs.length < 2) return null
  const current = runs[0]
  const original = runs[runs.length - 1]

  return (
    <div style={{ marginTop: 32 }}>
      <div className="section-label">History</div>

      <div className="overall-tile" style={{ marginBottom: 14 }}>
        <div className={`grade-badge ${gradeClass(original.overall_grade)}`} style={{ width: 40, height: 40, fontSize: 16 }}>
          {original.overall_grade || '--'}
        </div>
        <div>
          <div className="text-tiny text-muted" style={{ fontWeight: 600, letterSpacing: 0.5 }}>ORIGINAL GRADE</div>
          <div className="text-small text-muted">{new Date(original.run_at).toLocaleDateString()}</div>
        </div>
        <div style={{ fontSize: 20, color: 'var(--muted-2)' }}>&rarr;</div>
        <div>
          <div className="text-tiny text-muted" style={{ fontWeight: 600, letterSpacing: 0.5 }}>CURRENT SCORE</div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>
            {current.overall_score ?? '--'} <span className="text-small text-muted" style={{ fontWeight: 400 }}>/ 100</span>
          </div>
        </div>
        <div className={`grade-badge ${gradeClass(current.overall_grade)}`} style={{ width: 40, height: 40, fontSize: 16, marginLeft: 'auto' }}>
          {current.overall_grade || '--'}
        </div>
      </div>

      <details className="raw-details">
        <summary>Show full history ({runs.length} runs)</summary>
        <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
          {runs.map(r => <HistoryRow key={r.id} run={r} />)}
        </div>
      </details>
    </div>
  )
}

export default async function ClientDetailPage({ params }) {
  const { id } = await params
  const { client, runs } = await getClientWithRuns(id)
  const competitors = await getClientCompetitors(id)
  const opportunities = await getClientOpportunities(id)
  // Read-only summary only -- the full editable Detected Business Context
  // experience lives at /clients/[id]/settings/business-profile (Client
  // Settings -> Business Profile), not inside this pillar/audit page. See
  // that page's header comment for the UX rationale (2026-08-17 placement
  // correction).
  //
  // The header below deliberately shows only verticalSubindustry/specialty/
  // businessModel here -- NOT geography or industry, which are already
  // shown one line up via client.city/region/category. Client identity
  // should establish identity + a little shared context, not restate the
  // same facts twice or turn into a status dashboard (2026-08-17 header
  // decluttering correction -- see the Topic & Prompt Intelligence status,
  // which used to sit here too, now living only at Client Settings ->
  // Topic & Prompt Intelligence and the Client Settings link, not beside
  // business identity).
  const businessProfile = await getClientIndustryProfile(id)
  const contextChips = [
    businessProfile.verticalSubindustry?.value,
    businessProfile.specialty?.value,
    businessProfile.businessModel?.value
  ].filter(Boolean)
  const latestRun = runs[0] || null
  const pillarsByKey = new Map((latestRun?.pillars || []).map(p => [p.pillar, p]))

  // Pillars as plain data + pre-resolved children JSX, handed to the
  // (client-side) PillarsBoard for the tile/expand UI. The board itself
  // never needs to know what SchemaGenerator/TestPromptsManager/etc. are --
  // just that they're some JSX to render inside the expanded card.
  const pillars = PILLAR_ORDER.map(key => ({
    key,
    label: PILLAR_LABELS[key],
    pillar: pillarsByKey.get(key),
    notYetBuilt: NOT_YET_BUILT.has(key),
    // customDetail (Phase 3, extended here to Technical Foundation) -- fully
    // replaces the generic grade-badge/checks/issues card with a step-by-step
    // wizard (see SchemaWizard.js / TechnicalFoundationWizard.js) instead of
    // just appending extra content below it via `children` the way the
    // remaining pillars below do. Built here rather than inside
    // PillarsBoard.js so that Client Component still never needs to know
    // what a "pillar" actually looks like -- see that file's own comment on
    // this. TechnicalDevAssignee used to be appended via `children` for
    // technical_foundation, but children never renders once customDetail is
    // set (see PillarsBoard.js's expand loop), so it now lives inside
    // TechnicalFoundationWizard's own "Fix detail" step instead.
    customDetail: key === 'schema_structure'
      ? (
        // sanitizeClient strips the encrypted WordPress credential -- see
        // lib/data.js -- before this crosses into a Client Component's
        // props. Only `wp_connected` (a boolean) needs to reach the browser.
        <SchemaWizard pillar={pillarsByKey.get(key)} clientId={client.id} client={sanitizeClient(client)} />
      )
      : key === 'entity_citation_authority'
        ? (
          <EntityAuthorityWizard pillar={pillarsByKey.get(key)} />
        )
        : key === 'technical_foundation'
        ? (
          <TechnicalFoundationWizard pillar={pillarsByKey.get(key)} clientId={client.id} defaultDev={client.default_dev} />
        )
        : key === 'content_authority'
          ? (
            <ContentAuthorityWizard pillar={pillarsByKey.get(key)} />
          )
          : key === 'ai_geo_visibility'
            ? (
              <AiGeoVisibilityWizard pillar={pillarsByKey.get(key)} clientId={client.id} savedPrompts={client.test_prompts} />
            )
            : key === 'competitive_position'
              ? (
                // clientDomain is only ever used for a read-only display
                // comparison (rendering a "this is you" reference row) --
                // normalized server-side here with the same helper detection
                // uses, since client.domain is stored inconsistently
                // (sometimes with a leading "www.") across real client rows.
                <CompetitivePositionWizard
                  pillar={pillarsByKey.get(key)}
                  clientId={client.id}
                  competitors={competitors}
                  opportunities={opportunities}
                  clientDomain={normalizeDomain(client.domain) || normalizeDomain(client.url)}
                />
              )
              : null,
    children: null
  }))

  return (
    <div>
      <div className="page-header" style={{ alignItems: 'center' }}>
        <div>
          <div className="section-label">Client</div>
          <h1 style={{ marginBottom: 4 }}>{client.name}</h1>
          <div className="text-small text-muted">{client.url}</div>
          <div className="text-small text-muted">
            {[client.city, client.region].filter(Boolean).join(', ')} {client.category ? `· ${client.category}` : ''}
          </div>
          {contextChips.length > 0 ? (
            <Link href={`/clients/${client.id}/settings/business-profile`} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6, textDecoration: 'none' }}>
              {contextChips.map(chip => (
                <span key={chip} className="pill" style={{ textTransform: 'none' }}>{chip}</span>
              ))}
            </Link>
          ) : (
            <Link href={`/clients/${client.id}/settings/business-profile`} className="text-tiny text-muted" style={{ marginTop: 6, display: 'inline-block' }}>
              Not classified yet &rsaquo;
            </Link>
          )}
        </div>
        <span className={`pill ${client.status === 'tracked' ? 'pill-tracked' : 'pill-lead'}`}>
          {client.status}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10 }}>
          <RunAuditButton clientId={client.id} />
          <ClientActions clientId={client.id} status={client.status} />
          <Link href={`/clients/${client.id}/settings`} className="text-tiny text-muted">Client Settings</Link>
        </div>
      </div>

      {latestRun ? (
        <div className="overall-tile">
          <div className={`grade-badge ${gradeClass(latestRun.overall_grade)}`} style={{ width: 56, height: 56, fontSize: 22 }}>
            {latestRun.overall_grade || '--'}
          </div>
          <div>
            <div className="section-label" style={{ marginBottom: 4 }}>Overall Score</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{latestRun.overall_score ?? '--'} <span className="text-small text-muted" style={{ fontWeight: 400 }}>/ 100</span></div>
          </div>
          <div className="text-small text-muted" style={{ marginLeft: 'auto', textAlign: 'right' }}>
            Last run {new Date(latestRun.run_at).toLocaleString()}<br />
            <span className="text-tiny">via {latestRun.trigger_source}</span>
          </div>
        </div>
      ) : (
        <p className="text-small text-muted" style={{ marginBottom: 14 }}>
          No audits run yet -- set up AI-visibility test terms below, then click &ldquo;Run audit now&rdquo; to grade this client for the first time.
        </p>
      )}

      <PillarsBoard pillars={pillars} />

      <HistoryPanel runs={runs} />
    </div>
  )
}
