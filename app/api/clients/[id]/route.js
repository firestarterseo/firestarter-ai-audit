const { getClientWithRuns } = require('../../../../lib/data')

async function GET(request, { params }) {
  try {
    const { id } = await params
    const result = await getClientWithRuns(id)
    return Response.json(result)
  } catch (err) {
    return Response.json({ error: err.message }, { status: 404 })
  }
}

module.exports = { GET }
