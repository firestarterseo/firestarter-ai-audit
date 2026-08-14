import { getClientWithRuns, getClientCompetitors, sanitizeClient } from '../../../lib/data'
import { normalizeDomain } from '../../../lib/nonCompetitorDomains'
import RunAuditButton from './RunAuditButton'
import PromptTester from './PromptTester'
import TestPromptsManager from './TestPromptsManager'
import ClientActions from './ClientActions'
import SchemaGenerator from './SchemaGenerator'
import CompetitorsManager from './CompetitorsManager'
import PillarsBoard from './PillarsBoard'

export const dynamic = 'force-dynamic'

const PILLAR_LABELS = {
  schema_structure: 'Schema & Structure',
  technical_foundation: 'Technical Foundation',
  ai_geo_visibility: 'AI & GEO Visibility',
  content_authority: 'Content Authority',
  competitive_position: 'Competitive Position'
}

const PILLAR_ORDER = ['schema_structure', 'technical_foundation', 'ai_geo_visibility', 'content_authority', 'competitive_position']

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
    children: (
      <>
        {key === 'ai_geo_visibility' && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)', display: 'grid', gap: 14 }}>
            <TestPromptsManager clientId={client.id} savedPrompts={client.test_prompts} bare />
            <PromptTester clientId={client.id} bare />
          </div>
        )}
        {key === 'schema_structure' && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            {/* sanitizeClient strips the encrypted WordPress credential --
                see lib/data.js -- before this crosses into a Client
                Component's props. Only `wp_connected` (a boolean) needs
                to reach the browser. */}
            <SchemaGenerator clientId={client.id} client={sanitizeClient(client)} bare />
          </div>
        )}
        {key === 'competitive_position' && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            {/* clientDomain is only ever used for a read-only display
                comparison (rendering a "this is you" reference row) --
                normalized server-side here with the same helper detection
                uses, since client.domain is stored inconsistently
                (sometimes with a leading "www.") across real client rows. */}
            <CompetitorsManager clientId={client.id} competitors={competitors} clientDomain={normalizeDomain(client.domain) || normalizeDomain(client.url)} bare />
          </div>
        )}
      </>
    )
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
        </div>
        <span className={`pill ${client.status === 'tracked' ? 'pill-tracked' : 'pill-lead'}`}>
          {client.status}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10 }}>
          <RunAuditButton clientId={client.id} />
          <ClientActions clientId={client.id} status={client.status} />
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
