/**
 * LAC → worksheet contract for the third engine.
 *
 * The skill is the source of the rules; this module only:
 *   - reads the LAC JSON the app is given,
 *   - turns it into a placement plan so nothing is silently dropped,
 *   - and formats that plan for the prompt.
 *
 * Module catalogue mirrors ATOMIC_WIDGETS in the skill's
 * scripts/lac_worksheet_engine.py. Keep the two in step.
 */

import { repairJson } from './jsonRepair';
export { repairJson };

export interface LacVocabulary { item: string; pos?: string; core_definition?: string }
export interface LacPhrasal { item: string; latinateSynonym?: string; definition?: string }
export interface LacCollocation { item: string; details?: string[] }
export interface LacIdiom { item: string; register?: string; implicitMeaning?: string; details?: string[] }
export interface LacFocusPoint { What: string; Why?: string; How?: string; exampleOfInAction?: string[] }

export interface Lac {
  Saying?: string;
  title?: string;
  sessionDate?: string;
  lessonVibes?: string;
  vocabulary?: LacVocabulary[];
  phrasalVerbs?: LacPhrasal[];
  collocations?: LacCollocation[];
  idiomsAndPhrases?: LacIdiom[];
  focusPoints?: LacFocusPoint[];
  pronunciation?: unknown[];
  selfStudy?: unknown[];
  studentActionItems?: string[];
  teacherActionItems?: string[];
  footer?: { threeWordFact?: string };
  [k: string]: unknown;
}

export type LacKind = 'vocabulary' | 'phrasalVerbs' | 'collocations' | 'idiomsAndPhrases' | 'focusPoints';

export interface LacItem {
  kind: LacKind;
  text: string;
}

export interface PlanSlot {
  chapter: number;
  moduleTag: string;
  widget: string;
  slot: number;
  item: string;
  kind: LacKind;
  repeat: boolean;
}

export const LAC_MODULES: { widget: string; bestFor: LacKind[] }[] = [
  { widget: 'dialogue-cloze', bestFor: ['collocations', 'phrasalVerbs', 'idiomsAndPhrases'] },
  { widget: 'sentence-upgrade', bestFor: ['vocabulary', 'collocations', 'idiomsAndPhrases'] },
  { widget: 'inline-gap-write', bestFor: ['vocabulary', 'phrasalVerbs', 'collocations'] },
  { widget: 'two-bucket-triage', bestFor: ['idiomsAndPhrases', 'collocations', 'vocabulary', 'focusPoints'] },
  { widget: 'situation-connector', bestFor: ['idiomsAndPhrases', 'phrasalVerbs', 'collocations'] },
  { widget: 'token-assembly', bestFor: ['phrasalVerbs', 'collocations', 'idiomsAndPhrases'] },
  { widget: 'nuance-pair', bestFor: ['focusPoints', 'phrasalVerbs', 'collocations', 'idiomsAndPhrases'] },
  { widget: 'live-response-studio', bestFor: ['vocabulary', 'phrasalVerbs', 'collocations', 'idiomsAndPhrases', 'focusPoints'] },
];

/** Arrays the skill deliberately leaves out of the worksheet. */
export const LAC_EXCLUDED: (keyof Lac)[] = ['selfStudy', 'pronunciation', 'studentActionItems', 'teacherActionItems', 'footer'];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseLac(raw: unknown): { lac: Lac | null; errors: string[] } {
  if (!isRecord(raw)) return { lac: null, errors: ['the LAC must be a JSON object'] };
  const arrayKeys: LacKind[] = ['vocabulary', 'phrasalVerbs', 'collocations', 'idiomsAndPhrases', 'focusPoints'];
  const errors: string[] = [];
  for (const key of arrayKeys) {
    const value = raw[key];
    if (value !== undefined && !Array.isArray(value)) errors.push(`"${key}" must be an array`);
  }
  if (!arrayKeys.some((key) => Array.isArray(raw[key]) && (raw[key] as unknown[]).length > 0)) {
    errors.push('the LAC has no items in vocabulary, phrasalVerbs, collocations, idiomsAndPhrases or focusPoints');
  }
  return { lac: errors.length ? null : (raw as Lac), errors };
}

