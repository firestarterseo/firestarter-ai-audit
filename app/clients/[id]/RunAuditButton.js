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
      <button
        onClick={onClick}
        disabled={running}
        style={{ background: running ? '#9ca3af' : '#111827', color: 'white', padding: '10px 16px', borderRadius: 6, border: 'none', fontSize: 14, cursor: running ? 'default' : 'pointer' }}
      >
        {running ? 'Running audit (this hits the live site + Cloro, ~30-60s)...' : 'Run audit now'}
      </button>
      {error && <p style={{ color: '#dc2626', fontSize: 13, marginTop: 8 }}>{error}</p>}
    </div>
  )
}
