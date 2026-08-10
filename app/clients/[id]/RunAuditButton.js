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
    try {
      const res = await fetch(`/api/clients/${clientId}/audit`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Audit failed')
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
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
          Hits the live site + Cloro, ~30-60s
        </p>
      )}
      {error && <p className="field-error" style={{ marginTop: 8, textAlign: 'right' }}>{error}</p>}
    </div>
  )
}
