'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// The Schema Generator UI -- see lib/schemaGenerator.js and ROADMAP.md for
// why this exists (83/85 clients in the old baseline spreadsheet had a
// schema-related recommendation; this generates and lets a strategist ship
// the fix directly, instead of just reporting the gap).
//
// Two states: an editable "business details" form (the raw facts the
// generator needs -- most of this is optional, since even a bare name+url
// node is valid, real schema), and a generated-output view with the
// JSON-LD, a ready <script> snippet, and a live preview grade showing what
// this exact markup would score in the Schema & Structure pillar --
// "checked before it ever ships," per the original plan.
export default function SchemaGenerator({ clientId, client, bare = false }) {
  const router = useRouter()
  const [form, setForm] = useState({
    street_address: client.street_address || '',
    postal_code: client.postal_code || '',
    phone: client.phone || '',
    description: client.description || '',
    same_as: (client.same_as || []).join('\n'),
    schema_type: client.schema_type || 'LocalBusiness'
  })
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null) // { jsonLd, scriptSnippet, missingFields, preview }
  const [copied, setCopied] = useState(null) // 'json' | 'snippet' | null

  function update(field, value) {
    setForm(f => ({ ...f, [field]: value }))
  }

  async function saveDetails() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          street_address: form.street_address,
          postal_code: form.postal_code,
          phone: form.phone,
          description: form.description,
          same_as: form.same_as.split('\n').map(s => s.trim()).filter(Boolean),
          schema_type: form.schema_type
        })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Save failed')
      router.refresh()
      return true
    } catch (err) {
      setError(err.message)
      return false
    } finally {
      setSaving(false)
    }
  }

  async function generate() {
    setGenerating(true)
    setError(null)
    try {
      const savedOk = await saveDetails()
      if (!savedOk) return
      const res = await fetch(`/api/clients/${clientId}/schema`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not generate schema')
      setResult(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setGenerating(false)
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

  return (
    <div className={bare ? undefined : 'card'} style={bare ? undefined : { padding: 18 }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Schema Generator</div>
      <p className="text-small text-muted" style={{ margin: '0 0 14px' }}>
        Generates a real, valid {form.schema_type} JSON-LD block from this client's own business
        facts -- ready to hand to a developer or paste in yourself.
      </p>

      <div style={{ display: 'grid', gap: 12, marginBottom: 14 }}>
        <div>
          <label className="field-label">Street address</label>
          <input className="field-input" style={{ marginBottom: 0 }} value={form.street_address} onChange={e => update('street_address', e.target.value)} placeholder="123 Main St" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label className="field-label">Postal code</label>
            <input className="field-input" style={{ marginBottom: 0 }} value={form.postal_code} onChange={e => update('postal_code', e.target.value)} placeholder="80202" />
          </div>
          <div>
            <label className="field-label">Phone</label>
            <input className="field-input" style={{ marginBottom: 0 }} value={form.phone} onChange={e => update('phone', e.target.value)} placeholder="(303) 555-0100" />
          </div>
        </div>
        <div>
          <label className="field-label">Description (1-2 sentences)</label>
          <input className="field-input" style={{ marginBottom: 0 }} value={form.description} onChange={e => update('description', e.target.value)} placeholder="What this business does, in its own words." />
        </div>
        <div>
          <label className="field-label">sameAs links (one per line -- Google Business Profile, LinkedIn, Facebook, etc.)</label>
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
        <button onClick={generate} disabled={generating || saving} className="btn btn-primary">
          {generating ? 'Generating...' : 'Save details & generate schema'}
        </button>
      </div>

      {error && <p className="field-error" style={{ marginTop: 12 }}>{error}</p>}

      {result && (
        <div style={{ marginTop: 18, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
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
        </div>
      )}
    </div>
  )
}
