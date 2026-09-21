// Tests for lib/schemaPageContentEvidence.js -- reusable page-content
// evidence primitive (Phase A, 2026-09-21). Plain `node`, no framework,
// matching this codebase's existing lib/*.test.js convention.

const assert = require('assert')
const {
  EVIDENCE_CLASSES, MAX_HEADINGS, MAX_PARAGRAPHS, MAX_PARAGRAPH_LENGTH,
  MAX_LIST_ITEMS, MAX_LINKS, MAX_TOTAL_TEXT_CHARS,
  extractPageContentEvidence
} = require('./schemaPageContentEvidence')

let passCount = 0
function test(name, fn) {
  fn()
  passCount++
  console.log(`PASS: ${name}`)
}

function wrap(body) {
  return `<!doctype html><html lang="en"><head><title>Title Here</title></head><body>${body}</body></html>`
}

// TEST 1: title extraction.
test('title tag is extracted as DOCUMENT_METADATA', () => {
  const r = extractPageContentEvidence(wrap('<h1>X</h1>'))
  assert.strictEqual(r.documentMetadata.title.value, 'Title Here')
  assert.strictEqual(r.documentMetadata.title.evidenceClass, 'DOCUMENT_METADATA')
  assert.strictEqual(r.documentMetadata.title.sourceType, 'title_tag')
})

// TEST 2: meta description extraction.
test('meta description is extracted', () => {
  const html = '<html><head><title>T</title><meta name="description" content="A real description."></head><body><h1>X</h1></body></html>'
  const r = extractPageContentEvidence(html)
  assert.strictEqual(r.documentMetadata.metaDescription.value, 'A real description.')
  assert.strictEqual(r.documentMetadata.metaDescription.evidenceClass, 'DOCUMENT_METADATA')
})

// TEST 2b: missing meta description -> UNAVAILABLE, never fabricated.
test('missing meta description -> UNAVAILABLE, reason not_present', () => {
  const r = extractPageContentEvidence(wrap('<h1>X</h1>'))
  assert.strictEqual(r.documentMetadata.metaDescription.value, null)
  assert.strictEqual(r.documentMetadata.metaDescription.evidenceClass, 'UNAVAILABLE')
  assert.strictEqual(r.documentMetadata.metaDescription.reason, 'not_present')
})

// TEST 3: canonical link extraction.
test('canonical link is extracted', () => {
  const html = '<html><head><title>T</title><link rel="canonical" href="https://example.com/page/"></head><body><h1>X</h1></body></html>'
  const r = extractPageContentEvidence(html)
  assert.strictEqual(r.documentMetadata.canonical.value, 'https://example.com/page/')
})

// TEST 4: lang extraction.
test('html lang attribute is extracted', () => {
  const r = extractPageContentEvidence(wrap('<h1>X</h1>'))
  assert.strictEqual(r.documentMetadata.lang.value, 'en')
})

// TEST 4b: missing lang -> UNAVAILABLE.
test('missing lang -> UNAVAILABLE', () => {
  const html = '<html><head><title>T</title></head><body><h1>X</h1></body></html>'
  const r = extractPageContentEvidence(html)
  assert.strictEqual(r.documentMetadata.lang.evidenceClass, 'UNAVAILABLE')
})

// TEST 5: exactly one H1.
test('a single H1 is extracted with level 1 and headingCounts.h1 = 1', () => {
  const r = extractPageContentEvidence(wrap('<h1>Real Heading</h1>'))
  assert.strictEqual(r.headings.length, 1)
  assert.strictEqual(r.headings[0].level, 1)
  assert.strictEqual(r.headings[0].value, 'Real Heading')
  assert.strictEqual(r.headingCounts.h1, 1)
})

// TEST 6: multiple H1s -- headingCounts must reflect the TRUE total, never
// undercounted by the array-length cap (this is what a caller's "exactly
// one H1" ambiguity check depends on).
test('multiple H1s are all counted in headingCounts, never silently dropped', () => {
  const r = extractPageContentEvidence(wrap('<h1>First</h1><p>mid</p><h1>Second</h1>'))
  assert.strictEqual(r.headingCounts.h1, 2)
  assert.strictEqual(r.headings.filter(h => h.level === 1).length, 2)
})

// TEST 7: H2/H3 extraction with correct levels.
test('H2 and H3 are extracted with correct levels', () => {
  const r = extractPageContentEvidence(wrap('<h1>H1</h1><h2>H2 text</h2><h3>H3 text</h3>'))
  const levels = r.headings.map(h => h.level)
  assert.deepStrictEqual(levels, [1, 2, 3])
  assert.strictEqual(r.headings[1].value, 'H2 text')
  assert.strictEqual(r.headings[2].value, 'H3 text')
})

