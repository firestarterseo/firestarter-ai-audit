import { getClientWithRuns } from '../../../lib/data'
import RunAuditButton from './RunAuditButton'
import PromptTester from './PromptTester'
import TestPromptsManager from './TestPromptsManager'
import ClientActions from './ClientActions'

export const dynamic = 'force-dynamic'

const PILLAR_LABELS = {
  schema_structure: 'Schema & Structure',
  technical_foundation: 'Technical Foundation',
  ai_geo_visibility: 'AI & GEO Visibility',
  content_authority: 'Content Authority',
  competitive_position: 'Competitive Position'
}

const PILLAR_ORDER = ['schema_structure', 'technical_foundation', 'ai_geo_visibility', 'content_authority', 'competitive_position']

// Only Competitive Position is genuinely "not built" (blocked on a vendor
// decision, see lib/runAudit.js header). Every other pillar just hasn't
// been audited yet on a brand-new client -- those two states need
// different messaging, and ai_geo_visibility additionally needs its setup
// UI (children) available even before that first audit, not only after.
const NOT_YET_BUILT = new Set(['competitive_position'])

function gradeClass(grade) {
  if (!grade) return 'grade-none'
  if (grade.startsWith('A')) return 'grade-a'
  if (grade.startsWith('B')) return 'grade-b'
  if (grade.startsWith('C')) return 'grade-c'
  if (grade.startsWith('D')) return 'grade-d'
  return 'grade-f'
}

const CHECK_ICON = { pass: '✓', partial: '✗', fail: '✗', not_verified: '–' }
const CHECK_COLOR = { pass: 'var(--grade-a)', partial: 'var(--grade-d)', fail: 'var(--grade-f)', not_verified: 'var(--grade-none)' }

// A row of small pass/fail chips under each pillar's finding text -- the
// concrete sub-checks that actually ran, not just a single grade letter.
// "not_verified" (grey dash) is deliberately distinct from "fail" (red x):
// a missing API key isn't the same thing as a site actually failing a
// check, and shouldn't look like one.
function CheckRow({ checks }) {
  if (!Array.isArray(checks) || checks.length === 0) return null
  return (
    <div style={{ display: 'grid', gap: 5, margin: '10px 0' }}>
      {checks.map((c, i) => (
        <div key={i} className="text-small" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 16, height: 16, borderRadius: '50%', fontSize: 10, fontWeight: 700, flexShrink: 0,
            background: CHECK_COLOR[c.status] || 'var(--grade-none)', color: '#fff', lineHeight: 1
          }}>
            {CHECK_ICON[c.status] || '–'}
          </span>
          <span className={c.status === 'not_verified' ? 'text-muted' : undefined}>
            {c.label}{c.status === 'not_verified' ? ' -- not verified' : ''}
          </span>
        </div>
      ))}
    </div>
  )
}

