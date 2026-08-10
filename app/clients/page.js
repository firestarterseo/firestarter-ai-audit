import Link from 'next/link'
import { listClientsWithLatestRun } from '../../lib/data'

// This reads live data (and needs runtime env vars for the Supabase
// client) on every request -- never prerender/cache it at build time.
export const dynamic = 'force-dynamic'

function gradeColor(grade) {
  if (!grade) return '#9ca3af'
  if (grade.startsWith('A')) return '#16a34a'
  if (grade.startsWith('B')) return '#65a30d'
  if (grade.startsWith('C')) return '#ca8a04'
  if (grade.startsWith('D')) return '#ea580c'
  return '#dc2626'
}

export default async function ClientsPage() {
  const clients = await listClientsWithLatestRun()

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Clients</h1>
        <Link href="/clients/new" style={{ marginLeft: 'auto', background: '#111827', color: 'white', padding: '8px 14px', borderRadius: 6, textDecoration: 'none', fontSize: 14 }}>
          + Add client
        </Link>
      </div>

      {clients.length === 0 && (
        <p style={{ color: '#6b7280' }}>No clients yet. Add one to run the first audit.</p>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {clients.map(c => (
          <Link
            key={c.id}
            href={`/clients/${c.id}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              background: 'white',
              border: '1px solid #e5e7eb',
              borderRadius: 8,
              padding: '14px 16px',
              textDecoration: 'none',
              color: 'inherit'
            }}
          >
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 8,
                background: gradeColor(c.latestRun?.overall_grade),
                color: 'white',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: 16,
                flexShrink: 0
              }}
            >
              {c.latestRun?.overall_grade || '--'}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{c.name}</div>
              <div style={{ fontSize: 13, color: '#6b7280' }}>{c.domain}</div>
            </div>
            <span style={{ fontSize: 12, background: c.status === 'tracked' ? '#dbeafe' : '#fef3c7', color: c.status === 'tracked' ? '#1e40af' : '#92400e', borderRadius: 4, padding: '2px 8px' }}>
              {c.status}
            </span>
            <div style={{ fontSize: 12, color: '#9ca3af', minWidth: 130, textAlign: 'right' }}>
              {c.latestRun ? `Last run ${new Date(c.latestRun.run_at).toLocaleDateString()}` : 'Never audited'}
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
