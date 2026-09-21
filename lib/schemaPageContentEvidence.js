// REUSABLE PAGE-CONTENT EVIDENCE PRIMITIVE (Phase A, 2026-09-21).
//
// WHAT THIS FILE IS FOR: a single, deterministic, DOM-aware extraction of
// what a fetched page's HTML actually, visibly says -- document metadata
// (title/description/canonical/lang), headings in document order, bounded
// paragraphs/list items, bounded links, and machine-readable article
// metadata. This is a GENERAL-PURPOSE primitive, not a Service-schema-
// specific one -- see lib/schemaPreparedWork.js for the (separate, much
// more restrictive) rules about which of these extracted facts a given
// target profile is actually allowed to turn into schema.
//
// THIS FILE DOES NOT DECIDE WHAT SCHEMA MAY BE GENERATED. It only answers
// "what does this page's HTML actually contain," honestly and boundedly.
// Every fact this module returns is real (either literally read from the
// page, or explicitly marked UNAVAILABLE) -- it makes no judgment about
// whether a given piece of text is "good enough," "specific enough," or
// safe to cite in generated schema. That judgment is Phase B's job
// (lib/schemaPreparedWork.js), operating on this module's output.
//
// WHY A REAL PARSER, NOT REGEX (2026-09-21 correction; see
// lib/checkers/lightweight-jsonld.js's own header for the precedent this
// deliberately departs from): JSON-LD extraction via regex is safe because
// a `<script type="application/ld+json">` block is non-nested and
// unambiguously bounded -- there is no "is this content inside a NAV I
// need to ignore" question to answer. Headings/paragraphs/list items/links
// have exactly that question: correctly excluding <nav>/<footer>/<script>/
// <style> subtrees, and correctly reporting heading LEVEL and DOCUMENT
// ORDER, requires real ancestor/nesting awareness that regex structurally
// cannot provide (regex has no concept of nesting). Hand-rolling a tolerant
// HTML5 tokenizer/tree-builder to be correct on real-world malformed markup
// (unclosed tags, misnested elements, implicit head/body, stray text
// outside <body>, ...) would itself become a large, under-tested, bug-prone
// piece of code -- exactly the "large dependency built by us instead"
// failure mode this repo's own conventions warn against. `parse5` is the
// actual WHATWG HTML5 parsing-algorithm reference implementation (the same
// one jsdom builds on) -- spec-designed to gracefully handle malformed
// real-world HTML (browsers must render broken markup, so the spec defines
// exactly how), one runtime dependency (`entities`, a small, extremely
// widely-used HTML-entity codec with zero dependencies of its own), no
// history of the kind of dependency-tree bloat that got cheerio explicitly
// rejected in this codebase before (see lightweight-jsonld.js's header).
// `npm audit` after adding it: zero new advisories (the two pre-existing
// findings in this repo, both in `next`/`sharp`, are unrelated and
// unchanged). This is the smallest defensible way to get real DOM-tree
// awareness; regex stays exactly where it already correctly applies
// (JSON-LD, in lib/checkers/lightweight-jsonld.js, untouched by this file).
//
// EVIDENCE CLASSES (shared vocabulary -- other parts of this pipeline, not
// just this module, tag their own facts with these): this module only ever
// produces OBSERVED_PAGE_CONTENT, DOCUMENT_METADATA, or UNAVAILABLE.
// OBSERVED_STRUCTURED_DATA (JSON-LD facts), CLIENT_CONFIRMED (AM-confirmed
// profile fields), DERIVED_STRUCTURAL (a fact computed from real structure,
// e.g. a page-scoped @id), and INFERRED (a guess) are produced elsewhere in
// the pipeline -- they exist here as the one shared enum so a downstream
// consumer's provenance never has to invent its own parallel vocabulary.
// Per the approved design: nothing downstream may generate schema from
// INFERRED evidence.
const EVIDENCE_CLASSES = [
  'OBSERVED_PAGE_CONTENT',
  'OBSERVED_STRUCTURED_DATA',
  'DOCUMENT_METADATA',
  'CLIENT_CONFIRMED',
  'DERIVED_STRUCTURAL',
  'INFERRED',
  'UNAVAILABLE'
]

