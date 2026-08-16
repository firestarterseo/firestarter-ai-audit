'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { BUSINESS_ENTITY_TYPES } from '../../../lib/businessEntityTypes'

// The Schema Generator UI -- see lib/schemaGenerator.js and ROADMAP.md for
// why this exists (83/85 clients in the old baseline spreadsheet had a
// schema-related recommendation; this generates and lets a strategist ship
// the fix directly, instead of just reporting the gap).
//
// On mount, this auto-fetches whatever the tool can detect from the
// client's own live homepage (existing partial schema, tel: links, social
// links, meta description) and pre-fills the form with it -- a strategist
// should be reviewing and confirming real data pulled from the site, not
// typing address/phone/social links/description in from a blank form when
// the site already has the answer. Fields that came from auto-detection
// are labeled as such; anything already saved on the client record is left
// alone.
// visibleSection ('form' | 'publish' | 'verify' | undefined) -- added for
// SchemaWizard.js's step-by-step UI (Phase 3): lets the wizard show only
// one slice of this component per step (Generate & review / Publish /
// Verify) while keeping a SINGLE mounted instance across all three steps,
// so its state (fetched schema preview, WordPress connection, live-status
// check result) survives navigating back and forth between those steps
// instead of re-fetching/resetting on every step change. undefined (the
// default, and every call site before this wizard existed) shows all three
// sections at once, unchanged from this component's original behavior.
export default function SchemaGenerator({ clientId, client, bare = false, visibleSection }) {
  const showForm = !visibleSection || visibleSection === 'form'
  const showPublish = !visibleSection || visibleSection === 'publish'
  const showVerify = !visibleSection || visibleSection === 'verify'
  const router = useRouter()
  const [form, setForm] = useState({
    street_address: client.street_address || '',
    city: client.city || '',
    region: client.region || '',
    postal_code: client.postal_code || '',
    phone: client.phone || '',
    description: client.description || '',
    same_as: (client.same_as || []).join('\n'),
    schema_type: client.schema_type || 'LocalBusiness'
  })
  const [autoFilled, setAutoFilled] = useState({}) // { field: true } for fields filled from detection, not the saved record
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true) // true during the initial auto-detect + preview fetch on mount
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null) // { jsonLd, scriptSnippet, missingFields, suggested, preview }

  const [copied, setCopied] = useState(null) // 'json' | 'snippet' | null

  // WordPress connect + publish -- see lib/wpPublish.js and the
  // wordpress-plugin/ companion plugin. wpForm never gets pre-filled from
  // `client` -- the Application Password is write-only from this tool's
  // point of view (see sanitizeClient in lib/data.js, which strips even the
  // encrypted value before it reaches this component), so there's nothing
  // to pre-fill even when already connected.
  const [wpForm, setWpForm] = useState({ wp_username: client.wp_username || '', wp_app_password: '' })
  const [wpConnected, setWpConnected] = useState(!!client.wp_connected)
  const [wpConnecting, setWpConnecting] = useState(false)
  const [wpPublishing, setWpPublishing] = useState(false)
  const [wpChecking, setWpChecking] = useState(false)
  const [wpMessage, setWpMessage] = useState(null) // { ok: boolean, text: string } -- connect/disconnect/publish-request errors only; a real check's own result renders as wpStatus below instead of a duplicate one-line echo of it
  const [wpStatus, setWpStatus] = useState(null) // last real GET /wp-json/firestarter-schema/v1/status response: { connected, hasSchema, jsonLd, updatedAt } | { connected: false, error }

  async function connectWordPress() {
    setWpConnecting(true)
    setWpMessage(null)
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wp_username: wpForm.wp_username, wp_app_password: wpForm.wp_app_password })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not connect')
      setWpConnected(true)
      setWpForm(f => ({ ...f, wp_app_password: '' })) // never keep the token in memory longer than the one request that sent it
      setWpMessage({ ok: true, text: 'Connected. You can publish schema to this site now.' })
      router.refresh()
    } catch (err) {
      setWpMessage({ ok: false, text: err.message })
    } finally {
      setWpConnecting(false)
    }
  }

  async function disconnectWordPress() {
    setWpConnecting(true)
    setWpMessage(null)
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wp_username: '', wp_app_password: '' })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not disconnect')
      setWpConnected(false)
      setWpForm({ wp_username: '', wp_app_password: '' })
      setWpMessage(null)
      setWpStatus(null) // a status check from the old connection is no longer meaningful once disconnected
      router.refresh()
    } catch (err) {
      setWpMessage({ ok: false, text: err.message })
    } finally {
      setWpConnecting(false)
    }
  }

  async function publishToWordPress() {
    setWpPublishing(true)
    setWpMessage(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/schema/publish`, { method: 'POST' })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error || 'Publish failed')
      router.refresh()
      // Don't just trust this POST response -- immediately re-check the
      // plugin's own public /status route so what the strategist sees next
      // is a real, independent confirmation that the publish actually
      // landed in the site's <head>, not merely that this request didn't
      // error. Same "verify, don't just trust the write succeeded" instinct
      // wpPublish.js already documents for why /status exists at all.
      await checkWordPressStatus()
    } catch (err) {
      setWpMessage({ ok: false, text: err.message })
    } finally {
      setWpPublishing(false)
    }
  }

  // Real live verification -- hits the plugin's public, no-auth /status
  // route (see lib/wpPublish.js) and stores the raw result in wpStatus,
  // rendered as its own persistent card below rather than folded into the
  // ephemeral wpMessage toast. Unlike Technical Foundation / Content
  // Authority, which only know their real state as of the last scheduled
  // audit, Schema can confirm exactly what's live on the site right now, at
  // any time -- this is what makes that true in the UI, not just in theory.
  async function checkWordPressStatus() {
    setWpChecking(true)
    try {
      const res = await fetch(`/api/clients/${clientId}/schema/status`)
      const data = await res.json()
      setWpStatus(data)
    } catch (err) {
      setWpStatus({ connected: false, error: err.message })
    } finally {
      setWpChecking(false)
    }
  }

  function update(field, value) {
    setForm(f => ({ ...f, [field]: value }))
    setAutoFilled(a => ({ ...a, [field]: false })) // a manual edit un-labels it as auto-detected
  }

  async function fetchGenerated() {
    const res = await fetch(`/api/clients/${clientId}/schema`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Could not generate schema')
    return data
  }

  // Runs once on mount -- this is what makes the panel show up already
  // populated and previewed, instead of an empty form waiting to be typed
  // into. Re-fetches suggestions every time the panel mounts (e.g. after a
  // save triggers router.refresh()) so a since-updated live homepage keeps
  // contributing fresh hints for whatever's still blank.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchGenerated()
      .then(data => {
        if (cancelled) return
        const suggested = data.suggested || {}
        if (Object.keys(suggested).length > 0) {
          setForm(f => ({
            ...f,
            street_address: f.street_address || suggested.street_address || f.street_address,
            city: f.city || suggested.city || f.city,
            region: f.region || suggested.region || f.region,
            postal_code: f.postal_code || suggested.postal_code || f.postal_code,
            phone: f.phone || suggested.phone || f.phone,
            description: f.description || suggested.description || f.description,
            same_as: f.same_as || (suggested.same_as ? suggested.same_as.join('\n') : f.same_as),
            // schema_type only ever arrives in `suggested` when the client was
            // still sitting at the DB default ('LocalBusiness') -- see
            // lib/schemaGenerator.js -- so it's always safe to apply here
            // without a form.schema_type-is-blank check like the others.
            schema_type: suggested.schema_type || f.schema_type
          }))
          setAutoFilled({
            street_address: !!suggested.street_address,
            city: !!suggested.city,
            region: !!suggested.region,
            postal_code: !!suggested.postal_code,
            phone: !!suggested.phone,
            description: !!suggested.description,
            same_as: !!suggested.same_as,
            schema_type: !!suggested.schema_type
          })
        }
        setResult(data)
      })
      .catch(err => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId])

  async function saveDetails() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          street_address: form.street_address,
          city: form.city,
          region: form.region,
          postal_code: form.postal_code,
          phone: form.phone,
          description: form.description,
          same_as: form.same_as.split('\n').map(s => s.trim()).filter(Boolean),
          schema_type: form.schema_type
        })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Save failed')
      const generated = await fetchGenerated()
      setResult(generated)
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  function copy(text, which) {
    navigator.clipboard?.writeText(text)
    setCopied(which)
    setTimeout(() => setCopied(null), 1500)
  }

  function download(text, filename) {
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const hasAnyAutoFilled = Object.values(autoFilled).some(Boolean)

  return (
    <div className={bare ? undefined : 'card'} style={bare ? undefined : { padding: 18 }}>
      {showForm && (
        <>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Schema Generator</div>
      <p className="text-small text-muted" style={{ margin: '0 0 14px' }}>
        Generates a real, valid {form.schema_type} JSON-LD block from this client's own business
        facts -- ready to hand to a developer or paste in yourself.
      </p>

      {loading && (
        <p className="text-small text-muted" style={{ margin: '0 0 14px' }}>Checking the live site for existing contact details...</p>
      )}
      {!loading && hasAnyAutoFilled && (
        <p className="text-tiny" style={{ margin: '0 0 14px', color: 'var(--grade-a)' }}>
          Auto-detected from {client.url} -- review below, then save. Fields marked (auto) came from the live site, not typed in.
        </p>
      )}

      <div style={{ display: 'grid', gap: 12, marginBottom: 14 }}>
        <div>
          <label className="field-label">
            Business type{autoFilled.schema_type && ' (auto -- detected from the site\'s existing schema or category, review before saving)'}
          </label>
          <select
            className="field-input"
            style={{ marginBottom: 0 }}
            value={form.schema_type}
            onChange={e => update('schema_type', e.target.value)}
          >
            {BUSINESS_ENTITY_TYPES.map(type => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
          <p className="text-tiny text-muted" style={{ margin: '4px 0 0' }}>
            A more specific type than the default "LocalBusiness" (e.g. AccountingService, Attorney, Dentist) doesn't change this
            pillar's own score, but it's more accurate and unlocks more of Google's rich-result features for this industry.
          </p>
        </div>
        <div>
          <label className="field-label">Street address{autoFilled.street_address && ' (auto)'}</label>
          <input className="field-input" style={{ marginBottom: 0 }} value={form.street_address} onChange={e => update('street_address', e.target.value)} placeholder="123 Main St" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
          <div>
            <label className="field-label">City{autoFilled.city && ' (auto)'}</label>
            <input className="field-input" style={{ marginBottom: 0 }} value={form.city} onChange={e => update('city', e.target.value)} placeholder="Denver" />
          </div>
          <div>
            <label className="field-label">State{autoFilled.region && ' (auto)'}</label>
            <input className="field-input" style={{ marginBottom: 0 }} value={form.region} onChange={e => update('region', e.target.value)} placeholder="CO" />
          </div>
          <div>
            <label className="field-label">Postal code{autoFilled.postal_code && ' (auto)'}</label>
            <input className="field-input" style={{ marginBottom: 0 }} value={form.postal_code} onChange={e => update('postal_code', e.target.value)} placeholder="80202" />
          </div>
        </div>
        <div>
          <label className="field-label">Phone{autoFilled.phone && ' (auto)'}</label>
          <input className="field-input" style={{ marginBottom: 0 }} value={form.phone} onChange={e => update('phone', e.target.value)} placeholder="(303) 555-0100" />
        </div>
        <div>
          <label className="field-label">Description (1-2 sentences){autoFilled.description && ' (auto, from the site\'s meta description -- review before saving)'}</label>
          <input className="field-input" style={{ marginBottom: 0 }} value={form.description} onChange={e => update('description', e.target.value)} placeholder="What this business does, in its own words." />
        </div>
        <div>
          <label className="field-label">sameAs links{autoFilled.same_as && ' (auto)'} -- one per line (Google Business Profile, LinkedIn, Facebook, etc.)</label>
          <textarea
            className="field-input"
            style={{ marginBottom: 0, minHeight: 70, fontFamily: 'monospace', fontSize: 12.5 }}
            value={form.same_as}
            onChange={e => update('same_as', e.target.value)}
            placeholder={'https://www.google.com/maps/place/...\nhttps://www.linkedin.com/company/...'}
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={saveDetails} disabled={saving || loading} className="btn btn-primary">
          {saving ? 'Saving...' : 'Save details & generate schema'}
        </button>
      </div>

      {error && <p className="field-error" style={{ marginTop: 12 }}>{error}</p>}
        </>
      )}

      {result && !loading && (showForm || showPublish || showVerify) && (
        <div style={showForm ? { marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--border)' } : undefined}>
          {showForm && (
            <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <div
              className={`grade-badge ${result.preview.grade?.startsWith('A') ? 'grade-a' : result.preview.grade?.startsWith('B') ? 'grade-b' : result.preview.grade?.startsWith('C') ? 'grade-c' : result.preview.grade?.startsWith('D') ? 'grade-d' : 'grade-f'}`}
              style={{ width: 30, height: 30, fontSize: 12 }}
            >
              {result.preview.grade || '--'}
            </div>
            <span className="text-small">
              This exact markup would score <b>{result.preview.score}/100</b> on Schema &amp; Structure.
            </span>
          </div>

          {result.missingFields.length > 0 && (
            <p className="text-tiny text-muted" style={{ margin: '0 0 14px' }}>
              Add these for a stronger result: {result.missingFields.join(', ')}. This is still valid, real schema without them -- just not maximally complete.
            </p>
          )}

          <label className="field-label">JSON-LD</label>
          <pre style={{ background: 'var(--bg-alt)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 12, fontSize: 12, overflowX: 'auto', margin: '0 0 8px' }}>
            {JSON.stringify(result.jsonLd, null, 2)}
          </pre>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
            <button className="btn btn-secondary" onClick={() => copy(JSON.stringify(result.jsonLd, null, 2), 'json')}>
              {copied === 'json' ? 'Copied!' : 'Copy JSON'}
            </button>
            <button className="btn btn-secondary" onClick={() => download(JSON.stringify(result.jsonLd, null, 2), `${clientId}-schema.json`)}>
              Download .json
            </button>
          </div>

          <label className="field-label">Ready-to-paste &lt;script&gt; snippet</label>
          <pre style={{ background: 'var(--bg-alt)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 12, fontSize: 12, overflowX: 'auto', margin: '0 0 8px' }}>
            {result.scriptSnippet}
          </pre>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-secondary" onClick={() => copy(result.scriptSnippet, 'snippet')}>
              {copied === 'snippet' ? 'Copied!' : 'Copy snippet'}
            </button>
            <button className="btn btn-secondary" onClick={() => download(result.scriptSnippet, `${clientId}-schema-snippet.html`)}>
              Download snippet (.html)
            </button>
          </div>
            </>
          )}

          {(showPublish || showVerify) && (
          <div style={showForm ? { marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--border)' } : undefined}>
            {showPublish && (
              <>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Publish to WordPress</div>
            <p className="text-small text-muted" style={{ margin: '0 0 12px' }}>
              For sites this tool can auto-update instead of pasting a snippet by hand: install the{' '}
              <a href="/firestarter-ai-schema.zip" download>Firestarter AI Schema plugin</a> once (Plugins &rarr; Add New &rarr; Upload
              Plugin), then generate an Application Password from that site's Users &rarr; Profile &rarr; Application Passwords screen
              and connect it below.
            </p>

            {!wpConnected ? (
              <div style={{ display: 'grid', gap: 10, maxWidth: 420 }}>
                <div>
                  <label className="field-label">WordPress username</label>
                  <input
                    className="field-input"
                    style={{ marginBottom: 0 }}
                    value={wpForm.wp_username}
                    onChange={e => setWpForm(f => ({ ...f, wp_username: e.target.value }))}
                    placeholder="admin"
                  />
                </div>
                <div>
                  <label className="field-label">Application Password</label>
                  <input
                    type="password"
                    className="field-input"
                    style={{ marginBottom: 0 }}
                    value={wpForm.wp_app_password}
                    onChange={e => setWpForm(f => ({ ...f, wp_app_password: e.target.value }))}
                    placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"
                    autoComplete="new-password"
                  />
                </div>
                <div>
                  <button
                    className="btn btn-primary"
                    disabled={wpConnecting || !wpForm.wp_username || !wpForm.wp_app_password}
                    onClick={connectWordPress}
                  >
                    {wpConnecting ? 'Connecting...' : 'Connect WordPress'}
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="pill pill-tracked">Connected as {client.wp_username || wpForm.wp_username}</span>
                <button className="btn btn-primary" disabled={wpPublishing} onClick={publishToWordPress}>
                  {wpPublishing ? 'Publishing...' : 'Publish to WordPress'}
                </button>
                <button className="btn btn-secondary" disabled={wpConnecting} onClick={disconnectWordPress}>
                  Disconnect
                </button>
                {client.wp_last_published_at && (
                  <span className="text-tiny text-muted">Last published {new Date(client.wp_last_published_at).toLocaleString()}</span>
                )}
              </div>
            )}

            {wpMessage && (
              <p className={wpMessage.ok ? 'text-small' : 'field-error'} style={{ marginTop: 10, color: wpMessage.ok ? 'var(--grade-a)' : undefined }}>
                {wpMessage.text}
              </p>
            )}
              </>
            )}

            {/* Verify -- moved out of the Publish button row (Phase 3) so
                SchemaWizard.js can show this as its own step-panel. Requires
                a connection to mean anything -- there's nothing to verify
                until schema has actually been published somewhere. */}
            {showVerify && (
              <div style={showPublish ? { marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--border)' } : undefined}>
                {!wpConnected ? (
                  <p className="text-small text-muted">Connect WordPress in the Publish step first -- there's nothing to verify until schema has actually been published somewhere.</p>
                ) : (
                  <>
                    <button className="btn btn-secondary" disabled={wpChecking} onClick={checkWordPressStatus}>
                      {wpChecking ? 'Checking...' : (wpStatus ? 'Re-check status' : 'Check live status')}
                    </button>
                    {wpStatus && (
                      <div className="issue-item" style={{ marginTop: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                          <span
                            className="issue-badge"
                            style={{ background: !wpStatus.connected ? 'var(--grade-f)' : wpStatus.hasSchema ? 'var(--grade-a)' : 'var(--grade-d)' }}
                          >
                            {!wpStatus.connected ? 'Live check failed' : wpStatus.hasSchema ? 'Confirmed live' : 'Reachable -- not live yet'}
                          </span>
                          <span className="text-tiny text-muted">GET /wp-json/firestarter-schema/v1/status</span>
                        </div>
                        {wpStatus.connected ? (
                          <p className="text-small" style={{ margin: 0 }}>
                            {wpStatus.hasSchema
                              ? "This exact schema is live in the site's <head> right now"
                              : 'The plugin is reachable, but no schema has been published yet'}
                            {wpStatus.updatedAt && ` -- last updated ${new Date(wpStatus.updatedAt).toLocaleString()}`}
                          </p>
                        ) : (
                          <p className="text-small" style={{ margin: 0, color: 'var(--red)' }}>{wpStatus.error || 'Could not reach the site.'}</p>
                        )}
                        <p className="text-tiny text-muted" style={{ margin: '6px 0 0' }}>
                          Unlike pillars that only know their real state as of the last scheduled audit, this checks the live site directly -- no
                          need to wait for the next run to confirm a fix actually took.
                        </p>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
          )}
        </div>
      )}
    </div>
  )
}
