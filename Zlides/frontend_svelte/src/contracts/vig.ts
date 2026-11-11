/**
 * VIG (Video Immersion Guide) contract.
 *
 * Runtime assets this module is compiled against live in `frontend_svelte/vig/`
 * and are kept byte-identical to their source of truth in
 * `/home/hayron/By Student/.opencode/commands/vig-generator/`:
 *   vig/base_template.html    (templates/base_template.html)
 *   vig/fetch-transcript.py   (scripts/fetch-transcript.py)
 * Re-sync those copies when the skill changes; do not edit them here.
 *
 * The model contract is NOT stored here. It is fenced between
 * VIG-MODEL-CONTRACT markers in the skill's SKILL.md and fetched at runtime from
 * /api/vig/contract, so the skill is the only place the rules live.
 */

export interface VigCue {
  start: number;
  end: number;
  text: string;
}

export interface VigItem {
  term: string;
  timestamp: number;
  definition: string;
  contextSentence?: string;
  collocations?: string;
  cefrLevel?: string;
  type?: string;
  [k: string]: unknown;
}

export interface VigSegment {
  id: string;
  number: number;
  title: string;
  timestamp: number;
  endTimestamp: number;
  focus?: string;
  schemaActivation: string;
  items: VigItem[];
}

export interface VigCurriculum {
  segments: VigSegment[];
}

export interface VigTranscript {
  _source?: string;
  _video_id?: string;
  _fetched_at?: string;
  cues: VigCue[];
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
export const VIG_DOC_KIND_META = '<meta name="zlides-doc-kind" content="video-immersion-guide">';

export function parseYouTubeId(input: string): string | null {
  const raw = (input || '').trim();
  if (!raw) return null;
  if (YOUTUBE_ID.test(raw)) return raw;

  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return null;
  }

  const valid = (v: string | null | undefined): string | null =>
    v && YOUTUBE_ID.test(v) ? v : null;

  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be') return valid(parts[0]);

  const isYouTube =
    host === 'youtube.com' ||
    host.endsWith('.youtube.com') ||
    host === 'youtube-nocookie.com' ||
    host.endsWith('.youtube-nocookie.com');
  if (!isYouTube) return null;

  const fromQuery = valid(url.searchParams.get('v'));
  if (fromQuery) return fromQuery;

  if (parts[0] === 'embed' || parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'v') {
    return valid(parts[1]);
  }
  return null;
}

function asCurriculum(value: unknown): VigCurriculum | null {
  if (Array.isArray(value)) return value.length ? { segments: value as VigSegment[] } : null;
  if (value && typeof value === 'object') {
    const segments = (value as { segments?: unknown }).segments;
    if (Array.isArray(segments) && segments.length) return { segments: segments as VigSegment[] };
  }
  return null;
}

/** Every top-level `{...}` block in the text, string- and escape-aware. */
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
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

/**
 * Pull the curriculum out of the agent's answer. Handles a bare object, a
 * fenced block, and an object embedded in prose. Returns null rather than
 * repairing a partial or invalid payload.
 */