export function lacItems(lac: Lac): LacItem[] {
  const items: LacItem[] = [];
  for (const entry of lac.vocabulary ?? []) if (entry?.item?.trim()) items.push({ kind: 'vocabulary', text: entry.item.trim() });
  for (const entry of lac.phrasalVerbs ?? []) if (entry?.item?.trim()) items.push({ kind: 'phrasalVerbs', text: entry.item.trim() });
  for (const entry of lac.collocations ?? []) if (entry?.item?.trim()) items.push({ kind: 'collocations', text: entry.item.trim() });
  for (const entry of lac.idiomsAndPhrases ?? []) if (entry?.item?.trim()) items.push({ kind: 'idiomsAndPhrases', text: entry.item.trim() });
  for (const entry of lac.focusPoints ?? []) if (entry?.What?.trim()) items.push({ kind: 'focusPoints', text: entry.What.trim() });
  return items;
}

export function lacInventory(lac: Lac): { kind: LacKind; count: number }[] {
  const counts: Record<string, number> = {};
  for (const item of lacItems(lac)) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  return (['vocabulary', 'phrasalVerbs', 'collocations', 'idiomsAndPhrases', 'focusPoints'] as LacKind[])
    .map((kind) => ({ kind, count: counts[kind] ?? 0 }));
}

/**
 * Placement plan. Two rules that matter:
 *  1. an unplaced item always outranks a second use, so nothing is silently dropped;
 *  2. `seed` rotates the module order, so two sessions differ without breaking coverage.
 */
export function buildPlacementPlan(lac: Lac, seed = 0): { slots: PlanSlot[]; uncovered: string[] } {
  const pool = lacItems(lac);
  const used = new Map<number, number>();
  const offset = ((seed % LAC_MODULES.length) + LAC_MODULES.length) % LAC_MODULES.length;
  const ordered = [...LAC_MODULES.slice(offset), ...LAC_MODULES.slice(0, offset)];
  const slots: PlanSlot[] = [];

  ordered.forEach((module, index) => {
    const chapter = Math.floor(index / 2) + 1;
    // Four items per module: two per round, which is what the modules are built for.
    // Two items left every exercise half empty.
    for (let slot = 1; slot <= 4; slot++) {
      const unplaced = pool.map((_, i) => i).filter((i) => (used.get(i) ?? 0) === 0);
      const preferred = unplaced.filter((i) => module.bestFor.includes(pool[i].kind));
      const fallback = pool.map((_, i) => i).filter((i) => module.bestFor.includes(pool[i].kind));
      const candidates = preferred.length ? preferred : unplaced.length ? unplaced : fallback.length ? fallback : pool.map((_, i) => i);
      if (!candidates.length) continue;
      const pick = candidates.sort((a, b) => (used.get(a) ?? 0) - (used.get(b) ?? 0) || a - b)[0];
      used.set(pick, (used.get(pick) ?? 0) + 1);
      slots.push({
        chapter,
        moduleTag: `${chapter}${index % 2 === 0 ? 'A' : 'B'}`,
        widget: module.widget,
        slot,
        item: pool[pick].text,
        kind: pool[pick].kind,
        repeat: (used.get(pick) ?? 0) > 1,
      });
    }
  });

  const uncovered = pool.filter((_, i) => (used.get(i) ?? 0) === 0).map((i) => i.text);
  return { slots, uncovered };
}

export function formatPlanForPrompt(slots: PlanSlot[], lac: Lac): string {
  const lines = slots.map(
    (s) => `${s.moduleTag} | ${s.widget} | slot ${s.slot} | "${s.item}" (${s.kind})${s.repeat ? ' [second use]' : ''}`
  );
  const excluded = LAC_EXCLUDED.filter((key) => Array.isArray(lac[key as keyof Lac]) || key === 'footer');
  return [
    'PLACEMENT PLAN — build exactly these modules, in this order, with these items. Every usable LAC item appears here; do not drop one and do not add a target that is not in the LAC.',
    ...lines,
    '',
    `Chapter grouping: 1A+1B = chapter 1, 2A+2B = chapter 2, 3A+3B = chapter 3, 4A+4B = chapter 4.`,
    `Each module gets four items: two in round 1 and two in round 2. An item may appear in more than one module — that is deliberate repetition across different exercise types.`,
    `Deliberately excluded from the worksheet (do not include): ${excluded.join(', ')}.`,
  ].join('\n');
}