function PillarCard({ pillarKey, pillar, children }) {
  if (!pillar) {
    if (NOT_YET_BUILT.has(pillarKey)) {
      return (
        <div className="card-empty" style={{ padding: 18 }}>
          <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 14 }}>{PILLAR_LABELS[pillarKey]}</div>
          <div className="text-small text-muted">Not yet built -- blocked on a backlink/rank-tracking vendor decision.</div>
        </div>
      )
    }
    return (
      <div className="card" style={{ padding: 18 }}>
        <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 14 }}>{PILLAR_LABELS[pillarKey]}</div>
        <div className="text-small text-muted" style={{ marginBottom: children ? 14 : 0 }}>Not yet audited.</div>
        {children}
      </div>
    )
  }

  return (
    <div className="card" style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <div className={`grade-badge ${gradeClass(pillar.grade)}`} style={{ width: 34, height: 34, fontSize: 14 }}>
          {pillar.grade || '--'}
        </div>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{PILLAR_LABELS[pillarKey]}</div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {pillar.grade == null && (
            <span className="pill pill-lead">not yet graded -- excluded from overall score</span>
          )}
          {pillar.partial && (
            <span className="pill pill-lead" title={pillar.possible_points != null ? `Only ${pillar.possible_points}/100 possible points could be verified this run` : undefined}>
              partial -- {pillar.possible_points ?? '?'}/100 checked
            </span>
          )}
          {pillar.snapshot && (
            <span
              className="pill pill-snapshot"
              title="A one-off live check run right now, not a recurring measurement. Only 'tracked' clients build up real history over time via the weekly cron job -- a 'lead' always gets a fresh snapshot instead, each audit."
            >
              snapshot, not tracked
            </span>
          )}
        </div>
      </div>
      {pillar.finding && <p style={{ fontSize: 14, margin: '6px 0' }}>{pillar.finding}</p>}
      <CheckRow checks={pillar.checks} />
      {pillar.recommendation && (
        <p className="text-small" style={{ margin: '6px 0', color: 'var(--text)' }}>
          <b>Recommendation:</b> {pillar.recommendation}
        </p>
      )}
      {Array.isArray(pillar.evidence) && pillar.evidence.length > 0 && (
        <ul className="evidence-list">
          {pillar.evidence.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
      {children}
    </div>
  )
}

export default async function ClientDetailPage({ params }) {
  const { id } = await params
  const { client, runs } = await getClientWithRuns(id)
  const latestRun = runs[0] || null
  const pillarsByKey = new Map((latestRun?.pillars || []).map(p => [p.pillar, p]))

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
        <div className="meta-line" style={{ marginBottom: 14 }}>
          Last run {new Date(latestRun.run_at).toLocaleString()} ({latestRun.trigger_source}) &middot; Overall:{' '}
          <b style={{
            fontWeight: 700,
            color:
              latestRun.overall_grade?.startsWith('A') ? 'var(--grade-a)' :
              latestRun.overall_grade?.startsWith('B') ? 'var(--grade-b)' :
              latestRun.overall_grade?.startsWith('C') ? 'var(--grade-c)' :
              latestRun.overall_grade?.startsWith('D') ? 'var(--grade-d)' :
              latestRun.overall_grade ? 'var(--grade-f)' : 'var(--grade-none)'
          }}>
            {latestRun.overall_grade || '--'}
          </b>{' '}
          ({latestRun.overall_score ?? '--'})
        </div>
      ) : (
        <p className="text-small text-muted" style={{ marginBottom: 14 }}>
          No audits run yet -- set up AI-visibility test terms below, then click &ldquo;Run audit now&rdquo; to grade this client for the first time.
        </p>
      )}

      <div style={{ display: 'grid', gap: 12 }}>
        {PILLAR_ORDER.map(key => (
          <PillarCard key={key} pillarKey={key} pillar={pillarsByKey.get(key)}>
            {key === 'ai_geo_visibility' && (
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)', display: 'grid', gap: 14 }}>
                <TestPromptsManager clientId={client.id} savedPrompts={client.test_prompts} bare />
                <PromptTester clientId={client.id} bare />
              </div>
            )}
          </PillarCard>
        ))}
      </div>

      {runs.length > 1 && (
        <div style={{ marginTop: 32 }}>
          <div className="section-label">History</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {runs.map(r => (
              <div key={r.id} className="card text-small" style={{ display: 'flex', gap: 12, padding: '10px 14px', color: 'var(--text)' }}>
                <span>{new Date(r.run_at).toLocaleString()}</span>
                <span className="text-muted">{r.trigger_source}</span>
                <span style={{
                  marginLeft: 'auto',
                  fontWeight: 600,
                  color:
                    r.overall_grade?.startsWith('A') ? 'var(--grade-a)' :
                    r.overall_grade?.startsWith('B') ? 'var(--grade-b)' :
                    r.overall_grade?.startsWith('C') ? 'var(--grade-c)' :
                    r.overall_grade?.startsWith('D') ? 'var(--grade-d)' :
                    r.overall_grade ? 'var(--grade-f)' : 'var(--grade-none)'
                }}>
                  {r.overall_grade || '--'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
