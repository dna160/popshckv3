/**
 * Article Crawler Service
 *
 * Fetches a URL and extracts its readable plain-text content.
 * Used by the Researcher to supplement RSS summaries with the
 * full article body before fact extraction.
 *
 * Edge cases handled:
 *   - Network / DNS errors         → returns ''
 *   - Timeout (>8 s)               → returns ''
 *   - Non-200 responses            → returns ''
 *   - Non-HTML content types       → returns ''
 *   - JavaScript-only SPAs         → returns whatever static HTML is present
 *   - Paywalled content            → returns partial text (first visible paragraphs)
 *   - Oversized pages              → truncated to MAX_CONTENT_CHARS
 */

const CRAWL_TIMEOUT_MS  = 8_000;
const MAX_CONTENT_CHARS = 5_000; // ~750–1000 words; enough for fact extraction

// Block-level tags whose entire subtree should be discarded before text extraction
const STRIP_TAGS = [
  'script', 'style', 'noscript', 'svg', 'canvas',
  'nav', 'header', 'footer', 'aside',
  'form', 'button', 'input', 'select', 'textarea',
  'figure',  // keep <figcaption> text if desired — remove if noisy
];

function stripBlockTags(html: string): string {
  let out = html;
  for (const tag of STRIP_TAGS) {
    // Non-greedy removal of the full tag and its inner content
    out = out.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
    // Self-closing variants
    out = out.replace(new RegExp(`<${tag}[^>]*\\/?>`, 'gi'), ' ');
  }
  return out;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#\d+;/g, ' ');
}

/**
 * Crawl a URL and return its readable plain-text content.
 * Returns an empty string on any failure — callers must handle this
 * gracefully by falling back to the RSS summary.
 */
export async function crawlUrl(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CRAWL_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PopshckBot/1.0; +https://popshck.com)',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.8,id;q=0.6',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) return '';

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return '';
    }

    const html = await response.text();

    // Strip noisy block tags, then all remaining HTML tags
    const stripped = stripBlockTags(html);
    const tagless  = stripped.replace(/<[^>]+>/g, ' ');
    const decoded  = decodeEntities(tagless);

    // Collapse whitespace and trim
    const clean = decoded.replace(/\s+/g, ' ').trim();

    return clean.length > MAX_CONTENT_CHARS
      ? clean.slice(0, MAX_CONTENT_CHARS) + '…'
      : clean;

  } catch {
    // Swallow all errors (timeout, DNS, TLS, etc.) — caller falls back to summary
    return '';
  }
}
