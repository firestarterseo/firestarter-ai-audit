'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

// CLIENT_TIMEOUT_MS -- 2026-09-04 fix: raised from 130s. lib/runAudit.js's
// own header comment already documents why a run can legitimately run past
// 60-130s -- Competitive Position's SERP-landscape (up to 15 live Cloro
// calls)/keyword-difficulty/LLM-refinement tail runs SEQUENTIALLY after the
// six-pillar Promise.all, and Cloro calls have no timeout of their own.
// Confirmed directly (a run that hit the old 130s client timeout still
// completed and wrote a correct audit_runs row): the audit was never
// actually stuck, the client just gave up too early. This is still a
// client-side belt-and-suspenders on top of the server's own
// maxDuration=120 (see the audit route) -- not a claim that every run
// finishes by 240s, which is exactly why POLL_* below exists as a second
// layer instead of just raising this number and hoping.
const CLIENT_TIMEOUT_MS = 240000
// POLL_INTERVAL_MS / MAX_POLL_ATTEMPTS -- what happens once the client
// timeout above fires. Rather than show a dead-end error for a run that is
// (per the comment above) usually still working, keep checking this
// client's latest audit_runs row for up to MAX_POLL_ATTEMPTS *
// POLL_INTERVAL_MS more (here, 8 * 15s = 2 more minutes -- about 6 minutes
// total worst case) before finally admitting it's taking unusually long.
const POLL_INTERVAL_MS = 15000
const MAX_POLL_ATTEMPTS = 8

// latestRunId(clientId) -> the id of this client's most recent audit_runs
// row, or null (no runs yet, or the read failed). Reuses the existing GET
// /api/clients/[id] route (lib/data.js#getClientWithRuns already returns
// `runs` ordered newest-first) rather than adding a new endpoint -- this is
// a plain best-effort read, same "a failed read here isn't fatal" contract
// as the rest of this component.
async function latestRunId(clientId) {
  try {
    const res = await fetch(`/api/clients/${clientId}`)
    if (!res.ok) return null
    const body = await res.json()
    return Array.isArray(body.runs) && body.runs.length > 0 ? body.runs[0].id : null
  } catch (e) {
    return null
  }
}

export default function RunAuditButton({ clientId }) {
  const router = useRouter()
  const [running, setRunning] = useState(false)
  // longRunning -- true once the client-side timeout above has fired but
  // we're still polling for a NEW audit_runs row rather than admitting
  // failure. Deliberately separate from `running`/`error`: the button
  // becomes clickable again once `running` goes false (someone shouldn't
  // be stuck unable to do anything else for up to 6 minutes), but the
  // overlay/messaging stays honest about a check still being in progress.
  const [longRunning, setLongRunning] = useState(false)
  const [error, setError] = useState(null)
  const pollTimeoutRef = useRef(null)

  useEffect(() => () => {
    // Stop polling if the user navigates away mid-poll -- otherwise a
    // setState after unmount is a real (if harmless-looking) bug.
    if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current)
  }, [])

  async function pollForCompletion(previousRunId, attempt = 0) {
    const currentId = await latestRunId(clientId)
    if (currentId && currentId !== previousRunId) {
      setLongRunning(false)
      setError(null)
      router.refresh()
      return
    }
    if (attempt >= MAX_POLL_ATTEMPTS) {
      setLongRunning(false)
      setError('This audit is taking much longer than usual (6min+). It may still finish in the background -- refresh this page in a few minutes to check, or try again.')
      return
    }
    pollTimeoutRef.current = setTimeout(() => pollForCompletion(previousRunId, attempt + 1), POLL_INTERVAL_MS)
  }

  async function onClick() {
    setRunning(true)
    setLongRunning(false)
    setError(null)
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current)
      pollTimeoutRef.current = null
    }
    // Captured BEFORE the audit starts so polling can recognize "a NEW run
    // appeared" -- as opposed to just seeing the same (old) latest run and
    // wrongly concluding nothing has happened yet.
    const previousRunId = await latestRunId(clientId)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS)
    try {
      const res = await fetch(`/api/clients/${clientId}/audit`, { method: 'POST', signal: controller.signal })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Audit failed')
      router.refresh()
    } catch (err) {
      if (err.name === 'AbortError') {
        // Don't show a dead-end error yet -- see CLIENT_TIMEOUT_MS's own
        // comment on why this specific timeout firing does not mean the
        // run failed or is stuck.
        setLongRunning(true)
        pollForCompletion(previousRunId)
      } else {
        setError(err.message)
      }
    } finally {
      clearTimeout(timeout)
      setRunning(false)
    }
  }

  const busy = running || longRunning

  return (
    <div>
      <button onClick={onClick} disabled={busy} className="btn btn-primary" style={{ minWidth: 160 }}>
        {running ? 'Running audit...' : (longRunning ? 'Still checking...' : 'Run audit now')}
      </button>
      {error && <p className="field-error" style={{ marginTop: 8, textAlign: 'right', maxWidth: 260 }}>{error}</p>}

      {busy && (
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
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 6 }}>
              {running ? 'Running audit…' : 'Still running…'}
            </div>
            <p className="text-small text-muted" style={{ margin: 0 }}>
              {running
                ? "Usually under a minute, occasionally up to two. This page will update automatically when it's done."
                : "This one's taking longer than usual -- still checking. This page will update automatically the moment it's done."}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