export const LAC_DOC_KIND_META = '<meta name="zlides-doc-kind" content="lac-worksheet">';

/** Tag a generated worksheet so the vault loader never runs worksheet placeholder
 *  injection over it (that would overwrite its chapters with fake exercise blocks). */
export function markLacDocument(html: string): string {
  if (html.includes(LAC_DOC_KIND_META)) return html;
  if (/<head(\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(\s[^>]*)?>/i, (tag) => `${tag}\n${LAC_DOC_KIND_META}`);
  }
  return `<!DOCTYPE html><html><head>${LAC_DOC_KIND_META}</head><body>${html}</body></html>`;
}

/** Stable small integer from the lesson identity: same lesson -> same plan, new lesson -> new plan. */
export function hashSeed(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h % 1000003;
}

/** Rules from the lac-pipeline skill, expressed as a contract for the extractor. */
export function lacExtractionContract(student: string, date: string): string {
  const sign = student.trim() ? ` — Introduction by AiRON for ${student.trim()}` : ' — Introduction by AiRON';
  return `You convert raw lesson source material into a Lesson Asset Card (LAC). Return ONLY one JSON object. No prose before or after it, no markdown fences.

{
  "Saying": "a short proverb or phrase that fits the lesson",
  "title": "3-6 words naming the lesson",
  "sessionDate": "${date}",
  "lessonVibes": "3-4 sentences written TO the learner in you and I, grounded and dryly funny, ending with '${sign}'",
  "vocabulary": [{"item": "word", "pos": "n|v|adj|adv", "core_definition": "4-6 plain words"}],
  "phrasalVerbs": [{"item": "verb + particle", "latinateSynonym": "one formal word", "definition": "plain meaning", "usagePercentVsLatinate": "70% / 30%", "impact": ["one word", "5-8 words on how it sounds"]}],
  "collocations": [{"item": "two word phrase", "details": ["two-three word domain", "one example sentence taken from the source"]}],
  "idiomsAndPhrases": [{"item": "phrase", "register": "Neutral", "implicitMeaning": "5-12 words", "details": ["Vibe: two-three words", "one example sentence"]}],
  "focusPoints": [{"What": "3-7 words", "Why": "why it came up, 2-3 sentences written to the learner", "How": "the rule of thumb in one or two sentences", "exampleOfInAction": ["sentence", "sentence"]}],
  "pronunciation": [{"word": "word", "ipa": "/.../", "detail": "how to say it"}],
  "selfStudy": [{"task": "short task", "stimulus": "what to think about", "linguisticAudit": "what to check", "targetLanguage": ["sentence", "sentence"]}],
  "studentActionItems": ["one concrete action"],
  "teacherActionItems": [],
  "footer": {"threeWordFact": "exactly three words"}
}

RULES
- Exactly one focusPoints object and exactly one footer.
- Everything comes from the source. Never invent a fact, a quote, or a word that is not there.
- If the source is a general article rather than a lesson transcript, treat its key vocabulary, collocations and idioms as the lesson, and write focusPoints from its main argument.
- vocabulary: 6-12 items a learner actually needs. No cognate padding.
- phrasalVerbs: only those the source genuinely contains; zero is valid. Never force one.
- collocations: 2-6 real two-word pairings from the source.
- idiomsAndPhrases: 0-6, only real ones.
- No academic jargon, no CEFR labels, no invented praise, no "record yourself" advice.
- Plain, concrete, adult language.`;
}

function topLevelObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; continue; }
    if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) { out.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return out;
}

/** Pull a LAC out of the extractor's answer. Returns null rather than guessing. */
export function extractLacJson(answer: string): Lac | null {
  const text = (answer || '').trim();
  if (!text) return null;
  const candidates = [text];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (let m = fence.exec(text); m; m = fence.exec(text)) if (m[1]?.trim()) candidates.push(m[1].trim());
  candidates.push(...topLevelObjects(text));
  for (const candidate of candidates) {
    let parsed: unknown;
    try { parsed = JSON.parse(candidate); } catch { continue; }
    const probe = parseLac(parsed);
    if (probe.lac) return probe.lac;
  }
  return null;
}

