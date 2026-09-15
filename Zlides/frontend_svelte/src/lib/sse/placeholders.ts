export interface PlaceholderDef {
  type: string;
  id: string;
  markers: string[];
  accent?: string;
}

export const CANONICAL_PLACEHOLDERS: PlaceholderDef[] = [
  { type: "section", id: "vocabulary", markers: ['id="vocabulary"', "id='vocabulary'", 'data-category="vocabulary"'], accent: "#447F9F" },
  { type: "section", id: "phrasal-verbs", markers: ['id="phrasal-verbs"', "id='phrasal-verbs'", 'data-category="phrasal-verbs"'], accent: "#3B8484" },
  { type: "section", id: "collocations", markers: ['id="collocations"', "id='collocations'", 'data-category="collocations"'], accent: "#DE6E55" },
  { type: "section", id: "grammar", markers: ['id="grammar"', "id='grammar'", 'data-category="grammar"'], accent: "#B06D29" },
  { type: "section", id: "idioms-and-phrases", markers: ['id="idioms-and-phrases"', "id='idioms-and-phrases'", 'data-category="idioms-and-phrases"'], accent: "#62193D" },
  { type: "section", id: "focus-points", markers: ['id="focus-points"', "id='focus-points'", 'data-category="focus-points"'], accent: "#DCE62C" },
  { type: "section", id: "in-class-practice", markers: ['id="in-class-practice"', "id='in-class-practice'", 'data-category="in-class-practice"'], accent: "#B98CF0" },
  { type: "section", id: "self-study", markers: ['id="self-study"', "id='self-study'", 'data-category="self-study"'], accent: "#6FC3DF" },
  { type: "card", id: "card", markers: ['class="card"', "class='card'", 'data-category'] },
  { type: "dynamic-slot", id: "dynamic-slot", markers: ["dynamic-slot"] },
  { type: "regenerate-btn", id: "regenerate-btn", markers: ["regenerate-btn", 'data-prompt'] },
  { type: "blank", id: "blank", markers: ['class="blank"', "class='blank'", 'data-answer'] },
  { type: "option", id: "option", markers: ['class="option"', "class='option'", 'data-correct', 'data-rationale'] },
  { type: "pair", id: "data-pair", markers: ["data-pair"] },
];

const TOKENS = {
  bg: "#0f1112",
  surface: "#16181a",
  line: "#2e3236",
  lineSoft: "rgba(63, 63, 70, 0.50)",
  textHeading: "#ffffff",
  textBody: "#cfd3d8",
  muted: "#9ca3af",
  brand: "#ff6b35",
  brandSoft: "rgba(255, 107, 53, 0.12)",
};

function isPresent(html: string, ph: PlaceholderDef): boolean {
  return ph.markers.some((m) => html.includes(m));
}

function addRegenerateAttr(html: string, marker: string): string {
  const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*?)?>/g;
  return html.replace(tagRe, (full) => {
    if (!full.includes(marker)) return full;
    if (full.includes("data-regenerate")) return full;
    if (full.endsWith("/>")) return full.slice(0, -2) + ' data-regenerate="true"/>';
    return full.slice(0, -1) + ' data-regenerate="true">';
  });
}

