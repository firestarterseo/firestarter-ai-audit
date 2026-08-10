const fs = require('fs')
const path = require('path')
const { buildHtml } = require('../build-fixture-html')
const { checkSchemaAndStructure } = require('../checker')

async function main() {
  console.log('='.repeat(70))
  console.log('CASE 1: Denver Tax Advisor — live JSON-LD extracted from the real page')
  console.log('='.repeat(70))
  const dtaJsonLd = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/denvertaxadvisor.jsonld.json'), 'utf8'))
  const dtaHtml = buildHtml(dtaJsonLd, { title: 'Denver Tax Advisor (live JSON-LD)' })
  const dtaResult = await checkSchemaAndStructure(dtaHtml)
  console.log(JSON.stringify(dtaResult, null, 2))

  console.log('\n' + '='.repeat(70))
  console.log('CASE 2: Negative control — plain HTML, zero structured data')
  console.log('='.repeat(70))
  const noSchemaHtml = fs.readFileSync(path.join(__dirname, '../fixtures/no-schema.html'), 'utf8')
  const noSchemaResult = await checkSchemaAndStructure(noSchemaHtml)
  console.log(JSON.stringify(noSchemaResult, null, 2))
}

main()
