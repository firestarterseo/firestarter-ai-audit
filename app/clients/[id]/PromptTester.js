'use client'

import { useState } from 'react'

const ENGINE_LABELS = {
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
  copilot: 'Copilot',
  google: 'Google'
}

export default function PromptTester({ clientId, bare = false }) {
  const [prompt, setPrompt] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  async function onSubmit(e) {
    e.preventDefault()
    if (!prompt.trim()) return
    setRunning(true)
    setError(null)
    setResult(null)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 130000)
    try {
      const res = await fetch(`/api/clients/${clientId}/test-prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim() }),
        signal: controller.signal
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Prompt test failed')
      setResult(data)
    } catch (err) {
      setError(err.name === 'AbortError' ? 'Taking longer than expected (2min+) -- try again.' : err.message)
    } finally {
      clearTimeout(timeout)
      setRunning(false)
    }
  }

  return (
    <div className={bare ? undefined : 'card'} style={bare ? undefined : { padding: 18 }}>
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Test a prompt</div>
      <p className="text-small text-muted" style={{ margin: '0 0 14px' }}>
        Fires this exact phrasing at all 5 AI engines live, right now. Not graded, not saved to history --
        for exploring how different search phrasings perform.
      </p>
      <form onSubmit={onSubmit} style={{ display: 'flex', gap: 10 }}>
        <input
          className="field-input"
          style={{ marginBottom: 0, flex: 1 }}
          placeholder='e.g. "best SEO Denver"'
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
        />
        <button type="submit" disabled={running || !prompt.trim()} className="btn btn-secondary" style={{ minWidth: 100 }}>
          {running ? 'Testing...' : 'Test'}
        </button>
      </form>

      {error && <p className="field-error" style={{ marginTop: 12 }}>{error}</p>}

      {result && (
        <div style={{ marginTop: 16 }}>
          <div className="meta-line" style={{ marginBottom: 8 }}>
            Prompt used: <b style={{ color: 'var(--text)' }}>&ldquo;{result.prompt}&rdquo;</b>
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            {(result.result?._raw?.engineResults || []).map(e => (
              <div key={e.engine} className="text-small" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--bg-alt)', borderRadius: 'var(--radius-sm)' }}>
                <span style={{ fontWeight: 600, minWidth: 90 }}>{ENGINE_LABELS[e.engine] || e.engine}</span>
                {!e.ok ? (
                  <span className="text-muted">call failed ({e.error})</span>
                ) : (
                  <>
                    <span style={{ color: e.mentioned ? 'var(--grade-a)' : 'var(--grade-f)', fontWeight: 600 }}>
                      {e.mentioned ? 'Mentioned' : 'Not mentioned'}
                    </span>
                    {e.mentioned && (
                      <>
                        <span className="text-muted">{e.cited ? 'cited/sourced' : 'not cited'}</span>
                        <span className="text-muted">sentiment: {e.sentiment || 'undetermined'}</span>
                      </>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