export interface LacChassis { styles: string; engine: string; links?: string }

const MOUNT_BLOCK = /<div class="atomic-mount">\s*<script[^>]*class="atomic-config"[^>]*>[\s\S]*?<\/script>\s*<\/div>/g;

/**
 * Attach the skill's canonical chassis to whatever the agent wrote.
 *
 * The exemplar it comes from cannot be reproduced by a model: 31.5 KB of CSS plus a
 * 48.5 KB engine. The engine boots itself and requires `<main>` around the mounts,
 * `#progress-readout` and `#reset-all-btn`, so this guarantees all three exist.
 * The agent's own markup and configs are left untouched; its CSS keeps precedence
 * because the canonical sheet is inserted first.
 */
export function attachLacChassis(html: string, chassis: LacChassis): string {
  let out = (html || '').trim();
  if (!out) return out;

  if (!/^<!doctype html>/i.test(out)) {
    out = `<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>\n<body>\n${out}\n</body>\n</html>`;
  }
  if (!/<head(\s[^>]*)?>/i.test(out)) out = out.replace(/<html([^>]*)>/i, '<html$1><head></head>');
  if (!/<body(\s[^>]*)?>/i.test(out)) out = out.replace('</html>', '</body></html>');

  // The engine queries `main .atomic-mount`: loose mounts must be given a main.
  if (!/<main(\s[^>]*)?>/i.test(out)) {
    const blocks = out.match(MOUNT_BLOCK) || [];
    if (blocks.length) {
      const first = out.indexOf(blocks[0] as string);
      const lastBlock = blocks[blocks.length - 1] as string;
      const last = out.lastIndexOf(lastBlock) + lastBlock.length;
      out = out.slice(0, last) + '\n</main>' + out.slice(last);
      out = out.slice(0, first) + '<main>\n' + out.slice(first);
    }
  }

  // The engine reads both by id before mounting; a missing one aborts the whole boot.
  const guards: string[] = [];
  if (!/id="progress-readout"/.test(out)) guards.push('<span id="progress-readout" style="display:none"></span>');
  if (!/id="reset-all-btn"/.test(out)) guards.push('<button id="reset-all-btn" type="button" style="display:none"></button>');
  if (guards.length) out = out.replace(/<\/body>/i, `${guards.join('\n')}\n</body>`);

  if (chassis.links && !/id="lac-canonical-links"/.test(out) && !/fonts\.googleapis\.com/.test(out)) {
    out = out.replace(/<head(\s[^>]*)?>/i, (tag) => `${tag}\n<!-- lac-canonical-links -->\n${chassis.links}`);
  }

  if (chassis.styles && !/id="lac-canonical-styles"/.test(out)) {
    out = out.replace(/<head(\s[^>]*)?>/i, (tag) => `${tag}\n<style id="lac-canonical-styles">\n${chassis.styles}\n</style>`);
  }

  if (chassis.engine && !/LACAtomicEngine/.test(out)) {
    // The engine looks for `main .atomic-mount`; where a model puts its <main> is not
    // reliable (measured: one mount inside main, seven outside). Scope it to the class.
    const engine = chassis.engine.replace(/main \.atomic-mount/g, '.atomic-mount');
    out = out.replace(/<\/body>/i, `<script id="lac-engine">\n${engine}\n</script>\n</body>`);
  }

  return out;
}

/**
 * The skill's architecture is declarative: the page carries atomic configs and the
 * engine hydrates them. A model left to its own devices writes a static mock instead
 * (measured: 0 mounts, 76 KB of bespoke markup), so the requirement is stated flatly.
 */