// TEST 8: nested markup inside a heading is flattened to its real text --
// exactly the case regex tag-stripping cannot safely handle.
test('nested inline markup inside a heading is flattened to real text', () => {
  const r = extractPageContentEvidence(wrap('<h1>Real <b>Bold</b> and <em>Emph</em> Heading</h1>'))
  assert.strictEqual(r.headings[0].value, 'Real Bold and Emph Heading')
})

// TEST 9: paragraph extraction.
test('paragraphs are extracted in document order', () => {
  const r = extractPageContentEvidence(wrap('<h1>X</h1><p>First para.</p><p>Second para.</p>'))
  assert.strictEqual(r.paragraphs.length, 2)
  assert.strictEqual(r.paragraphs[0].value, 'First para.')
  assert.strictEqual(r.paragraphs[1].value, 'Second para.')
  assert.strictEqual(r.paragraphs[0].order, 0)
  assert.strictEqual(r.paragraphs[1].order, 1)
})

// TEST 10: list item extraction.
test('list items are extracted', () => {
  const r = extractPageContentEvidence(wrap('<h1>X</h1><ul><li>One</li><li>Two</li></ul>'))
  assert.deepStrictEqual(r.listItems.map(li => li.value), ['One', 'Two'])
})

// TEST 11: link extraction (href + anchor text).
test('links are extracted with href and anchor text', () => {
  const r = extractPageContentEvidence(wrap('<h1>X</h1><p>See <a href="/contact/">Contact us</a> for details.</p>'))
  assert.strictEqual(r.links.length, 1)
  assert.strictEqual(r.links[0].href, '/contact/')
  assert.strictEqual(r.links[0].anchorText, 'Contact us')
  assert.strictEqual(r.links[0].containerTag, 'p')
})

// TEST 12: script/style/noscript excluded.
test('script, style, and noscript content is never extracted', () => {
  const html = wrap('<h1>X</h1><script>var x = "<p>fake</p>";</script><style>.a{color:red}</style><noscript><p>no-js paragraph</p></noscript>')
  const r = extractPageContentEvidence(html)
  assert.strictEqual(r.paragraphs.length, 0)
})

// TEST 13: nav/footer excluded.
test('nav and footer subtrees are excluded from headings/paragraphs/links', () => {
  const html = wrap('<nav><a href="/nav-link">Nav link</a></nav><h1>Real H1</h1><p>Real para</p><footer><p>Footer para</p><a href="/footer-link">Footer link</a></footer>')
  const r = extractPageContentEvidence(html)
  assert.strictEqual(r.paragraphs.length, 1)
  assert.strictEqual(r.paragraphs[0].value, 'Real para')
  assert.strictEqual(r.links.length, 0)
  assert.strictEqual(r.headingCounts.h1, 1)
})

// TEST 13b: a deterministically-identifiable cookie/consent overlay is excluded.
test('a cookie/consent overlay (id/class match) is excluded', () => {
  const html = wrap('<h1>Real H1</h1><div id="cookie-consent-banner"><p>We use cookies</p><a href="/privacy">Privacy</a></div><p>Real para</p>')
  const r = extractPageContentEvidence(html)
  assert.strictEqual(r.paragraphs.length, 1)
  assert.strictEqual(r.paragraphs[0].value, 'Real para')
  assert.strictEqual(r.links.length, 0)
})

// TEST 14: malformed HTML never throws -- parse5's tolerant parsing still
// yields a usable (if partial) result.
test('malformed/unclosed HTML never throws', () => {
  assert.doesNotThrow(() => {
    const r = extractPageContentEvidence('<html><head><title>Broken<body><h1>Unclosed h1<p>para without closing')
    assert.strictEqual(r.extractionStatus, 'success')
  })
})

// TEST 14b: completely invalid input (not a string) fails gracefully.
test('non-string input fails gracefully with extractionStatus failed, never throws', () => {
  assert.doesNotThrow(() => {
    const r = extractPageContentEvidence(null)
    assert.strictEqual(r.extractionStatus, 'failed')
    assert.strictEqual(r.documentMetadata.title.evidenceClass, 'UNAVAILABLE')
  })
  assert.doesNotThrow(() => {
    const r = extractPageContentEvidence('')
    assert.strictEqual(r.extractionStatus, 'failed')
  })
})

// TEST 15: missing fields (no title, no h1 at all) -> UNAVAILABLE / empty,
// never fabricated placeholders.
test('a page with no title and no headings reports UNAVAILABLE/empty honestly', () => {
  const html = '<html><body><p>Only a paragraph, no heading at all.</p></body></html>'
  const r = extractPageContentEvidence(html)
  assert.strictEqual(r.documentMetadata.title.evidenceClass, 'UNAVAILABLE')
  assert.strictEqual(r.headings.length, 0)
  assert.strictEqual(r.headingCounts.h1, 0)
})

