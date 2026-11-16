import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface LacSkill {
  contract: string;
  styles: string;
  links: string;
  engine: string;
  source: string;
  sha256: string;
}

export const LAC_SKILL_DIR_DEFAULT =
  '/home/hayron/By Student/.opencode/skills/lac-to-worksheet-cohesive-v5.0/lac-to-worksheet-cohesive';

const FILES = [
  'SKILL.md',
  'references/theme-first-spec.md',
  'references/exercise-type-library.md',
  'references/palette-a-tokens.md',
];

/** Read the whole LAC skill: the rules the model sees, plus the chassis the app owns. */

/** Shape without content: keys and types only, so the model cannot copy example wording. */
function skeleton(value: unknown): unknown {
  if (Array.isArray(value)) return value.length ? [skeleton(value[0])] : [];
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) out[key] = skeleton((value as Record<string, unknown>)[key]);
    return out;
  }
  if (typeof value === 'string') return '<text>';
  if (typeof value === 'number') return 0;
  if (typeof value === 'boolean') return value;
  return null;
}

export function loadLacSkill(skillDir = process.env.LAC_SKILL_DIR || LAC_SKILL_DIR_DEFAULT): LacSkill {
  const chunks: string[] = [];
  for (const rel of FILES) {
    chunks.push(`\n\n===== ${rel} =====\n` + fs.readFileSync(path.resolve(skillDir, rel), 'utf8').trim());
  }

  const examplesDir = path.resolve(skillDir, 'examples');
  const exemplar = fs.existsSync(examplesDir) ? fs.readdirSync(examplesDir).find((f) => f.endsWith('.html')) : undefined;

  let styles = '';
  let links = '';
  let engine = '';
  let shapes = '';
  if (exemplar) {
    const raw = fs.readFileSync(path.join(examplesDir, exemplar), 'utf8');
    const styleMatch = raw.match(/<style[^>]*>([\s\S]*?)<\/style>/);
    styles = styleMatch ? styleMatch[1] : '';
    // Font faces come from <link> tags, not the stylesheet: carry them or the type falls back.
    const head = raw.match(/<head[^>]*>([\s\S]*?)<\/head>/);
    links = head ? (head[1].match(/<link[^>]*>/g) || []).filter((l) => !/rel=["']icon/i.test(l)).join('\n') : '';
    const scripts = [...raw.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    engine = scripts.find((x) => x.includes('LACAtomicEngine')) || '';
    const configs = [...raw.matchAll(/<div class="atomic-mount">\s*<script[^>]*class="atomic-config"[^>]*>([\s\S]*?)<\/script>/g)];
    const lines: string[] = [
      '===== WIDGET CONFIG SHAPES (keys and types only; match the shape exactly) =====',
      'The values below are placeholders. Every word you write must come from the LAC. Never reuse wording from these shapes or from any example in the reference.',
    ];
    for (const c of configs) {
      try {
        const cfg = JSON.parse(c[1]);
        const parts: string[] = [`${cfg.widget}:`];
        parts.push(`  top-level keys ${JSON.stringify(Object.keys(cfg))}`);
        for (const key of ['rounds', 'buckets']) {
          const value = cfg[key];
          if (!Array.isArray(value) || value.length === 0) continue;
          const first = value[0];
          if (Array.isArray(first)) {
            const item = first[0];
            parts.push(`  ${key}: an array of ${value.length} rounds, each round an ARRAY of items; item keys ${JSON.stringify(item && typeof item === 'object' ? Object.keys(item) : [])}`);
            parts.push(`    shape only: ${JSON.stringify(skeleton(item))}`);
          } else if (first && typeof first === 'object') {
            parts.push(`  ${key}: an array of ${value.length} OBJECTS; keys ${JSON.stringify(Object.keys(first))}`);
            parts.push(`    shape only: ${JSON.stringify(skeleton(first))}`);
          }
        }
        lines.push(parts.join('\n'));
      } catch { /* skip an unparseable config */ }
    }
    shapes = lines.join('\n');
  }

  const contract = chunks.join('').trim() + (shapes ? '\n\n' + shapes : '');
  return {
    contract,
    styles,
    links,
    engine,
    source: skillDir,
    sha256: createHash('sha256').update(contract).digest('hex'),
  };
}