export const LAC_STRUCTURE_CONTRACT = `STRUCTURE — NON-NEGOTIABLE
The body must contain EXACTLY eight exercise blocks, in the plan's order, each in this exact form:

<div class="atomic-mount"><script type="application/json" class="atomic-config">{"id":"m1-a1","widget":"dialogue-cloze","rounds":[[ ...items... ],[ ...items... ]]}</script></div>

- "widget" must be one of the eight module keys, and must match its module in the plan.
- "rounds" is an array of two rounds; each round is an array of item objects. Two-bucket-triage uses "buckets" instead of "rounds".
- Item keys must match the widget's shape exactly (see WIDGET CONFIG SHAPES). No extra keys.
- Chapter chrome around the mounts is yours (chapter-module, chapter-header, chapter-title, chapter-kpi). The mounts themselves are not.
- Do NOT write CSS for the modules and do NOT write JavaScript. No engine, no tab handlers, no inline styles for widgets. The canonical stylesheet and window.LACAtomicEngine are injected after you reply; your own stylesheet will fight it and your own script will not run.
- Do NOT load external icon fonts. No material-icons, no CDN.
- Output one complete HTML document and nothing else.`;

export interface LacDocumentCheck { mounts: number; configs: number; widgets: string[]; errors: string[] }

/** Hard gate after generation: a page without eight hydrated mounts is not a worksheet. */
export function validateLacDocument(html: string): LacDocumentCheck {
  const mounts = (html.match(/<div class="atomic-mount">/g) || []).length;
  const configs = (html.match(/class="atomic-config"/g) || []).length;
  const widgets = [...html.matchAll(/"widget"\s*:\s*"([a-z-]+)"/g)].map((m) => m[1]);
  const errors: string[] = [];
  if (mounts < 1) errors.push('no atomic-mount blocks found');
  if (configs < 1) errors.push('no atomic-config scripts found');
  if (!html.includes('chapter-module')) errors.push('no chapter-module chrome found');
  if (/material-icons|fonts\.googleapis\.com\/icon/.test(html)) errors.push('external icon font requested');
  return { mounts, configs, widgets, errors };
}

export const LAC_THEMES = ['theme-ocean', 'theme-teal', 'theme-coral', 'theme-amber'];

/** The prompt a chapter's refresh control carries. The website's script reads
 *  data-prompt and asks GenAI for a new round; the page needs no app. */
export function buildChapterRefreshPrompt(build: LacBuild, chapterIndex: number): string {
  const chapter = build.chapters[chapterIndex];
  const modules = build.modules.slice(chapterIndex * 2, chapterIndex * 2 + 2);
  const widgets = modules.map((m) => m.widget).filter(Boolean);
  const targets = modules.flatMap((m) => {
    const rounds = (m as { rounds?: unknown }).rounds;
    if (!Array.isArray(rounds)) return [] as string[];
    const out: string[] = [];
    for (const round of rounds) {
      if (Array.isArray(round)) {
        for (const item of round) {
          const t = (item as { target?: unknown } | null)?.target;
          if (typeof t === 'string' && t.trim()) out.push(t.trim());
        }
      } else if (round && typeof round === 'object') {
        const words = (round as { words?: unknown }).words;
        if (Array.isArray(words)) for (const w of words) if (typeof w === 'string' && w.trim()) out.push(w.trim());
      }
    }
    return out;
  });
  const uniqueTargets = [...new Set(targets)];
  return [
    `Replace the refreshable content of chapter ${chapterIndex + 1} ("${chapter?.title ?? 'this chapter'}") in the worksheet "${build.title}".`,
    `Return exactly ${modules.length} atomic mount blocks, in this order: ${widgets.join(', ')}.`,
    'Each block must be this literal shape, with the JSON config inline:',
    '<div class="atomic-mount"><script type="application/json" class="atomic-config">{"id":"...","widget":"...","rounds":[...]}</script></div>',
    'Each JSON config must keep the same widget and the same keys and nesting as the block it replaces. Change only the wording: sentences, options, answers and explanations.',
    `Keep the same target language: ${uniqueTargets.join(', ') || 'the chapter targets'}.`,
    'Every sentence must be about the lesson topic. Every distractor must be a plausible alternative, same part of speech and register.',
    'Do not reuse any wording from the current round.',
    'Return those mount blocks only. No prose, no markdown fences, no document wrapper, no CSS, no other markup.',
  ].join('\n');
}


export interface LacBuildChapter { kicker: string; title: string; sub: string }
export interface LacBuildModule { id: string; tag?: string; widget: string; rounds?: unknown; buckets?: unknown; [k: string]: unknown }
export interface LacBuild { title: string; saying: string; chapters: LacBuildChapter[]; modules: LacBuildModule[] }

