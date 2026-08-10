import Link from 'next/link'
import { listClientsWithLatestRun } from '../../lib/data'

// This reads live data (and needs runtime env vars for the Supabase
// client) on every request -- never prerender/cache it at build time.
export const dynamic = 'force-dynamic'

function gradeClass(grade) {
  if (!grade) return 'grade-none'
  if (grade.startsWith('A')) return 'grade-a'
  if (grade.startsWith('B')) return 'grade-b'
  if (grade.startsWith('C')) return 'grade-c'
  if (grade.startsWith('D')) return 'grade-d'
  return 'grade-f'
}

export default async function ClientsPage() {
  const clients = await listClientsWithLatestRun()

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="section-label">Internal Grader</div>
          <h1>Clients</h1>
        </div>
        <Link href="/clients/new" className="btn btn-primary" style={{ marginLeft: 'auto' }}>
          + Add client
        </Link>
      </div>

      {clients.length === 0 && (
        <div className="card-empty" style={{ padding: 32, textAlign: 'center' }}>
          <p className="text-muted" style={{ margin: 0 }}>No clients yet. Add one to run the first audit.</p>
        </div>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {clients.map(c => (
          <Link key={c.id} href={`/clients/${c.id}`} className="list-row">
            <div
              className={`grade-badge ${gradeClass(c.latestRun?.overall_grade)}`}
              style={{ width: 48, height: 48, fontSize: 17 }}
            >
              {c.latestRun?.overall_grade || '--'}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 15 }}>{c.name}</div>
              <div className="text-small text-muted">{c.domain}</div>
            </div>
            <span className={`pill ${c.status === 'tracked' ? 'pill-tracked' : 'pill-lead'}`}>
              {c.status}
            </span>
            <div className="text-tiny text-muted" style={{ minWidth: 130, textAlign: 'right' }}>
              {c.latestRun ? `Last run ${new Date(c.latestRun.run_at).toLocaleDateString()}` : 'Never audited'}
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
