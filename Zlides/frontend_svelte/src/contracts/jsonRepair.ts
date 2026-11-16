/**
 * Models emit unescaped quotes and raw newlines inside JSON strings. Repair rather
 * than discard a whole generation: escape stray quotes, escape control characters,
 * drop trailing commas.
 */
export function repairJson(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === '\\') { out += ch; escaped = true; continue; }
      if (ch === '"') {
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        const next = text[j];
        if (next === ':' || next === ',' || next === '}' || next === ']' || next === undefined) {
          inString = false;
          out += ch;
          continue;
        }
        out += '\\"';
        continue;
      }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}