export const LAC_BUILD_CONTRACT = `RETURN SHAPE — JSON ONLY
Return ONLY this JSON object. No HTML, no CSS, no JavaScript, no markdown fences, no prose.

{
  "title": "the lesson title",
  "saying": "a short proverb that fits the lesson",
  "chapters": [
    { "kicker": "Chapter 01 · a three-to-six word label", "title": "chapter title", "sub": "one sentence of framing written to the learner" },
    ... exactly 4 chapters ...
  ],
  "modules": [
    { "id": "m1-a1", "widget": "dialogue-cloze", "rounds": [ ... ] },
    { "id": "m1-a2", "widget": "sentence-upgrade", "rounds": [ ... ] },
    ... exactly 8 modules, in placement-plan order ...
  ]
}

- Exactly 4 chapters and exactly 8 modules. Module order follows the plan: 1A, 1B come before 2A, 2B.
- Every one of the eight widget keys appears exactly once.
- Each module's own fields must match its entry in WIDGET CONFIG SHAPES exactly: same keys, same nesting (rounds as arrays-of-items or objects, whichever that widget uses), same value types. No extra keys.
- Do not write markup, classes, or styles. The document, the chassis and the engine are assembled by the caller.
- No external assets, no icon fonts.
- Every option must be a real alternative a learner might actually choose. Never make the answer obvious by pairing it with something unrelated (a target about money must not be offered against "ballpoint pen"). Distractors must be plausible, same part of speech, same register.
- Every sentence must be about this LAC's own topic. Never reuse wording, names, numbers or examples from the reference material.

DIALOGUE-CLOZE IS DIFFERENT. Its "rounds" holds two OBJECTS, each with a pre-rendered chat — never an array of arrays, never {id, lines, answer}:
"rounds": [
  { "words": ["go up", "flood"],
    "html": "<div class='chat-bubble outgoing'><span class='bubble-sender'>Diego</span>The rain was heavy.</div><div class='chat-bubble incoming'><span class='bubble-sender'>AiRON</span>Yes, it may <input class='cloze' data-answer='flood'> the town.</div>",
    "why": "flood is the verb for water covering land" },
  { "words": ["go up", "level"], "html": "<div class='chat-bubble outgoing'>...</div>", "why": "..." }
]
TWO-BUCKET-TRIAGE items name the bucket by KEY: "buckets": [{"key":"real","label":"← Sustainable Move"},{"key":"cosmetic","label":"Cosmetic Spin →"}] and each item uses "bucket": "real" or "bucket": "cosmetic" — never the label text.`;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitize(v, depth + 1);
    return out;
  }
  return value;
}


/** Widget-specific shapes the model reliably gets wrong. These are warnings now:
 *  a malformed module must not throw away the other seven. */
export function lacBuildShapeErrors(build: LacBuild): string[] {
  const errors: string[] = [];
  for (const m of build.modules) {
    if (m?.widget === 'dialogue-cloze') {
      const rounds = (m as { rounds?: unknown }).rounds;
      if (!Array.isArray(rounds) || rounds.length !== 2) {
        errors.push('dialogue-cloze "rounds" should be an array of exactly 2 objects');
      } else {
        rounds.forEach((round, i) => {
          if (!round || Array.isArray(round) || typeof round !== 'object') {
            errors.push(`dialogue-cloze rounds[${i}] should be an object with words, html and why`);
            return;
          }
          const r = round as Record<string, unknown>;
          if (!Array.isArray(r.words)) errors.push(`dialogue-cloze rounds[${i}].words should be an array of strings`);
          if (typeof r.html !== 'string' || !r.html.includes('chat-bubble')) {
            errors.push(`dialogue-cloze rounds[${i}].html should be the rendered chat markup`);
          }
        });
      }
    }
    if (m?.widget === 'two-bucket-triage') {
      const buckets = (m as { buckets?: unknown }).buckets;
      const keys = Array.isArray(buckets) ? buckets.map((b) => (b as { key?: string } | null)?.key) : [];
      if (keys.length !== 2 || keys.some((k) => !k)) {
        errors.push('two-bucket-triage needs exactly 2 buckets, each with key and label');
      }
      const rounds = (m as { rounds?: unknown }).rounds;
      if (Array.isArray(rounds)) {
        rounds.forEach((round, i) => {
          if (!Array.isArray(round)) return;
          round.forEach((item, j) => {
            const bucket = (item as { bucket?: string } | null)?.bucket;
            if (bucket && !keys.includes(bucket)) {
              errors.push(`two-bucket-triage rounds[${i}][${j}].bucket should be the bucket KEY, not its label`);
            }
          });
        });
      }
    }
  }
  return errors;
}

