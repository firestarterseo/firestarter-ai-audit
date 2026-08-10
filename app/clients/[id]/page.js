import { getClientWithRuns } from '../../../lib/data'
import RunAuditButton from './RunAuditButton'

export const dynamic = 'force-dynamic'

const PILLAR_LABELS = {
  schema_structure: 'Schema & Structure',
  technical_foundation: 'Technical Foundation',
  ai_geo_visibility: 'AI & GEO Visibility',
  content_authority: 'Content Authority',
  competitive_position: 'Competitive Position'
}

const PILLAR_ORDER = ['schema_structure', 'technical_foundation', 'ai_geo_visibility', 'content_authority', 'competitive_position']

function gradeColor(grade) {
  if (!grade) return '#9ca3af'
  if (grade.startsWith('A')) return '#16a34a'
  if (grade.startsWith('B')) return '#65a30d'
  if (grade.startsWith('C')) return '#ca8a04'
  if (grade.startsWith('D')) return '#ea580c'
  return '#dc2626'
}

function PillarCard({ pillarKey, pillar }) {
  if (!pillar) {
    return (
      <div style={{ background: '#f9fafb', border: '1px dashed #d1d5db', borderRadius: 8, padding: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{PILLAR_LABELS[pillarKey]}</div>
        <div style={{ fontSize: 13, color: '#9ca3af' }}>Not yet built -- blocked on a backlink/rank-tracking vendor decision.</div>
      </div>
    )
  }

  return (
    <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <div style={{ width: 32, height: 32, borderRadius: 6, background: gradeColor(pillar.grade), color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13, flexShrink: 0 }}>
          {pillar.grade || '--'}
        </div>
        <div style={{ fontWeight: 600 }}>{PILLAR_LABELS[pillarKey]}</div>
        {pillar.snapshot && (
          <span style={{ fontSize: 11, background: '#fef3c7', color: '#92400e', borderRadius: 4, padding: '2px 6px', marginLeft: 'auto' }}>
            snapshot, not tracked
          </span>
        )}
      </div>
      {pillar.finding && <p style={{ fontSize: 14, margin: '6px 0' }}>{pillar.finding}</p>}
      {pillar.recommendation && <p style={{ fontSize: 13, color: '#374151', margin: '6px 0' }}><b>Recommendation:</b> {pillar.recommendation}</p>}
      {Array.isArray(pillar.evidence) && pillar.evidence.length > 0 && (
        <ul style={{ fontSize: 12, color: '#6b7280', margin: '8px 0 0', paddingLeft: 18 }}>
          {pillar.evidence.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
    </div>
  )
}

export default async function ClientDetailPage({ params }) {
  const { client, runs } = await getClientWithRuns(params.id)
  const latestRun = runs[0] || null
  const pillarsByKey = new Map((latestRun?.pillars || []).map(p => [p.pillar, p]))

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>{client.name}</h1>
          <div style={{ fontSize: 13, color: '#6b7280' }}>{client.url}</div>
          <div style={{ fontSize: 13, color: '#6b7280' }}>
            {[client.city, client.region].filter(Boolean).join(', ')} {client.category ? `· ${client.category}` : ''}
          </div>
        </div>
        <span style={{ fontSize: 12, background: client.status === 'tracked' ? '#dbeafe' : '#fef3c7', color: client.status === 'tracked' ? '#1e40af' : '#92400e', borderRadius: 4, padding: '2px 8px' }}>
          {client.status}
        </span>
        <div style={{ marginLeft: 'auto' }}>
          <RunAuditButton clientId={client.id} />
        </div>
      </div>

      {latestRun ? (
        <>
          <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
            Last run {new Date(latestRun.run_at).toLocaleString()} ({latestRun.trigger_source}) &middot; Overall: <b style={{ color: gradeColor(latestRun.overall_grade) }}>{latestRun.overall_grade || '--'}</b> ({latestRun.overall_score ?? '--'})
          </div>
          <div style={{ display: 'grid', gap: 12 }}>
            {PILLAR_ORDER.map(key => <PillarCard key={key} pillarKey={key} pillar={pillarsByKey.get(key)} />)}
          </div>
        </>
      ) : (
        <p style={{ color: '#6b7280' }}>No audits run yet. Click "Run audit now" to grade this client for the first time.</p>
      )}

      {runs.length > 1 && (
        <div style={{ marginTop: 28 }}>
          <h2 style={{ fontSize: 16 }}>History</h2>
          <div style={{ display: 'grid', gap: 6 }}>
            {runs.map(r => (
              <div key={r.id} style={{ display: 'flex', gap: 12, fontSize: 13, color: '#374151', background: 'white', border: '1px solid #e5e7eb', borderRadius: 6, padding: '8px 12px' }}>
                <span>{new Date(r.run_at).toLocaleString()}</span>
                <span style={{ color: '#9ca3af' }}>{r.trigger_source}</span>
                <span style={{ marginLeft: 'auto', fontWeight: 600, color: gradeColor(r.overall_grade) }}>{r.overall_grade || '--'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
