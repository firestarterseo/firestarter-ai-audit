const { listClientsWithLatestRun, createClient } = require('../../../lib/data')

async function GET() {
  try {
    const clients = await listClientsWithLatestRun()
    return Response.json({ clients })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}

async function POST(request) {
  try {
    const body = await request.json()
    const client = await createClient(body)
    return Response.json({ client }, { status: 201 })
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 })
  }
}

module.exports = { GET, POST }
