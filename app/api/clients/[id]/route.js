const { getClientWithRuns } = require('../../../../lib/data')

async function GET(request, { params }) {
  try {
    const result = await getClientWithRuns(params.id)
    return Response.json(result)
  } catch (err) {
    return Response.json({ error: err.message }, { status: 404 })
  }
}

module.exports = { GET }