export function extractCurriculumJson(answerText: string): VigCurriculum | null {
  const text = (answerText || '').trim();
  if (!text) return null;

  const candidates: string[] = [text];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    if (m[1] && m[1].trim()) candidates.push(m[1].trim());
  }
  candidates.push(...topLevelObjects(text));

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const curriculum = asCurriculum(parsed);
    if (curriculum) return curriculum;
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Same hard gates the skill compiler enforces, plus the SKILL.md checklist as warnings. */
export function validateCurriculum(
  vocab: VigCurriculum,
  cues: VigCue[]
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(vocab) || !Array.isArray(vocab.segments) || vocab.segments.length === 0) {
    return { errors: ['root must be an object with a non-empty "segments" array'], warnings };
  }

  const items: VigItem[] = [];
  const ITEM_TYPES = ['vocabulary', 'phrasal_verb', 'collocation', 'idiom'];
  const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

  vocab.segments.forEach((segment, index) => {
    const label = `segment ${segment?.number ?? index + 1}`;
    if (!isRecord(segment)) {
      errors.push(`${label} is not an object`);
      return;
    }
    if (!isFiniteNumber(segment.number) || !Number.isInteger(segment.number) || segment.number < 1) {
      errors.push(`${label}: "number" must be an integer >= 1`);
    }
    if (typeof segment.id !== 'string' || !/^seg-[0-9]+$/.test(segment.id)) {
      errors.push(`${label}: "id" must match "seg-<number>"`);
    }
    if (typeof segment.title !== 'string' || !segment.title.trim()) {
      errors.push(`${label}: "title" must be a non-empty string`);
    }
    if (!isFiniteNumber(segment.timestamp) || segment.timestamp < 0) {
      errors.push(`${label}: "timestamp" must be a number of seconds >= 0`);
    }
    if (!isFiniteNumber(segment.endTimestamp) || segment.endTimestamp < 0) {
      errors.push(`${label}: "endTimestamp" must be a number of seconds >= 0`);
    }
    if (typeof segment.schemaActivation !== 'string') {
      errors.push(`${label}: "schemaActivation" must be a string`);
    } else {
      const bolded = segment.schemaActivation.match(/\*\*[^*]+\*\*/g) || [];
      if (bolded.length < 2) {
        warnings.push(`${label} ("${segment.title ?? ''}"): schemaActivation weaves only ${bolded.length} **target terms** (3+ required)`);
      }
    }
    if (!Array.isArray(segment.items) || segment.items.length === 0) {
      errors.push(`${label}: "items" must be a non-empty array`);
      return;
    }
    items.push(...segment.items);
  });

  if (errors.length > 0) return { errors, warnings };

  const sorted = [...items].sort((a, b) => (a?.timestamp ?? 0) - (b?.timestamp ?? 0));

  sorted.forEach((item) => {
    const term = typeof item?.term === 'string' && item.term.trim() ? item.term : '(unnamed item)';
    if (typeof item?.term !== 'string' || !item.term.trim()) {
      errors.push(`an item is missing "term"`);
    }
    if (!isFiniteNumber(item?.timestamp)) {
      errors.push(`"${term}": "timestamp" must be a number of seconds`);
      return;
    }
    if (item.timestamp < 15) {
      errors.push(`"${term}": timestamp ${item.timestamp}s is in the first 15 seconds (timestamp >= 15 required)`);
    }
    if (typeof item.definition !== 'string' || item.definition.trim().length < 20) {
      errors.push(`"${term}": "definition" must be a string of at least 20 characters`);
    }
    if (typeof item.contextSentence !== 'string' || item.contextSentence.trim().length < 10) {
      errors.push(`"${term}": "contextSentence" must be the in-video sentence (at least 10 characters)`);
    }
    if (typeof item.type !== 'string' || !ITEM_TYPES.includes(item.type)) {
      errors.push(`"${term}": "type" must be one of ${ITEM_TYPES.join(', ')}`);
    }
    if (item.cefrLevel !== undefined && (typeof item.cefrLevel !== 'string' || !CEFR_LEVELS.includes(item.cefrLevel))) {
      errors.push(`"${term}": "cefrLevel" must be one of ${CEFR_LEVELS.join(', ')}`);
    }
    if (item.collocations !== undefined && typeof item.collocations !== 'string') {
      errors.push(`"${term}": "collocations" must be a string`);
    }
    if (cues.length > 0 && isFiniteNumber(item.timestamp)) {
      const covered = cues.some((c) => item.timestamp >= c.start && item.timestamp <= c.end + 2);
      if (!covered) warnings.push(`"${term}": timestamp ${item.timestamp}s does not fall inside any transcript cue`);
    }
  });

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (!isFiniteNumber(prev?.timestamp) || !isFiniteNumber(curr?.timestamp)) continue;
    const gap = curr.timestamp - prev.timestamp;
    if (gap === 0) {
      errors.push(`"${prev.term}" and "${curr.term}" share timestamp ${curr.timestamp}s (one concept per timestamp)`);
    } else if (gap < 12) {
      warnings.push(`"${prev.term}" (${prev.timestamp}s) and "${curr.term}" (${curr.timestamp}s) are only ${gap.toFixed(1)}s apart`);
    }
  }

  const phrasal = items.filter((i) => i?.type === 'phrasal_verb').length;
  if (phrasal < 5) warnings.push(`only ${phrasal} phrasal_verb items (SKILL.md requires a minimum of 5)`);

  return { errors, warnings };
}

export function compileVigGuide(
  template: string,
  opts: { title: string; videoId: string; vocab: VigCurriculum; cues: VigCue[] }
): string {
  const title = String(opts.title ?? '').replace(/</g, '&lt;');
  const vocabJson = JSON.stringify(opts.vocab).replace(/</g, '\\u003c');
  const transcriptJson = JSON.stringify(opts.cues).replace(/</g, '\\u003c');

  const compiled = template
    .replaceAll('{{GUIDE_TITLE}}', title)
    .replaceAll('{{VIDEO_ID}}', opts.videoId)
    .replaceAll('{{VOCAB_JSON}}', vocabJson)
    .replaceAll('{{TRANSCRIPT_JSON}}', transcriptJson);

  if (compiled.includes(VIG_DOC_KIND_META)) return compiled;
  return compiled.replace(/<head(\s[^>]*)?>/i, (tag) => `${tag}\n${VIG_DOC_KIND_META}`);
}
