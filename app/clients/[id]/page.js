import { getClientWithRuns } from '../../../lib/data'
import RunAuditButton from './RunAuditButton'
import PromptTester from './PromptTester'

export const dynamic = 'force-dynamic'

const PILLAR_LABELS = {
  schema_structure: 'Schema & Structure',
  technical_foundation: 'Technical Foundation',
  ai_geo_visibility: 'AI & GEO Visibility',
  content_authority: 'Content Authority',
  competitive_position: 'Competitive Position'
}

const PILLAR_ORDER = ['schema_structure', 'technical_foundation', 'ai_geo_visibility', 'content_authority', 'competitive_position']

function gradeClass(grade) {
  if (!grade) return 'grade-none'
  if (grade.startsWith('A')) return 'grade-a'
  if (grade.startsWith('B')) return 'grade-b'
  if (grade.startsWith('C')) return 'grade-c'
  if (grade.startsWith('D')) return 'grade-d'
  return 'grade-f'
}

function PillarCard({ pillarKey, pillar }) {
  if (!pillar) {
    return (
      <div className="card-empty" style={{ padding: 18 }}>
        <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 14 }}>{PILLAR_LABELS[pillarKey]}</div>
        <div className="text-small text-muted">Not yet built -- blocked on a backlink/rank-tracking vendor decision.</div>
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
            <span className="pill pill-snapshot">snapshot, not tracked</span>
          )}
        </div>
      </div>
      {pillar.finding && <p style={{ fontSize: 14, margin: '6px 0' }}>{pillar.finding}</p>}
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
        <div style={{ marginLeft: 'auto' }}>
          <RunAuditButton clientId={client.id} />
        </div>
      </div>

      {latestRun ? (
        <>
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
          <div style={{ display: 'grid', gap: 12 }}>
            {PILLAR_ORDER.map(key => <PillarCard key={key} pillarKey={key} pillar={pillarsByKey.get(key)} />)}
          </div>
        </>
      ) : (
        <div className="card-empty" style={{ padding: 32, textAlign: 'center' }}>
          <p className="text-muted" style={{ margin: 0 }}>No audits run yet. Click &ldquo;Run audit now&rdquo; to grade this client for the first time.</p>
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        <PromptTester clientId={client.id} />
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