function humanLabel(id: string): string {
  return id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildSectionPlaceholder(ph: PlaceholderDef): string {
  const accent = ph.accent ?? TOKENS.brand;
  const label = humanLabel(ph.id);
  return `<section id="${ph.id}" data-category="${ph.id}" data-regenerate="true" style="--accent:${accent};background:${TOKENS.surface};border:1px solid ${TOKENS.line};border-left:3px solid ${accent};border-radius:6px;padding:18px;margin:16px 0;color:${TOKENS.textBody}"><header style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid ${TOKENS.lineSoft};padding-bottom:10px;margin-bottom:12px"><h2 style="color:${TOKENS.textHeading};font-family:'Raleway',sans-serif;font-weight:800;font-size:16px;margin:0">${label}</h2><span style="font-size:12px;color:${TOKENS.muted};border:1px solid ${TOKENS.line};padding:2px 8px;border-radius:4px">${ph.id}</span></header><article class="card" data-category="${ph.id}" data-regenerate="true" style="position:relative;background:${TOKENS.surface};border:1px solid ${TOKENS.line};border-radius:4px;padding:14px 14px 14px 18px;overflow:hidden"><div class="dynamic-slot" data-regenerate="true" style="display:flex;flex-direction:column;gap:10px"><p style="color:${TOKENS.textBody};font-size:14px;margin:0">Practice placeholder for ${label}. <input class="blank" data-category="${ph.id}" data-answer="example" placeholder="..." data-regenerate="true" style="background:${TOKENS.bg};border:1px solid ${TOKENS.line};color:${TOKENS.textHeading};padding:4px 8px;border-radius:4px;min-width:120px" /></p><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="option" data-correct="true" data-rationale="Correct placeholder illustrates rationale." data-regenerate="true" style="background:color-mix(in srgb, ${accent} 12%, transparent);color:${accent};border:1px solid ${TOKENS.line};padding:6px 10px;border-radius:4px;font-size:13px"><span class="opt-badge" style="font-weight:700;margin-right:6px">A</span>Sample correct option</button><button class="option" data-correct="false" data-rationale="Distractor placeholder explains why it is incorrect." data-regenerate="true" style="background:transparent;color:${TOKENS.muted};border:1px solid ${TOKENS.line};padding:6px 10px;border-radius:4px;font-size:13px"><span class="opt-badge" style="font-weight:700;margin-right:6px">B</span>Sample distractor</button></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:4px"><button class="option" data-pair="pair-${ph.id}-1" data-correct="true" data-rationale="Matching pair rationale." data-regenerate="true" style="background:transparent;color:${TOKENS.muted};border:1px dashed ${TOKENS.line};padding:6px 10px;border-radius:4px;font-size:13px">Match A ↔ B</button></div><button class="regenerate-btn" data-category="${ph.id}" data-prompt="Generate 3 new exercises for category '${ph.id}' on '{{topic}}' targeting [{{target_concepts}}]. Return matching HTML .dynamic-slot content only." data-regenerate="true" style="align-self:flex-start;background:${TOKENS.brandSoft};color:${TOKENS.brand};border:1px solid ${TOKENS.line};padding:6px 12px;border-radius:4px;font-size:13px;font-weight:600;cursor:pointer">Regenerate ${label}</button></div></article></section>`;
}

function injectMissingSections(html: string): string {
  const sectionPlaceholders = CANONICAL_PLACEHOLDERS.filter((p) => p.type === "section");
  const missing = sectionPlaceholders.filter((p) => !isPresent(html, p));
  if (missing.length === 0) return html;
  const injection = missing.map(buildSectionPlaceholder).join("\n");
  if (html.includes("</main>")) return html.replace("</main>", injection + "\n</main>");
  if (html.includes("</body>")) return html.replace("</body>", injection + "\n</body>");
  if (html.includes("</html>")) return html.replace("</html>", injection + "\n</html>");
  return html + "\n" + injection;
}

function injectGlobalFallbacks(html: string): string {
  let out = html;
  const has = (m: string) => out.includes(m);
  if (!has("dynamic-slot")) {
    const slot = `<div class="dynamic-slot" data-regenerate="true" style="background:${TOKENS.surface};border:1px dashed ${TOKENS.line};border-radius:6px;padding:12px;margin:12px 0"></div>`;
    if (out.includes("</main>")) out = out.replace("</main>", slot + "\n</main>");
    else if (out.includes("</body>")) out = out.replace("</body>", slot + "\n</body>");
    else out += slot;
  }
  if (!has("regenerate-btn")) {
    const btn = `<button class="regenerate-btn" data-category="vocabulary" data-prompt="Generate 3 new exercises for category 'vocabulary' on '{{topic}}' targeting [{{target_concepts}}]. Return matching HTML .dynamic-slot content only." data-regenerate="true" style="background:${TOKENS.brandSoft};color:${TOKENS.brand};border:1px solid ${TOKENS.line};padding:6px 12px;border-radius:4px;font-size:13px;font-weight:600">Regenerate</button>`;
    if (out.includes("</main>")) out = out.replace("</main>", btn + "\n</main>");
    else if (out.includes("</body>")) out = out.replace("</body>", btn + "\n</body>");
    else out += btn;
  }
  if (!has('class="blank"') && !has("class='blank'") && !has("data-answer")) {
    const blank = `<p style="color:${TOKENS.textBody}"><input class="blank" data-category="vocabulary" data-answer="example" placeholder="..." data-regenerate="true" style="background:${TOKENS.bg};border:1px solid ${TOKENS.line};color:${TOKENS.textHeading};padding:4px 8px;border-radius:4px" /></p>`;
    if (out.includes("</main>")) out = out.replace("</main>", blank + "\n</main>");
    else if (out.includes("</body>")) out = out.replace("</body>", blank + "\n</body>");
    else out += blank;
  }
  if (!has('class="option"') && !has("class='option'") && !has("data-correct")) {
    const opt = `<button class="option" data-correct="true" data-rationale="Placeholder rationale." data-regenerate="true" style="background:color-mix(in srgb, ${TOKENS.brand} 12%, transparent);color:${TOKENS.brand};border:1px solid ${TOKENS.line};padding:6px 10px;border-radius:4px">Option</button>`;
    if (out.includes("</main>")) out = out.replace("</main>", opt + "\n</main>");
    else if (out.includes("</body>")) out = out.replace("</body>", opt + "\n</body>");
    else out += opt;
  }
  if (!has("data-pair")) {
    const pair = `<button class="option" data-pair="pair-fallback-1" data-correct="true" data-rationale="Matching pair." data-regenerate="true" style="background:transparent;color:${TOKENS.muted};border:1px dashed ${TOKENS.line};padding:6px 10px;border-radius:4px">Match placeholder</button>`;
    if (out.includes("</main>")) out = out.replace("</main>", pair + "\n</main>");
    else if (out.includes("</body>")) out = out.replace("</body>", pair + "\n</body>");
    else out += pair;
  }
  return out;
}

export function extractBodyInner(html: string): string {
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (m) return m[1].trim();
  return html
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<html[^>]*>/gi, "")
    .replace(/<\/html>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .trim();
}

export function extractHeadInner(html: string): string {
  const m = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  if (m) return m[1].trim();
  return '<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">';
}

export function assembleSingleDocument(pageHtmls: string[]): string {
  if (pageHtmls.length === 0) return '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="background:#0f1112"></body></html>';
  const sanitized = pageHtmls.map((p) => p.trim()).filter(Boolean);
  if (sanitized.length === 0) return pageHtmls[0];
  if (sanitized.length === 1 && (sanitized[0].match(/<!DOCTYPE/gi) || []).length <= 1 && !sanitized[0].includes("<!-- zlides:page-break -->")) {
    return sanitized[0];
  }
  const first = sanitized[0];
  let headInner = extractHeadInner(first);
  const responsiveFix = `\n<style>\nhtml,body{background:#0f1112 !important;margin:0;padding:0;}\nbody{overflow:auto !important;height:auto !important;min-height:100vh;color:#e5e7eb;}\n.slide{width:100% !important;max-width:1280px !important;margin:0 auto !important;height:auto !important;min-height:0 !important;max-width:100%;}\nmain{max-width:100%;}\n@media (max-width:1280px){.slide{max-width:100% !important;}}\n</style>`;
  if (!headInner.includes("background:#0f1112") && !headInner.includes("--bg")) {
    headInner += responsiveFix;
  } else {
    headInner += responsiveFix;
  }
  const bodies = sanitized.map(extractBodyInner).join('\n<div class="zlides-page-separator" style="height:1px;background:#2e3236;margin:24px 0;"></div>\n');
  return `<!DOCTYPE html>\n<html lang="en">\n<head>${headInner}\n</head>\n<body style="background:#0f1112;color:#e5e7eb;margin:0;padding:24px;max-width:100%;overflow:auto;">\n${bodies}\n</body>\n</html>`;
}

export function normalizeSavedHtml(html: string): string {
  const SEP = "<!-- zlides:page-break -->";
  if (html.includes(SEP)) {
    const parts = html.split(SEP).map((s) => s.trim()).filter(Boolean);
    return assembleSingleDocument(parts);
  }
  const dc = (html.match(/<!DOCTYPE/gi) || []).length;
  if (dc > 1) {
    const parts = html.split(/(?=<!DOCTYPE)/gi).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) return assembleSingleDocument(parts);
  }
  return html;
}

export function ensurePlaceholders(pageHtml: string): string {
  if (!pageHtml || pageHtml.trim().length === 0) {
    return injectMissingSections(injectGlobalFallbacks(pageHtml));
  }
  let html = pageHtml;
  for (const ph of CANONICAL_PLACEHOLDERS) {
    if (isPresent(html, ph)) {
      for (const marker of ph.markers) {
        if (html.includes(marker)) {
          html = addRegenerateAttr(html, marker);
        }
      }
    }
  }
  html = injectMissingSections(html);
  for (const ph of CANONICAL_PLACEHOLDERS) {
    if (isPresent(html, ph)) {
      for (const marker of ph.markers) {
        if (html.includes(marker)) {
          html = addRegenerateAttr(html, marker);
        }
      }
    }
  }
  html = injectGlobalFallbacks(html);
  for (const ph of CANONICAL_PLACEHOLDERS) {
    if (isPresent(html, ph)) {
      for (const marker of ph.markers) {
        if (html.includes(marker)) {
          html = addRegenerateAttr(html, marker);
        }
      }
    }
  }
  return html;
}
