'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function RunAuditButton({ clientId }) {
  const router = useRouter()
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)

  async function onClick() {
    setRunning(true)
    setError(null)
    // Belt-and-suspenders on top of the server's own maxDuration=60: if the
    // response somehow never comes back (dropped connection, cold-start
    // stacking with the live Cloro calls, etc.), don't leave the button
    // spinning forever with no explanation. The audit may still finish and
    // write to the DB even if this specific request times out client-side
    // -- refreshing will show it if so.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 130000)
    try {
      const res = await fetch(`/api/clients/${clientId}/audit`, { method: 'POST', signal: controller.signal })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Audit failed')
      router.refresh()
    } catch (err) {
      if (err.name === 'AbortError') {
        setError('This is taking longer than expected (2min+). The audit may still finish in the background -- try refreshing the page in a bit to check.')
      } else {
        setError(err.message)
      }
    } finally {
      clearTimeout(timeout)
      setRunning(false)
    }
  }

  return (
    <div>
      <button onClick={onClick} disabled={running} className="btn btn-primary">
        {running ? 'Running audit...' : 'Run audit now'}
      </button>
      {running && (
        <p className="text-tiny text-muted" style={{ marginTop: 6, marginBottom: 0, textAlign: 'right' }}>
          Hits the live site + Cloro (5 AI engines), usually 30-60s, occasionally up to ~2min
        </p>
      )}
      {error && <p className="field-error" style={{ marginTop: 8, textAlign: 'right' }}>{error}</p>}
    </div>
  )
}
