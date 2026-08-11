'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

const MIN_PROMPTS = 3
const MAX_PROMPTS = 7

export default function TestPromptsManager({ clientId, savedPrompts }) {
  const router = useRouter()
  const [suggesting, setSuggesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  // null = not editing (just showing the current saved/automatic state).
  // Once suggestions are fetched (or "edit" is clicked), this holds the
  // full candidate+saved pool with a checked/unchecked selection.
  const [pool, setPool] = useState(null)
  const [customInput, setCustomInput] = useState('')

  const saved = savedPrompts || []
  const isConfirmed = saved.length > 0

  async function loadSuggestions() {
    setSuggesting(true)
    setError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/test-prompts`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not load suggestions')
      const combined = Array.from(new Set([...saved, ...data.candidates]))
      setPool(combined.map(text => ({ text, checked: saved.includes(text) || saved.length === 0 })))
    } catch (err) {
      setError(err.message)
    } finally {
      setSuggesting(false)
    }
  }

  function toggle(text) {
    setPool(p => p.map(item => item.text === text ? { ...item, checked: !item.checked } : item))
  }

  function addCustom() {
    const text = customInput.trim()
    if (!text) return
    setPool(p => {
      if (p.some(item => item.text === text)) return p
      return [...p, { text, checked: true }]
    })
    setCustomInput('')
  }

  const checkedCount = pool ? pool.filter(i => i.checked).length : 0
  const canSave = checkedCount === 0 || (checkedCount >= MIN_PROMPTS && checkedCount <= MAX_PROMPTS)

  async function save(promptsToSave) {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/test-prompts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompts: promptsToSave })
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Save failed')
      setPool(null)
      router.refresh()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card" style={{ padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>AI-visibility test terms</div>
        <span className={`pill ${isConfirmed ? 'pill-tracked' : 'pill-lead'}`} style={{ marginLeft: 'auto' }}>
          {isConfirmed ? `confirmed -- ${saved.length} term(s)` : 'automatic basket'}
        </span>
      </div>
      <p className="text-small text-muted" style={{ margin: '0 0 14px' }}>
        {isConfirmed
          ? 'The graded audit tests exactly these terms across all 5 engines. Edit below to change them.'
          : `No confirmed terms yet -- every audit auto-generates a fresh basket of realistic phrasings instead. Optionally review and lock in ${MIN_PROMPTS}-${MAX_PROMPTS} specific terms below for tighter control.`}
      </p>

      {!pool && isConfirmed && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {saved.map(p => (
            <span key={p} className="pill pill-tracked" style={{ textTransform: 'none' }}>{p}</span>
          ))}
        </div>
      )}

      {!pool && (
        <button onClick={loadSuggestions} disabled={suggesting} className="btn btn-secondary">
          {suggesting ? 'Loading suggestions...' : isConfirmed ? 'Edit confirmed terms' : 'Review & confirm terms'}
        </button>
      )}

      {pool && (
        <div>
          <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
            {pool.map(item => (
              <label key={item.text} className="text-small" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', background: 'var(--bg-alt)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>
                <input type="checkbox" checked={item.checked} onChange={() => toggle(item.text)} />
                {item.text}
              </label>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
            <input
              className="field-input"
              style={{ marginBottom: 0, flex: 1 }}
              placeholder="Add a custom term..."
              value={customInput}
              onChange={e => setCustomInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustom() } }}
            />
            <button type="button" onClick={addCustom} className="btn btn-secondary" style={{ minWidth: 90 }}>Add</button>
          </div>

          <div className="text-tiny text-muted" style={{ marginBottom: 10 }}>
            {checkedCount} selected -- {checkedCount === 0
              ? `save with 0 to revert to fully automatic, or select ${MIN_PROMPTS}-${MAX_PROMPTS} to confirm a set.`
              : canSave ? 'ready to save.' : `need ${MIN_PROMPTS}-${MAX_PROMPTS} selected (or 0 for automatic).`}
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={() => save(pool.filter(i => i.checked).map(i => i.text))}
              disabled={saving || !canSave}
              className="btn btn-primary"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button onClick={() => setPool(null)} disabled={saving} className="btn btn-secondary">Cancel</button>
          </div>
        </div>
      )}

      {error && <p className="field-error" style={{ marginTop: 12 }}>{error}</p>}
    </div>
  )
}