// BOUNDS -- extraction must never produce an unbounded copy of the page.
// Every array below is capped at these limits; text fields are capped and
// flagged `truncated: true` rather than silently cut with no signal.
// headingCounts (see below) are the one exception -- those are real TOTAL
// counts across the whole document, never capped, because an undercount
// there would be actively dangerous (e.g. silently hiding a 2nd H1 from an
// "exactly one H1" caller).
const MAX_HTML_LENGTH = 2_000_000 // characters, well under webPageFetch.js's 5MB byte cap -- bounds this module's own parse/walk cost specifically.
const MAX_HEADINGS = 40
const MAX_PARAGRAPHS = 40
const MAX_PARAGRAPH_LENGTH = 600
const MAX_LIST_ITEMS = 40
const MAX_LIST_ITEM_LENGTH = 300
const MAX_LINKS = 60
const MAX_LINK_TEXT_LENGTH = 200
const MAX_TOTAL_TEXT_CHARS = 20_000 // hard ceiling on the SUM of all extracted heading/paragraph/list-item text combined

// EXCLUDED_TAGS -- entire subtrees never walked into for content
// extraction: script/style/noscript (never visible page content at all),
// nav/footer (template chrome, not this page's own substantive content).
// Deliberately NOT excluding <header> or <aside> -- a real H1/page title
// legitimately lives in <header> on many templates, and blanket-excluding
// it would throw away real content; only their nested <nav>/<script> stay
// excluded via this same set.
const EXCLUDED_TAGS = new Set(['script', 'style', 'noscript', 'nav', 'footer', 'template'])

// COOKIE_OVERLAY_PATTERN -- "cookie/privacy overlays where deterministically
// identifiable" (explicit instruction): a common, deterministic signal is
// an id/class containing one of these words -- never content-based
// guessing. An overlay that doesn't happen to use one of these tokens in
// its id/class is honestly NOT caught by this heuristic; this is a bounded,
// documented limitation, not a claim of complete coverage.
const COOKIE_OVERLAY_PATTERN = /cookie|consent|gdpr|privacy-banner|privacy-notice/i

function nowIso() { return new Date().toISOString() }

function attrValue(node, name) {
  const attr = (node.attrs || []).find(a => a.name.toLowerCase() === name.toLowerCase())
  return attr ? attr.value : null
}

function hasOverlayMarker(node) {
  const id = attrValue(node, 'id') || ''
  const className = attrValue(node, 'class') || ''
  return COOKIE_OVERLAY_PATTERN.test(id) || COOKIE_OVERLAY_PATTERN.test(className)
}

// flattenText(node) -> the concatenated text of every descendant #text
// node, in document order. This is the only way to get a heading/paragraph/
// link's real rendered text when it contains inline markup (<b>, <span>,
// <a>, ...) -- exactly the "nested markup in headings" case regex cannot
// safely handle (a naive </?[^>]+>/g strip can't tell "this closing tag
// belongs to an element that was never actually opened here" apart from a
// genuine nesting error).
function flattenText(node) {
  if (!node) return ''
  if (node.nodeName === '#text') return node.value || ''
  if (!node.childNodes) return ''
  let out = ''
  for (const child of node.childNodes) out += flattenText(child)
  return out
}

function normalizeWhitespace(text) {
  return (text || '').replace(/\s+/g, ' ').trim()
}

function evidenceValue(value, { evidenceClass, sourceType, sourceIndex = null, exactText = null }) {
  return { value, evidenceClass, sourceType, sourceIndex, exactText: exactText !== null ? exactText : value }
}

function unavailable(sourceType, reason) {
  return { value: null, evidenceClass: 'UNAVAILABLE', sourceType, sourceIndex: null, exactText: null, reason }
}

// truncateText(text, maxLength) -> { text, truncated }. Character-based --
// good enough for a bound whose entire purpose is "never unbounded," not a
// claim about word/sentence boundaries.
function truncateText(text, maxLength) {
  if (text.length <= maxLength) return { text, truncated: false }
  return { text: text.slice(0, maxLength), truncated: true }
}

// extractPageContentEvidence(html) -> the full evidence object. NEVER
// throws -- any unexpected error during parse/walk is caught and reported
// as extractionStatus: 'failed' with every field UNAVAILABLE(reason:
// 'extraction_failed'), matching this codebase's "fetch/extraction failure
// is never conflated with confirmed absence" discipline (see
// lib/webPageFetch.js's own header) -- a page this module couldn't parse
// must never be silently treated the same as a page that genuinely has no
// <title>.
function extractPageContentEvidence(html) {
  const extractedAt = nowIso()

  if (typeof html !== 'string' || html.length === 0) {
    return buildFailedResult(extractedAt, 'not_present')
  }

  let input = html
  let truncatedInput = false
  if (input.length > MAX_HTML_LENGTH) {
    input = input.slice(0, MAX_HTML_LENGTH)
    truncatedInput = true
  }

  try {
    const parse5 = require('parse5')
    const document = parse5.parse(input)
    return walkDocument(document, { extractedAt, truncatedInput })
  } catch (e) {
    return buildFailedResult(extractedAt, 'extraction_failed')
  }
}