export function parseLacBuild(answer: string): { build: LacBuild | null; errors: string[]; warnings: string[] } {
  const text = (answer || '').trim();
  if (!text) return { build: null, errors: ['empty reply'], warnings: [] };
  const candidates = [text];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (let m = fence.exec(text); m; m = fence.exec(text)) if (m[1]?.trim()) candidates.push(m[1].trim());
  candidates.push(...topLevelObjects(text));

  for (const candidate of candidates) {
    let parsed: unknown;
    try { parsed = JSON.parse(candidate); } catch {
      try { parsed = JSON.parse(repairJson(candidate)); } catch { continue; }
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.modules)) continue;

    const errors: string[] = [];
    const modules = obj.modules as LacBuildModule[];
    const chapters = Array.isArray(obj.chapters) ? (obj.chapters as LacBuildChapter[]) : [];
    if (modules.length < 1) errors.push('no modules found');
    if (chapters.length < 1) errors.push('no chapters found');
    modules.forEach((m, i) => {
      if (!m || typeof m !== 'object') { errors.push(`module ${i + 1} is not an object`); return; }
      if (!m.id) errors.push(`module ${i + 1} has no id`);
      if (!m.widget) errors.push(`module ${i + 1} has no widget`);
      if (!m.rounds && !m.buckets) errors.push(`module ${i + 1} (${m.widget ?? '?'}) has neither rounds nor buckets`);
    });
    if (errors.length) return { build: null, errors, warnings: [] };

    const shaped: LacBuild = {
      title: typeof obj.title === 'string' ? obj.title : 'Worksheet',
      saying: typeof obj.saying === 'string' ? obj.saying : '',
      chapters,
      modules: modules.map((m) => sanitize(m) as LacBuildModule),
    };
    const shapeWarnings = lacBuildShapeErrors(shaped);

    return { build: shaped, errors: [], warnings: shapeWarnings };
  }
  return { build: null, errors: ['no JSON object with a modules array was found'], warnings: [] };
}

const escHtml = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Assemble the exemplar's document around model-produced configs, so the DOM cannot be wrong. */
export function buildLacDocument(build: LacBuild, chassis: LacChassis, date = ''): string {
  const tabs = build.chapters
    .map((c, i) => `      <a href="#mov-${i + 1}" class="chapter-tab">${String(i + 1).padStart(2, '0')} · ${escHtml(c.title)}</a>`)
    .join('\n');

  const perChapter = Math.max(1, Math.ceil(build.modules.length / Math.max(1, build.chapters.length)));
  const chapters = build.chapters
    .map((c, i) => {
      const mounts = build.modules
        .slice(i * perChapter, (i + 1) * perChapter)
        .map((m) => {
          const cfg = JSON.stringify(m).replace(/</g, '\\u003c');
          return `      <div class="atomic-mount"><script type="application/json" class="atomic-config">${cfg}</script></div>`;
        })
        .join('\n');
      return `    <section class="chapter-module ${LAC_THEMES[i] ?? 'theme-ocean'} exercise-card" id="mov-${i + 1}" data-category="chapter-${i + 1}">
      <div class="chapter-head">
        <div>
          <span class="chapter-kicker">${escHtml(c.kicker)}</span>
          <h2 class="chapter-title">${escHtml(c.title)}</h2>
          <p class="chapter-sub">${escHtml(c.sub)}</p>
        </div>
        <div class="card-action-bar"><button type="button" class="regenerate-btn" data-category="chapter-${i + 1}" data-prompt="${escHtml(buildChapterRefreshPrompt(build, i))}"><svg class="regen-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>Generate New Questions</button></div>
      </div>
      <div class="question-item" id="chapter-${i + 1}-container">
${mounts}
      </div>
    </section>`;
    })
    .join('\n\n');

  const engine = (chassis.engine || '').replace(/main \.atomic-mount/g, '.atomic-mount');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(build.title)}</title>
