/**
 * Answer-phase HTML rescue decoder.
 *
 * The agent sometimes returns the full document as answer-phase text instead
 * of through add_slide tool calls. Observed transport shapes:
 *   a) raw HTML, possibly wrapped in prose or markdown code fences
 *   b) a JSON-string-encoded artifact: <!DOCTYPE html>\n<html lang=\"en\">...
 *   c) a JSON envelope object: {"html": ...} / {"content": ...}
 *
 * Pure decoding keyed on structural markers only — never content sniffing.
 * Returns a clean standalone document string, or null when the text carries
 * no document structure.
 */

/**
 * Decodes JSON-string transport escape sequences (\n, \r, \t, \", \\, \/, \uXXXX)
 * from HTML payloads streamed by the Z.AI model.
 *
 * Preserves normal unescaped characters, leaves non-escaped strings untouched,
 * and handles mixed escape states safely.
 */
export function decodeHtmlPayload(raw: string): string {
  if (!raw || !raw.includes('\\')) return raw;
  return raw.replace(/\\(?:(["\\\/bfnrt])|u([0-9a-fA-F]{4}))/g, (match, p1, p2) => {
    if (p1) {
      switch (p1) {
        case '"': return '"';
        case '\\': return '\\';
        case '/': return '/';
        case 'b': return '\b';
        case 'f': return '\f';
        case 'n': return '\n';
        case 'r': return '\r';
        case 't': return '\t';
        default: return match;
      }
    }
    if (p2) {
      return String.fromCharCode(parseInt(p2, 16));
    }
    return match;
  });
}

function hasDocStructure(s: string): boolean {
  const lower = s.toLowerCase();
  const hasDoctype = s.includes('<!DOCTYPE') || lower.includes('<!doctype');
  const hasHtml = lower.includes('<html');
  const hasBody = lower.includes('<body');
  return (hasDoctype && hasBody) || (hasHtml && hasBody);
}

function docStartIndex(s: string): number {
  const m = s.match(/<!DOCTYPE|<html[\s>]/i);
  return m && m.index !== undefined ? m.index : -1;
}

export function rescueDocumentFromAnswer(raw: string): string | null {
  if (!raw || !raw.trim()) return null;
  let candidate = raw.trim();

  // (1) JSON envelope: whole-payload string or {html|content} object.
  if (candidate.startsWith('{') || candidate.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === 'string') candidate = parsed.trim();
      else if (parsed !== null && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        const inner = typeof obj.html === 'string' ? obj.html
          : typeof obj.content === 'string' ? obj.content : undefined;
        if (inner !== undefined) candidate = inner.trim();
      }
    } catch { /* not JSON — keep raw */ }
  }

  // (2) Decode transport escapes so tags like <!DOCTYPE and </html> can be matched cleanly
  candidate = decodeHtmlPayload(candidate);

  // (3) Markdown code fence strip (only if the inner block has doc structure).
  const fenceRe = new RegExp('```(?:html)?\\s*\\n?([\\s\\S]*?)```');
  const fence = candidate.match(fenceRe);
  if (fence && hasDocStructure(fence[1])) candidate = fence[1].trim();

  // (4) Document span: first DOCTYPE/html -> last </html>. Kills prose
  //     prefixes (model musing) and epilogues around the document.
  const start = docStartIndex(candidate);
  const end = candidate.toLowerCase().lastIndexOf('</html>');
  if (start >= 0 && end > start) {
    candidate = candidate.slice(start, end + '</html>'.length);
  } else if (start >= 0 && (candidate.toLowerCase().includes('<body') || candidate.toLowerCase().includes('<main'))) {
    candidate = candidate.slice(start);
  } else {
    return null;
  }

  // (5) Ensure final decode
  candidate = decodeHtmlPayload(candidate);

  return hasDocStructure(candidate) ? candidate : null;
}