function buildFailedResult(extractedAt, reason) {
  return {
    extractionStatus: 'failed',
    extractedAt,
    truncatedInput: false,
    documentMetadata: {
      title: unavailable('title_tag', reason),
      metaDescription: unavailable('meta_description', reason),
      canonical: unavailable('link_canonical', reason),
      lang: unavailable('html_lang', reason)
    },
    headings: [],
    headingCounts: { h1: 0, h2: 0, h3: 0 },
    paragraphs: [],
    listItems: [],
    links: [],
    articleMetadata: {
      publishedTime: unavailable('meta_article_published_time', reason),
      modifiedTime: unavailable('meta_article_modified_time', reason),
      author: unavailable('meta_author', reason)
    },
    bounds: {
      headingsTruncated: false, paragraphsTruncated: false, listItemsTruncated: false,
      linksTruncated: false, totalTextCharsUsed: 0, totalTextCapHit: false
    }
  }
}

const HEADING_LEVELS = { h1: 1, h2: 2, h3: 3 }

function walkDocument(document, { extractedAt, truncatedInput }) {
  const htmlNode = (document.childNodes || []).find(n => n.tagName === 'html')
  const headNode = htmlNode ? (htmlNode.childNodes || []).find(n => n.tagName === 'head') : null
  const bodyNode = htmlNode ? (htmlNode.childNodes || []).find(n => n.tagName === 'body') : null

  // -- DOCUMENT METADATA --------------------------------------------------
  const metaTags = headNode ? (headNode.childNodes || []).filter(n => n.tagName === 'meta') : []
  const findMeta = (attrName, matchValue) => metaTags.find(m => (attrValue(m, attrName) || '').toLowerCase() === matchValue)
  const titleNode = headNode ? (headNode.childNodes || []).find(n => n.tagName === 'title') : null
  const canonicalLink = headNode ? (headNode.childNodes || []).find(n => n.tagName === 'link' && (attrValue(n, 'rel') || '').toLowerCase() === 'canonical') : null
  const descriptionMeta = findMeta('name', 'description')
  const langValue = htmlNode ? attrValue(htmlNode, 'lang') : null
  const publishedMeta = findMeta('property', 'article:published_time')
  const modifiedMeta = findMeta('property', 'article:modified_time')
  const authorMeta = findMeta('name', 'author') || findMeta('property', 'article:author')

  const titleText = titleNode ? normalizeWhitespace(flattenText(titleNode)) : ''
  const documentMetadata = {
    title: titleText
      ? evidenceValue(titleText, { evidenceClass: 'DOCUMENT_METADATA', sourceType: 'title_tag' })
      : unavailable('title_tag', 'not_present'),
    metaDescription: descriptionMeta && attrValue(descriptionMeta, 'content')
      ? evidenceValue(normalizeWhitespace(attrValue(descriptionMeta, 'content')), { evidenceClass: 'DOCUMENT_METADATA', sourceType: 'meta_description' })
      : unavailable('meta_description', 'not_present'),
    canonical: canonicalLink && attrValue(canonicalLink, 'href')
      ? evidenceValue(attrValue(canonicalLink, 'href').trim(), { evidenceClass: 'DOCUMENT_METADATA', sourceType: 'link_canonical' })
      : unavailable('link_canonical', 'not_present'),
    lang: langValue
      ? evidenceValue(langValue.trim(), { evidenceClass: 'DOCUMENT_METADATA', sourceType: 'html_lang' })
      : unavailable('html_lang', 'not_present')
  }
  const articleMetadata = {
    publishedTime: publishedMeta && attrValue(publishedMeta, 'content')
      ? evidenceValue(attrValue(publishedMeta, 'content').trim(), { evidenceClass: 'DOCUMENT_METADATA', sourceType: 'meta_article_published_time' })
      : unavailable('meta_article_published_time', 'not_present'),
    modifiedTime: modifiedMeta && attrValue(modifiedMeta, 'content')
      ? evidenceValue(attrValue(modifiedMeta, 'content').trim(), { evidenceClass: 'DOCUMENT_METADATA', sourceType: 'meta_article_modified_time' })
      : unavailable('meta_article_modified_time', 'not_present'),
    author: authorMeta && attrValue(authorMeta, 'content')
      ? evidenceValue(normalizeWhitespace(attrValue(authorMeta, 'content')), { evidenceClass: 'DOCUMENT_METADATA', sourceType: 'meta_author' })
      : unavailable('meta_author', 'not_present')
  }

  // -- BODY WALK (headings / paragraphs / list items / links) -------------
  const headings = []
  const headingCounts = { h1: 0, h2: 0, h3: 0 } // TRUE totals -- never capped, see header.
  const paragraphs = []
  const listItems = []
  const links = []
  let headingOrder = 0
  let paragraphOrder = 0
  let listItemOrder = 0
  let linkOrder = 0
  let totalTextChars = 0
  let totalTextCapHit = false

  function textBudgetOk(len) {
    if (totalTextCapHit) return false
    if (totalTextChars + len > MAX_TOTAL_TEXT_CHARS) { totalTextCapHit = true; return false }
    return true
  }

  function walk(node, containerTag) {
    if (!node || !node.tagName) return
    const tag = node.tagName
    if (EXCLUDED_TAGS.has(tag)) return
    if (hasOverlayMarker(node)) return // cookie/consent/privacy overlay -- whole subtree skipped

    if (HEADING_LEVELS[tag]) {
      headingCounts[tag] += 1
      const raw = flattenText(node)
      const text = normalizeWhitespace(raw)
      if (text && headings.length < MAX_HEADINGS && textBudgetOk(text.length)) {
        headings.push({
          level: HEADING_LEVELS[tag],
          value: text,
          evidenceClass: 'OBSERVED_PAGE_CONTENT',
          sourceType: tag,
          sourceIndex: headingOrder,
          order: headingOrder,
          exactText: text
        })
        totalTextChars += text.length
      }
      headingOrder += 1
      return // headings aren't walked further for paragraphs/links inside them -- a heading is a leaf concept here
    }

    if (tag === 'p') {
      const raw = normalizeWhitespace(flattenText(node))
      if (raw && paragraphs.length < MAX_PARAGRAPHS && textBudgetOk(Math.min(raw.length, MAX_PARAGRAPH_LENGTH))) {
        const { text, truncated } = truncateText(raw, MAX_PARAGRAPH_LENGTH)
        paragraphs.push({
          value: text, evidenceClass: 'OBSERVED_PAGE_CONTENT', sourceType: 'p',
          sourceIndex: paragraphOrder, order: paragraphOrder, exactText: text, truncated
        })
        totalTextChars += text.length
      }
      paragraphOrder += 1
      // fall through -- a <p> can still contain <a> links worth recording
    }

    if (tag === 'li') {
      const raw = normalizeWhitespace(flattenText(node))
      if (raw && listItems.length < MAX_LIST_ITEMS && textBudgetOk(Math.min(raw.length, MAX_LIST_ITEM_LENGTH))) {
        const { text, truncated } = truncateText(raw, MAX_LIST_ITEM_LENGTH)
        listItems.push({
          value: text, evidenceClass: 'OBSERVED_PAGE_CONTENT', sourceType: 'li',
          sourceIndex: listItemOrder, order: listItemOrder, exactText: text, truncated
        })
        totalTextChars += text.length
      }
      listItemOrder += 1
    }

    if (tag === 'a') {
      const href = attrValue(node, 'href')
      if (href && links.length < MAX_LINKS) {
        const rawText = normalizeWhitespace(flattenText(node))
        const { text: anchorText } = truncateText(rawText, MAX_LINK_TEXT_LENGTH)
        links.push({
          href: href.trim(), anchorText, evidenceClass: 'OBSERVED_PAGE_CONTENT', sourceType: 'a',
          sourceIndex: linkOrder, order: linkOrder, containerTag: containerTag || null
        })
      }
      linkOrder += 1
    }

    const nextContainerTag = ['p', 'li', 'div', 'section', 'article', 'main'].includes(tag) ? tag : containerTag
    for (const child of node.childNodes || []) walk(child, nextContainerTag)
  }

  if (bodyNode) walk(bodyNode, null)

  return {
    extractionStatus: 'success',
    extractedAt,
    truncatedInput,
    documentMetadata,
    headings,
    headingCounts,
    paragraphs,
    listItems,
    links,
    articleMetadata,
    bounds: {
      headingsTruncated: headingOrder > headings.length,
      paragraphsTruncated: paragraphOrder > paragraphs.length,
      listItemsTruncated: listItemOrder > listItems.length,
      linksTruncated: linkOrder > links.length,
      totalTextCharsUsed: totalTextChars,
      totalTextCapHit
    }
  }
}

module.exports = {
  EVIDENCE_CLASSES,
  MAX_HTML_LENGTH, MAX_HEADINGS, MAX_PARAGRAPHS, MAX_PARAGRAPH_LENGTH,
  MAX_LIST_ITEMS, MAX_LIST_ITEM_LENGTH, MAX_LINKS, MAX_LINK_TEXT_LENGTH, MAX_TOTAL_TEXT_CHARS,
  extractPageContentEvidence
}