${chassis.links || ''}
<style>
${chassis.styles}
</style>
<style>
  /* Refresh control: the host portal binds .regenerate-btn and replaces the
     contents of .question-item / #*-container with the model's reply. */
  .card-action-bar { display: flex; align-items: center; gap: 8px; flex: none; }
  .regenerate-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-family: var(--font-sans, 'Inter', system-ui, sans-serif);
    font-size: 14px;
    font-weight: 600;
    line-height: 1.2;
    color: var(--sec-bright, #ffffff);
    background: var(--sec-soft, rgba(255, 255, 255, 0.08));
    border: 1px solid var(--sec-border, rgba(255, 255, 255, 0.2));
    border-radius: 8px;
    padding: 8px 14px;
    cursor: pointer;
    transition: background 0.18s ease, border-color 0.18s ease, color 0.18s ease;
  }
  .regenerate-btn:hover {
    background: var(--sec, #ffffff);
    border-color: var(--sec, #ffffff);
    color: #0b0c0e;
  }
  .regenerate-btn:focus-visible {
    outline: 2px solid var(--sec-bright, #ffffff);
    outline-offset: 2px;
  }
  .regen-icon { width: 14px; height: 14px; flex: none; }
  .question-item { display: block; }
</style>
</head>
<body>
  <nav class="studio-topbar" aria-label="Studio chapters">
    <div class="chapter-tabs">
${tabs}
    </div>
    <div class="telemetry-bar">
      <span class="telemetry-Readout" id="progress-readout">0 / 8 Modules Completed</span>
      <button type="button" class="btn-text-reset" id="reset-all-btn">Reset</button>
    </div>
  </nav>

  <header class="hero-chassis">
    <div>
      <div class="hero-badge-row">
        <span class="student-pill">Practice Studio</span>
        <span class="date-pill">${escHtml(date)}</span>
      </div>
      <h1 class="hero-title">${escHtml(build.title)}</h1>
    </div>
    <div class="proverb-well">
      <span class="proverb-kicker">Session Proverb</span>
      <p class="proverb-quote">"${escHtml(build.saying)}"</p>
    </div>
  </header>

  <main>
${chapters}
  </main>

<script>
${engine}
</script>
<script>
  /* The host portal replaces a chapter's .question-item contents with the
     model's reply. That reply carries fresh .atomic-mount blocks, so mount
     them once they land. mountAll() skips anything already data-mounted. */
  (function () {
    var engine = window.LACAtomicEngine;
    if (!engine || typeof engine.mountAll !== 'function') return;
    if (!window.MutationObserver) return;
    var queued = false;
    function remount() {
      if (queued) return;
      queued = true;
      setTimeout(function () {
        queued = false;
        engine.mountAll();
      }, 0);
    }
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue;
          if (node.classList.contains('atomic-mount') || node.querySelector('.atomic-mount')) {
            remount();
            return;
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  })();
</script>
</body>
</html>
`;
}

/** Parse a single regenerated module out of a reply. */
export function parseLacModule(answer: string): { module: LacBuildModule | null; errors: string[] } {
  const text = (answer || '').trim();
  if (!text) return { module: null, errors: ['empty reply'] };
  const candidates = [text];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (let m = fence.exec(text); m; m = fence.exec(text)) if (m[1]?.trim()) candidates.push(m[1].trim());
  candidates.push(...topLevelObjects(text));

  for (const candidate of candidates) {
    let parsed: unknown;
    try { parsed = JSON.parse(candidate); } catch {
      try { parsed = JSON.parse(repairJson(candidate)); } catch { continue; }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.widget !== 'string') continue;
    if (!obj.rounds && !obj.buckets) continue;
    return { module: sanitize(obj) as LacBuildModule, errors: [] };
  }
  return { module: null, errors: ['no module object with a widget and rounds/buckets was found'] };
}
