// Wraps a JSON-LD fixture (array of schema.org objects/graphs) into a minimal
// HTML document with one <script type="application/ld+json"> block per array
// entry -- mirroring how Denver Tax Advisor's live page actually ships it
// (one Yoast @graph block + one custom AccountingService block).
const fs = require('fs')

function buildHtml(jsonLdArray, { title = 'Fixture' } = {}) {
  const scripts = jsonLdArray
    .map(obj => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`)
    .join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
${scripts}
</head>
<body>
<h1>${title}</h1>
<p>Fixture page for local schema validation.</p>
</body>
</html>`
}

module.exports = { buildHtml }

// CLI usage: node build-fixture-html.js fixtures/denvertaxadvisor.jsonld.json out.html
if (require.main === module) {
  const [, , inputPath, outputPath] = process.argv
  const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
  const html = buildHtml(data, { title: inputPath })
  fs.writeFileSync(outputPath, html)
  console.log(`Wrote ${outputPath}`)
}
