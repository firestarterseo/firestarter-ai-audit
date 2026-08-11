const { trackAllClients } = require('../../../../lib/trackAiVisibility')

// Triggered weekly by Vercel Cron (see vercel.json -- "0 8 * * 1", Monday
// 08:00 UTC; Hobby-plan cron jobs cannot run more than once/day and Vercel
// only guarantees +/-59min precision on Hobby, both confirmed against
// current docs, same as the maxDuration research below).
//
// Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` on
// cron-triggered requests when a CRON_SECRET env var is set on the
// project -- checking it here stops anyone who finds this URL from
// triggering paid Cloro calls on demand. Add CRON_SECRET as a Vercel env
// var the same way as the other env vars. Unlike SUPABASE_SERVICE_ROLE_KEY
// or CLORO_API_KEY, this isn't a credential to any third-party account --
// it's just a shared secret between Vercel's own scheduler and this one
// endpoint, so it's fine for this codebase to define/reference its name.
//
// maxDuration: this can iterate multiple tracked clients (sequential
// per-client, concurrent per-client across all its prompt x engine calls --
// see trackAiVisibility.js). Set generously below Vercel's real Hobby-plan
// ceiling of 300s (verified live against Vercel's docs for the audit route,
// see that file's comment) rather than guessing a smaller number.
const maxDuration = 280

async function GET(request) {
  if (process.env.CRON_SECRET) {
    const auth = request.headers.get('authorization')
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    const result = await trackAllClients()
    return Response.json(result)
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}

module.exports = { GET, maxDuration }
