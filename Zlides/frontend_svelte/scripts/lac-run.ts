#!/usr/bin/env bun
/**
 * One-command LAC -> worksheet runner.
 *
 *   source ~/.secrets.env
 *   bun run lac --lac LAC.json --out out.html
 *   bun run lac --lac LAC.json --dry-run                  # plan + prompt, no API call
 *   bun run lac --lac LAC.json --from-answer reply.html    # re-assemble a saved reply
 *
 * The model returns four chapters and eight widget configs as JSON; this script
 * assembles the exemplar's document around them. If a reply is rejected, the
 * exact errors are sent back once for a repair round.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  parseLac,
  lacItems,
  buildPlacementPlan,
  formatPlanForPrompt,
  markLacDocument,
  attachLacChassis,
  validateLacDocument,
  parseLacBuild,
  buildLacDocument,
  hashSeed,
  LAC_BUILD_CONTRACT,
} from '../src/contracts/lac';
import { loadLacSkill } from '../src/contracts/lacSkill';
import { SseParser, PageStore, feedSseFrame, type SseEvent } from '../src/lib/sse/parser';
import { assembleSingleDocument } from '../src/lib/sse/placeholders';
import { rescueDocumentFromAnswer } from '../src/lib/sse/rescue';

const argv = process.argv.slice(2);
const opt = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const lacPath = opt('lac');
const dry = argv.includes('--dry-run');
const fromAnswer = opt('from-answer');

if (!lacPath) {
  console.error('usage: bun run lac --lac <LAC.json> [--out <file.html>] [--direction "..."] [--seed N] [--dry-run] [--from-answer reply]');
  process.exit(1);
}

const parsedLac = parseLac(JSON.parse(readFileSync(lacPath, 'utf8')));
if (!parsedLac.lac) {
  console.error('✗ not a usable LAC:', parsedLac.errors.join('; '));
  process.exit(1);
}
const lac = parsedLac.lac;

const seed = opt('seed') ? Number(opt('seed')) : hashSeed(`${lac.title ?? ''}|${lac.sessionDate ?? ''}`);
const plan = buildPlacementPlan(lac, seed);
const skill = loadLacSkill();
const outPath = opt('out', lacPath.replace(/\.json$/i, '') + '.html');

console.log(`LAC      : ${lac.title ?? '(untitled)'} · ${lac.sessionDate ?? 'no date'}`);
console.log(`items    : ${lacItems(lac).length}  placements: ${plan.slots.length}  seed: ${seed}`);
console.log(`uncovered: ${plan.uncovered.length ? plan.uncovered.join(', ') : 'none'}`);
console.log(`skill    : ${skill.contract.length} chars · sha ${skill.sha256.slice(0, 12)} · chassis ${skill.styles.length}+${skill.engine.length}`);

const direction = opt('direction')?.trim();
const prompt = [
  LAC_BUILD_CONTRACT,
  '',
  '===== REFERENCE — the studio your JSON is assembled into. Read it for module mechanics; do NOT write it. =====',
  skill.contract,
  '',
  '===== PLACEMENT PLAN — exactly these modules, in this order =====',
  formatPlanForPrompt(plan.slots, lac),
  direction ? `\n===== ONE-OFF DIRECTION FOR THIS SESSION =====\n${direction}` : '',
  '',
  `===== LAC (${basename(lacPath)}) =====`,
  JSON.stringify(lac, null, 2),
].filter(Boolean).join('\n');

if (dry) {
  const promptPath = outPath.replace(/\.html$/i, '') + '.prompt.txt';
  writeFileSync(promptPath, prompt);
  console.log(`dry run  : prompt written to ${promptPath} (${prompt.length} chars), no API call`);
  process.exit(0);
}

const key = process.env.Z_AI_API_KEY || process.env.ZAI_API_KEY;
if (!key && !fromAnswer) {
  console.error('✗ Z_AI_API_KEY is not set. Run: source ~/.secrets.env');
  process.exit(1);
}

async function callAgent(text: string): Promise<{ answer: string; store: PageStore }> {
  const parser = new SseParser();
  const store = new PageStore();
  let answer = '';
  const handle = (events: SseEvent[]) => {
    for (const ev of events) {
      if (ev.kind === 'answer') answer += ev.text;
      else if (ev.kind === 'page') store.applyEvent(ev);
      else if (ev.kind === 'thinking') process.stdout.write('.');
      else if (ev.kind === 'stream_error') console.error(`\n✗ stream error ${ev.code ?? ''}: ${ev.message}`);
    }
  };
  const res = await fetch('https://api.z.ai/api/v1/agents', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Accept-Language': 'en-US,en' },
    body: JSON.stringify({ agent_id: 'slides_glm_agent', stream: true, messages: [{ role: 'user', content: [{ type: 'text', text }] }] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('no stream body');
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { lines, rest } = feedSseFrame(buffer);
      buffer = rest;
      for (const line of lines) handle(parser.push(line));
    }
    buffer += decoder.decode();
    if (buffer.trim()) for (const line of feedSseFrame(`${buffer}\n`).lines) handle(parser.push(line));
  } finally {
    handle(parser.flush());
  }
  return { answer, store };
}

const replyPath = outPath.replace(/\.html$/i, '') + '.reply.txt';
let answer = fromAnswer ? readFileSync(fromAnswer, 'utf8') : '';
let store = new PageStore();
if (fromAnswer) console.log(`replay   : ${fromAnswer} (${answer.length} chars, no API call)`);

let build = parseLacBuild(answer);
let attempt = 0;
while (!fromAnswer && !build.build && attempt < 2) {
  if (attempt > 0) {
    const rejection = [
      prompt,
      '',
      '===== YOUR PREVIOUS REPLY WAS REJECTED =====',
      ...build.errors.map((e) => `- ${e}`),
      '',
      'Return ONLY the JSON object described by RETURN SHAPE — JSON ONLY. No HTML, no CSS, no Markdown, no prose.',
    ].join('\n');
    console.log(`\nrepair   : round ${attempt} — ${build.errors.join('; ')}`);
    const result = await callAgent(rejection);
    answer = result.answer;
    writeFileSync(replyPath.replace(/\.txt$/, `-round${attempt + 1}.txt`), answer);
    store = result.store;
    build = parseLacBuild(answer);
  } else {
    console.log('\nstreaming:');
    const result = await callAgent(prompt);
    answer = result.answer;
    writeFileSync(replyPath.replace(/\.txt$/, '-round1.txt'), answer);
    store = result.store;
    build = parseLacBuild(answer);
  }
  attempt++;
}

let final: string;
if (build.build) {
  final = markLacDocument(buildLacDocument(build.build, { styles: skill.styles, engine: skill.engine, links: skill.links }, lac.sessionDate ?? ''));
  console.log('\nroute    : JSON configs -> app-assembled document');
} else {
  console.log(`\nroute    : model HTML (no usable build JSON: ${build.errors.join('; ')})`);
  let html = '';
  if (store.pages.length) html = assembleSingleDocument(store.pages.map((p) => p.html));
  else if (store.unpositioned.length) html = assembleSingleDocument(store.unpositioned.map((u) => u.html));
  if (!html.trim() && answer.trim()) html = rescueDocumentFromAnswer(answer) ?? '';
  if (!html.trim()) {
    console.error('\n✗ the agent returned neither build JSON nor HTML. Raw reply:\n' + answer.slice(0, 2000));
    process.exit(1);
  }
  final = markLacDocument(attachLacChassis(html, { styles: skill.styles, engine: skill.engine, links: skill.links }));
}

const check = validateLacDocument(final);
if (check.errors.length) {
  writeFileSync(outPath.replace(/\.html$/i, '') + '.rejected.html', final);
  console.error(`\n✗ worksheet rejected: ${check.errors.join('; ')}`);
  console.error(`  mounts ${check.mounts}, configs ${check.configs}, widgets [${check.widgets.join(', ')}]`);
  console.error(`  raw output kept at ${outPath.replace(/\.html$/i, '')}.rejected.html`);
  process.exit(1);
}
writeFileSync(outPath, final);
console.log(`\n✓ ${outPath} (${final.length} bytes) · mounts ${check.mounts} · widgets [${check.widgets.join(', ')}]`);
