// Talks to the "Firestarter AI Schema" companion WordPress plugin
// (wordpress-plugin/firestarter-ai-schema.php) on a client's own site --
// the last mile of Phase 3a from the original plan: a real "Publish"
// button instead of copy-pasting a <script> snippet by hand. The plugin
// exposes two REST routes once installed and activated:
//   POST /wp-json/firestarter-schema/v1/update  (auth required)  -- push new schema
//   GET  /wp-json/firestarter-schema/v1/status  (public)         -- read what's live
// Auth is WordPress's own native Application Passwords (WP 5.6+, Users ->
// Profile -> Application Passwords) -- no custom auth system of ours to
// build or trust; the token is scoped to whatever the WP user account can
// do and is revocable from that same screen at any time.

function siteOrigin(clientUrl) {
  try {
    return new URL(clientUrl).origin
  } catch (e) {
    return null
  }
}

// describePublishFailure(status, body) -> plain-English reason
// Same instinct as describePsiFailure() for PageSpeed Insights elsewhere in
// this project -- a bare HTTP status code tells a strategist nothing
// actionable. 404 almost always means the plugin isn't installed/activated
// yet; 401/403 almost always means the Application Password is wrong,
// revoked, or the account it belongs to lost the needed capability.
function describePublishFailure(status, body) {
  if (status === 404) {
    return 'The Firestarter AI Schema plugin doesn\'t appear to be installed and activated on this site yet -- install it, then try publishing again.'
  }
  if (status === 401 || status === 403) {
    return 'WordPress rejected the connection -- the Application Password may be wrong, revoked, or the account no longer has permission. Reconnect with a fresh Application Password.'
  }
  if (body && typeof body === 'object' && body.message) return String(body.message)
  return `WordPress returned an unexpected error (HTTP ${status}).`
}

// publishSchemaToWordPress({ url, wpUsername, wpAppPassword, jsonLd }) ->
//   { ok: true, updatedAt } | { ok: false, error }
// Never throws -- every failure mode (site unreachable, plugin missing,
// bad credentials, WP returning something unexpected) degrades to a
// returned { ok: false, error }, same "verify, don't guess, never crash
// the caller" pattern as every other live-fetch integration here.
async function publishSchemaToWordPress({ url, wpUsername, wpAppPassword, jsonLd }) {
  const origin = siteOrigin(url)
  if (!origin) return { ok: false, error: 'This client has no valid site URL to publish to.' }

  const endpoint = `${origin}/wp-json/firestarter-schema/v1/update`
  const auth = Buffer.from(`${wpUsername}:${wpAppPassword}`).toString('base64')

  let res
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`
      },
      body: JSON.stringify({ jsonLd })
    })
  } catch (e) {
    return { ok: false, error: `Could not reach ${origin} -- ${e.message}` }
  }

  let body = null
  try { body = await res.json() } catch (e) { /* non-JSON error body, e.g. a plain 404 page -- body stays null */ }

  if (!res.ok) {
    return { ok: false, error: describePublishFailure(res.status, body) }
  }

  return { ok: true, updatedAt: body?.updatedAt || null }
}

// checkWordPressSchemaStatus({ url }) -> { connected: true, hasSchema, jsonLd, updatedAt } | { connected: false, error }
// Deliberately no credentials needed -- the plugin's /status route is
// public (it only ever echoes what's already rendered, publicly, in the
// site's own <head>). This is what makes the plugin "double as the Schema
// pillar's live verification source" per the original plan: this tool can
// confirm what's actually published on the client's site at any time, not
// just trust that a past "Publish" click worked.
async function checkWordPressSchemaStatus({ url }) {
  const origin = siteOrigin(url)
  if (!origin) return { connected: false, error: 'This client has no valid site URL to check.' }

  const endpoint = `${origin}/wp-json/firestarter-schema/v1/status`
  let res
  try {
    res = await fetch(endpoint, { headers: { 'User-Agent': 'FirestarterAIAudit/1.0' } })
  } catch (e) {
    return { connected: false, error: `Could not reach ${origin} -- ${e.message}` }
  }

  if (!res.ok) {
    return { connected: false, error: describePublishFailure(res.status, null) }
  }

  let body
  try {
    body = await res.json()
  } catch (e) {
    return { connected: false, error: 'The plugin responded, but not with valid JSON -- it may be an old or incompatible version.' }
  }

  return { connected: true, hasSchema: !!body.hasSchema, jsonLd: body.jsonLd || null, updatedAt: body.updatedAt || null }
}

module.exports = { publishSchemaToWordPress, checkWordPressSchemaStatus }