// TEST 16: heading count bound -- MAX_HEADINGS caps the captured array, but
// headingCounts must still reflect the true total beyond the cap.
test('headings array is capped at MAX_HEADINGS but headingCounts.h1 reflects the true total', () => {
  const many = Array.from({ length: MAX_HEADINGS + 10 }, (_, i) => `<h1>Heading ${i}</h1>`).join('')
  const r = extractPageContentEvidence(wrap(many))
  assert.ok(r.headings.length <= MAX_HEADINGS)
  assert.strictEqual(r.headingCounts.h1, MAX_HEADINGS + 10)
  assert.strictEqual(r.bounds.headingsTruncated, true)
})

// TEST 17: paragraph count bound.
test('paragraphs array is capped at MAX_PARAGRAPHS', () => {
  const many = Array.from({ length: MAX_PARAGRAPHS + 5 }, (_, i) => `<p>Para ${i} with enough distinct text to count.</p>`).join('')
  const r = extractPageContentEvidence(wrap(`<h1>X</h1>${many}`))
  assert.ok(r.paragraphs.length <= MAX_PARAGRAPHS)
  assert.strictEqual(r.bounds.paragraphsTruncated, true)
})

// TEST 18: paragraph length bound + truncated flag.
test('an overlong paragraph is truncated and flagged, not dropped', () => {
  const longText = 'x'.repeat(MAX_PARAGRAPH_LENGTH + 500)
  const r = extractPageContentEvidence(wrap(`<h1>X</h1><p>${longText}</p>`))
  assert.strictEqual(r.paragraphs[0].value.length, MAX_PARAGRAPH_LENGTH)
  assert.strictEqual(r.paragraphs[0].truncated, true)
})

// TEST 19: list item count bound.
test('listItems array is capped at MAX_LIST_ITEMS', () => {
  const many = Array.from({ length: MAX_LIST_ITEMS + 5 }, (_, i) => `<li>Item ${i}</li>`).join('')
  const r = extractPageContentEvidence(wrap(`<h1>X</h1><ul>${many}</ul>`))
  assert.ok(r.listItems.length <= MAX_LIST_ITEMS)
  assert.strictEqual(r.bounds.listItemsTruncated, true)
})

// TEST 20: link count bound.
test('links array is capped at MAX_LINKS', () => {
  const many = Array.from({ length: MAX_LINKS + 5 }, (_, i) => `<a href="/l${i}/">Link ${i}</a>`).join('')
  const r = extractPageContentEvidence(wrap(`<h1>X</h1>${many}`))
  assert.ok(r.links.length <= MAX_LINKS)
  assert.strictEqual(r.bounds.linksTruncated, true)
})

// TEST 21: total-text bound -- even under the per-array caps, the SUM of
// extracted text never exceeds MAX_TOTAL_TEXT_CHARS.
test('total extracted text across headings/paragraphs/list items never exceeds MAX_TOTAL_TEXT_CHARS', () => {
  const bigParas = Array.from({ length: MAX_PARAGRAPHS }, (_, i) => `<p>${'y'.repeat(MAX_PARAGRAPH_LENGTH)}</p>`).join('')
  const r = extractPageContentEvidence(wrap(`<h1>X</h1>${bigParas}`))
  assert.ok(r.bounds.totalTextCharsUsed <= MAX_TOTAL_TEXT_CHARS)
})

// TEST 22: article metadata (published/modified time, author) extraction.
test('article:published_time / article:modified_time / author meta are extracted', () => {
  const html = '<html><head><title>T</title>' +
    '<meta property="article:published_time" content="2026-01-01T00:00:00Z">' +
    '<meta property="article:modified_time" content="2026-02-01T00:00:00Z">' +
    '<meta name="author" content="Jane Doe">' +
    '</head><body><h1>X</h1></body></html>'
  const r = extractPageContentEvidence(html)
  assert.strictEqual(r.articleMetadata.publishedTime.value, '2026-01-01T00:00:00Z')
  assert.strictEqual(r.articleMetadata.modifiedTime.value, '2026-02-01T00:00:00Z')
  assert.strictEqual(r.articleMetadata.author.value, 'Jane Doe')
})

// TEST 23: EVIDENCE_CLASSES exposes the full shared enum, including classes
// this module never itself produces (owned by other pipeline stages).
test('EVIDENCE_CLASSES exposes the full 7-value shared enum', () => {
  assert.deepStrictEqual(EVIDENCE_CLASSES, [
    'OBSERVED_PAGE_CONTENT', 'OBSERVED_STRUCTURED_DATA', 'DOCUMENT_METADATA',
    'CLIENT_CONFIRMED', 'DERIVED_STRUCTURAL', 'INFERRED', 'UNAVAILABLE'
  ])
})

console.log(`\n${passCount} passed.`)
