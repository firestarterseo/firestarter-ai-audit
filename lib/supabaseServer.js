// Server-only Supabase client. Uses the service_role key, which bypasses
// RLS -- that's intentional here, since every table has RLS enabled with
// zero policies (see the enable_rls_deny_by_default migration) precisely
// so that ONLY server-side code with the service_role key can touch data.
// This file must never be imported from a Client Component.
//
// SUPABASE_SERVICE_ROLE_KEY is never fetched or persisted by the assistant
// that built this app -- it must be pasted into Vercel's Environment
// Variables by a human with dashboard access (Supabase Project Settings ->
// API -> service_role), matching the "keys go in Vercel, never on disk"
// pattern this project has followed throughout.

const { createClient } = require('@supabase/supabase-js')

let cached = null

function getSupabaseServerClient() {
  if (cached) return cached
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (in Vercel env vars for deployed use, or .env.local for local dev).')
  }
  cached = createClient(url, key, { auth: { persistSession: false } })
  return cached
}

module.exports = { getSupabaseServerClient }
