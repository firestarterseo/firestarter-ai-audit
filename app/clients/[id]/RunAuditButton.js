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
      <button onClick={onClick} disabled={running} className="btn btn-primary" style={{ minWidth: 160 }}>
        {running ? 'Running audit...' : 'Run audit now'}
      </button>
      {error && <p className="field-error" style={{ marginTop: 8, textAlign: 'right', maxWidth: 260 }}>{error}</p>}

      {running && (
        // A full-screen dimmed overlay instead of a growing caption under
        // the button -- that caption used to widen the right-aligned
        // button's own flex container as its text wrapped, visibly
        // shoving the button left the instant a run started. This also
        // deliberately doesn't narrate exactly what's happening step by
        // step (fetching page, calling engine 3 of 5, etc.) -- just that
        // something is running and roughly how long it takes.
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(29, 21, 37, 0.55)', backdropFilter: 'blur(2px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}
        >
          <div className="card" style={{ padding: '32px 40px', textAlign: 'center', maxWidth: 320 }}>
            <div className="audit-spinner" style={{ margin: '0 auto 18px' }} />
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 6 }}>Running audit&hellip;</div>
            <p className="text-small text-muted" style={{ margin: 0 }}>
              Usually under a minute, occasionally up to two. This page will update automatically when it's done.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
