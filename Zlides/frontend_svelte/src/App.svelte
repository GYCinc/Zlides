<script lang="ts">
  import { onMount } from 'svelte';
  import { fade, scale } from 'svelte/transition';
  // All imports relative: tsconfig.app.json has no $lib/$contracts paths mapping (pre-existing debt).
  import { Reasoning, ReasoningTrigger, ReasoningContent } from './lib/components/ai-elements/reasoning/index.js';
  import Response from './lib/components/ai-elements/response/response.svelte';
  import { assemblePrompt } from './contracts/promptBuilder';
  import { fetchSavedSlides, fetchSavedSlideHtml, saveSlideToStorage, downloadHtmlFile, cleanExportFilename, type SavedSlide } from './contracts/storage';
  // Typed SSE pipeline.
  import { SseParser, PageStore, feedSseFrame, type PageEntry, type SseEvent } from './lib/sse/parser';
  import { ensurePlaceholders, assembleSingleDocument, normalizeSavedHtml, splitSavedPages } from './lib/sse/placeholders.js';
  import { rescueDocumentFromAnswer, decodeHtmlPayload } from './lib/sse/rescue';
  import LogoHeroHeader from './lib/components/brand/LogoHeroHeader.svelte';
  import LogoHeroSplash from './lib/components/brand/LogoHeroSplash.svelte';
  import MorphDropdown from './lib/components/ui/MorphDropdown.svelte';
  import docTypeJson from '../../type/document.json';
  import slidesTypeJson from '../../type/slides.json';
  import webpageTypeJson from '../../type/webpage.json';
  import worksheetFormatJson from '../../format/regenerating-worksheet.json';
  import gitEnglishJson from '../../style/gitenglish.json';
  import designMdRaw from '../../style/DESIGN.md?raw';
  import preferencesRaw from '../../PREFERENCES.md?raw';
  import {
    VIG_DOC_KIND_META,
    parseYouTubeId,
    extractCurriculumJson,
    validateCurriculum,
    repairCurriculum,
    compileVigGuide,
    type VigCue,
  } from './contracts/vig';
  import {
    LAC_DOC_KIND_META,
    parseLac,
    lacItems,
    lacInventory,
    buildPlacementPlan,
    formatPlanForPrompt,
    markLacDocument,
    hashSeed,
    attachLacChassis,
    validateLacDocument,
    parseLacBuild,
    parseLacModule,
    buildLacDocument,
    LAC_BUILD_CONTRACT,
    type LacChassis,
    type Lac,
    type LacBuild,
    type PlanSlot,
  } from './contracts/lac';
  import vigTemplate from '../vig/base_template.html?raw';

  let cost = $state(0.00);
  let lastTokens = $state<number | null>(null);
  let isUploading = $state(false);
  let isEditingHtml = $state(false);
  let editorHtml = $state('');
  let status = $state("Ready");

  let apiKey = $state(
    (typeof localStorage !== 'undefined' && localStorage.getItem('zlides_api_key')) ||
    (import.meta.env.VITE_DEFAULT_API_KEY as string) ||
    ''
  );
  let isApiKeyModalOpen = $state(false);
  let tempApiKey = $state('');

  // ── Deck state (R2): ordered PageEntry[], one real page per delivered position ──
  let pages = $state<PageEntry[]>([]);
  let selectedPageIndex = $state(0);
  // R3: while streaming, the stage shows the latest parser-assembled page; after
  // the stream closes, it shows ONLY the selected page (one source of truth).
  let livePageHtml = $state<string | null>(null);
  let livePagePosition = $state<number | null>(null);
  let previewIframeEl = $state<HTMLIFrameElement | null>(null);
  let savedLiveScroll: { x: number; y: number; atBottom: boolean } | null = null;
  let lastLiveHeadHtml = '';

  function splitLiveHtml(html: string): { head: string; bodyInner: string } | null {
    const lower = html.toLowerCase();
    const start = lower.indexOf('<body');
    if (start === -1) return null;
    const closeTag = html.indexOf('>', start);
    if (closeTag === -1) return null;
    const head = html.slice(0, closeTag + 1);
    let bodyInner = html.slice(closeTag + 1);
    const endBody = bodyInner.toLowerCase().lastIndexOf('</' + 'body>');
    if (endBody !== -1) bodyInner = bodyInner.slice(0, endBody);
    return { head, bodyInner };
  }

  function tryPatchLiveIframeBody(html: string, position: number | null): boolean {
    if (livePageHtml === null || position !== livePagePosition) return false;
    const parts = splitLiveHtml(html);
    if (!parts || parts.head !== lastLiveHeadHtml) return false;
    try {
      const win = previewIframeEl?.contentWindow;
      const doc = previewIframeEl?.contentDocument;
      if (!win || !doc || !doc.body) return false;
      const root = doc.documentElement;
      const prevY = win.scrollY;
      const prevX = win.scrollX;
      const atBottom = prevY > 0 && root && prevY + win.innerHeight >= root.scrollHeight - 80;
      doc.body.innerHTML = parts.bodyInner;
      if (atBottom && root) {
        win.scrollTo(prevX, root.scrollHeight);
      } else if (prevY > 0) {
        win.scrollTo(prevX, prevY);
      }
      return true;
    } catch {
      return false;
    }
  }

  function captureLiveScroll(nextPosition: number | null) {
    if (nextPosition !== livePagePosition) {
      savedLiveScroll = null;
      return;
    }
    try {
      const win = previewIframeEl?.contentWindow;
      const doc = win?.document?.documentElement;
      if (!win || !doc) return;
      const y = win.scrollY;
      if (y <= 0) {
        savedLiveScroll = null;
        return;
      }
      const atBottom = y + win.innerHeight >= doc.scrollHeight - 80;
      savedLiveScroll = { x: win.scrollX, y, atBottom };
    } catch {
      savedLiveScroll = null;
    }
  }

  function handleIframeLoad() {
    if (!isGenerating || !savedLiveScroll) return;
    const snap = savedLiveScroll;
    savedLiveScroll = null;
    try {
      const win = previewIframeEl?.contentWindow;
      const doc = win?.document?.documentElement;
      if (!win || !doc) return;
      win.scrollTo(snap.x, snap.atBottom ? doc.scrollHeight : snap.y);
    } catch {
      // Ignore if iframe is not same-origin accessible
    }
  }

  // R4: every failure class lands here — rendered unmissable, non-blocking.
  let streamErrors = $state<{ code: string | null; message: string }[]>([]);
  // R4: visible-but-quiet counter for malformed/unknown wire frames (never silent).
  let wireNotices = $state(0);

  let isGenerating = $state(false);

  // ── VIG engine state: link in, compiled guide out ──
  let appMode = $state<'sheet' | 'lac' | 'vig' | 'open'>('sheet');
  let vigLinkInput = $state('');
  let vigTitleInput = $state('');
  let vigHtml = $state<string | null>(null);
  interface VigContract { text: string; chars: number; sha256: string; source: string }
  let vigContract = $state<VigContract | null>(null);
  let vigContractError = $state<string | null>(null);

  // ── LAC Studio state: a Lesson Asset Card in, a planned worksheet out ──
  interface LacContract { text: string; chars: number; sha256: string }
  let lac = $state<Lac | null>(null);
  let lacFileName = $state('');
  let lacError = $state<string | null>(null);
  let lacPlan = $state<PlanSlot[]>([]);
  let lacDirection = $state('');
  let lacHtml = $state<string | null>(null);
  let lacContract = $state<LacContract | null>(null);
  let lacContractError = $state<string | null>(null);
  let lacSeed = $state(0);
  let lacChassis = $state<LacChassis | null>(null);
  let lacBuild = $state<LacBuild | null>(null);
  let regenerating = $state<number | null>(null);

  // ── Skills Library & Attached Skill Editor ──
  const SKILLS_STORAGE_KEY = 'zlides_saved_skills_v1';
  const LAC_OVERRIDE_KEY = 'zlides_lac_skill_override_v1';
  const VIG_OVERRIDE_KEY = 'zlides_vig_skill_override_v1';
  interface SavedSkill {
    id: string;
    name: string;
    content: string;
    active: boolean;
    updatedAt: number;
  }
  let savedSkills = $state<SavedSkill[]>(
    (() => {
      if (typeof localStorage === 'undefined') return [];
      try {
        const raw = localStorage.getItem(SKILLS_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })()
  );
  let isSkillsModalOpen = $state(false);
  let skillsModalTab = $state<'library' | 'lac' | 'vig'>('library');
  let selectedSkillId = $state<string | null>(savedSkills[0]?.id ?? null);
  let skillDraftName = $state(savedSkills[0]?.name ?? '');
  let skillDraftContent = $state(savedSkills[0]?.content ?? '');
  let lacSkillDraft = $state('');
  let vigSkillDraft = $state('');
  let hasLacOverride = $state(typeof localStorage !== 'undefined' && Boolean(localStorage.getItem(LAC_OVERRIDE_KEY)));
  let hasVigOverride = $state(typeof localStorage !== 'undefined' && Boolean(localStorage.getItem(VIG_OVERRIDE_KEY)));

  const activeSkills = $derived(savedSkills.filter((s) => s.active && s.content.trim().length > 0));

  function persistSavedSkills() {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SKILLS_STORAGE_KEY, JSON.stringify(savedSkills));
  }

  function activeSkillBlock(): string {
    if (activeSkills.length === 0) return '';
    return activeSkills
      .map((s) => `=== ACTIVE SKILL (${s.name.trim() || 'Untitled Skill'}) ===\n${s.content.trim()}`)
      .join('\n\n');
  }

  function selectSkillForEdit(id: string) {
    const found = savedSkills.find((s) => s.id === id);
    if (!found) return;
    selectedSkillId = found.id;
    skillDraftName = found.name;
    skillDraftContent = found.content;
  }

  function createNewSkill(initialName = 'New Skill', initialContent = '') {
    const id = `skill_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const entry: SavedSkill = { id, name: initialName, content: initialContent, active: true, updatedAt: Date.now() };
    savedSkills = [entry, ...savedSkills];
    persistSavedSkills();
    selectSkillForEdit(id);
    skillsModalTab = 'library';
  }

  function saveCurrentSkillDraft() {
    const name = skillDraftName.trim() || 'Untitled Skill';
    if (!selectedSkillId) {
      createNewSkill(name, skillDraftContent);
      return;
    }
    savedSkills = savedSkills.map((s) =>
      s.id === selectedSkillId ? { ...s, name, content: skillDraftContent, updatedAt: Date.now() } : s
    );
    persistSavedSkills();
    status = `Saved skill "${name}"`;
  }

  function toggleSkillActive(id: string) {
    savedSkills = savedSkills.map((s) => (s.id === id ? { ...s, active: !s.active, updatedAt: Date.now() } : s));
    persistSavedSkills();
  }

  function deleteSkillEntry(id: string) {
    savedSkills = savedSkills.filter((s) => s.id !== id);
    persistSavedSkills();
    if (selectedSkillId === id) {
      if (savedSkills[0]) selectSkillForEdit(savedSkills[0].id);
      else {
        selectedSkillId = null;
        skillDraftName = '';
        skillDraftContent = '';
      }
    }
  }

  async function handleSkillFileImport(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'Imported Skill';
    createNewSkill(baseName, text);
    input.value = '';
  }

  async function openSkillsModal(tab: 'library' | 'lac' | 'vig' = 'library') {
    skillsModalTab = tab;
    isSkillsModalOpen = true;
    if (!lacContract) await loadLacContract();
    if (!vigContract) await loadVigContract();
    lacSkillDraft = lacContract?.text ?? '';
    vigSkillDraft = vigContract?.text ?? '';
    if (selectedSkillId) selectSkillForEdit(selectedSkillId);
    else if (savedSkills[0]) selectSkillForEdit(savedSkills[0].id);
  }

  function applyLacSkillOverride() {
    const text = lacSkillDraft.trim();
    if (!text) return;
    if (typeof localStorage !== 'undefined') localStorage.setItem(LAC_OVERRIDE_KEY, text);
    hasLacOverride = true;
    lacContract = { text, chars: text.length, sha256: 'edited-in-app' };
    status = 'Applied in-app edit to attached LAC skill';
  }

  async function resetLacSkillOverride() {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(LAC_OVERRIDE_KEY);
    hasLacOverride = false;
    await loadLacContract();
    lacSkillDraft = lacContract?.text ?? '';
    status = 'Reset LAC skill to disk default';
  }

  function applyVigSkillOverride() {
    const text = vigSkillDraft.trim();
    if (!text) return;
    if (typeof localStorage !== 'undefined') localStorage.setItem(VIG_OVERRIDE_KEY, text);
    hasVigOverride = true;
    vigContract = { text, chars: text.length, sha256: 'edited-in-app', source: 'in-app override' };
    status = 'Applied in-app edit to attached VIG skill';
  }

  async function resetVigSkillOverride() {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(VIG_OVERRIDE_KEY);
    hasVigOverride = false;
    await loadVigContract();
    vigSkillDraft = vigContract?.text ?? '';
    status = 'Reset VIG skill to disk default';
  }

  // ── W3: conversation continuity. LIVE-VERIFIED (2026-08-31, api.z.ai): the stream
  // endpoint silently adopts unknown conversation_ids (echoes them, generates a fresh
  // deck under that id) — there is no "expired" wire error. Real continuation failures
  // are HTTP errors, stream_error events, or an empty result; each offers restart. ──
  const CONVERSATION_KEY = 'zlides_conversation_id';
  let conversationId = $state<string | null>(
    (typeof localStorage !== 'undefined' && localStorage.getItem(CONVERSATION_KEY)) || null
  );
  let lastStreamInterrupted = $state(false);
  let offerRestartWithContext = $state(false);
  let isExporting = $state(false);
  let isControlsCollapsed = $state(true);
  let isDeckControlsOpen = $state(false);
  let isWorksheetTypeOpen = $state(false);
  let isWorksheetSectionExpanded = $state(false);

  const WORKSHEET_SECTION_TYPES = [
    { id: 'vocabulary', label: 'Vocabulary' },
    { id: 'phrasal-verbs', label: 'Phrasal Verbs' },
    { id: 'grammar', label: 'Grammar' },
    { id: 'reading-comprehension', label: 'Reading Comprehension' },
    { id: 'listening', label: 'Listening' },
    { id: 'writing', label: 'Writing' },
    { id: 'pronunciation', label: 'Pronunciation' },
    { id: 'idioms', label: 'Idioms & Collocations' },
  ];

  const EMPTY_DOC_HTML = `<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;background:#131313;color:#9ca3af;font-family:sans-serif;margin:0;"><p style="font-size:16px;font-weight:500;">Ready to generate worksheet</p></body></html>`;

  const WAITING_DOC_HTML = `<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;background:#131313;color:#e5e7eb;font-family:sans-serif;margin:0;"><p style="font-size:16px;font-weight:500;">Agent is planning. The page appears here as soon as it starts writing HTML.</p></body></html>`;

  const LAC_SKELETON_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    html,body{margin:0;background:#0f1112;color:#9ca3af;font-family:Inter,system-ui,sans-serif}
    .wrap{max-width:980px;margin:0 auto;padding:28px}
    .bar{height:14px;border-radius:6px;background:#1b1e21;margin-bottom:14px;animation:p 1.4s ease-in-out infinite}
    .card{border:1px solid #2e3236;border-radius:16px;padding:20px;margin-bottom:22px;background:#141618}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    .tile{height:120px;border-radius:12px;background:#1b1e21;animation:p 1.4s ease-in-out infinite}
    @keyframes p{0%,100%{opacity:.45}50%{opacity:.9}}
  </style></head><body><div class="wrap">
    <div class="bar" style="width:38%"></div><div class="bar" style="width:62%"></div>
    <div class="card"><div class="bar" style="width:30%"></div><div class="row"><div class="tile"></div><div class="tile"></div></div></div>
    <div class="card"><div class="bar" style="width:26%"></div><div class="row"><div class="tile"></div><div class="tile"></div></div></div>
    <div class="card"><div class="bar" style="width:34%"></div><div class="row"><div class="tile"></div><div class="tile"></div></div></div>
    <div class="card"><div class="bar" style="width:22%"></div><div class="row"><div class="tile"></div><div class="tile"></div></div></div>
  </div></body></html>`;

  const LAC_EMPTY_HTML = `<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;background:#131313;color:#e5e7eb;font-family:sans-serif;margin:0;padding:32px;text-align:center;"><p style="font-size:18px;font-weight:600;">Attach a LAC JSON to build its worksheet</p></body></html>`;

  const VIG_EMPTY_HTML = `<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;background:#131313;color:#e5e7eb;font-family:sans-serif;margin:0;padding:32px;text-align:center;"><p style="font-size:18px;font-weight:600;">Paste a YouTube link to build a Video Immersion Guide</p></body></html>`;

  const selectedPage = $derived(pages[selectedPageIndex] ?? null);
  const iframeSrcDoc = $derived(
    appMode === 'vig'
      ? (vigHtml ?? VIG_EMPTY_HTML)
      : appMode === 'lac'
        ? (lacHtml ?? (isGenerating ? LAC_SKELETON_HTML : LAC_EMPTY_HTML))
        : ((isGenerating && livePageHtml !== null) ? livePageHtml : (isGenerating && pages.length === 0 ? WAITING_DOC_HTML : (selectedPage?.html ?? EMPTY_DOC_HTML)))
  );
  // Positions are 1-based and sorted: gaps in delivery are reported, never re-indexed.
  const pageGapCount = $derived.by(() => {
    if (pages.length === 0) return 0;
    const maxPos = pages[pages.length - 1]?.position ?? 0;
    return Math.max(0, maxPos - pages.length);
  });

  // W3: continuation is offered when a live conversation exists and the deck is
  // provably incomplete — declared positions never delivered, or the stream was
  // killed mid-deck (spec §8: resume path). No content sniffing; structured signals only.
  const canContinue = $derived(
    !isGenerating && conversationId !== null && pages.length > 0 && (pageGapCount > 0 || lastStreamInterrupted)
  );

  function persistConversation(id: string) {
    conversationId = id;
    localStorage.setItem(CONVERSATION_KEY, id);
    localStorage.setItem('zlides_conversation_ts', String(Date.now()));
  }

  function clearConversation() {
    conversationId = null;
    lastStreamInterrupted = false;
    offerRestartWithContext = false;
    localStorage.removeItem(CONVERSATION_KEY);
    localStorage.removeItem('zlides_conversation_ts');
  }

  let promptText = $state("");
  let extractedMarkdown = $state("");
  let attachedFileName = $state("");

  let savedSlides = $state<SavedSlide[]>([]);
  let isSavedModalOpen = $state(false);
  let isLoadingSaved = $state(false);
  let savedSearchQuery = $state("");

  // ── Session contracts: three user-filled spaces. Send is blocked until all are signed. ──
  /** Explicit multi-page vault contract (Wave 2): pages joined at save time, split on load.
   * Older single-blob entries contain no marker and load as exactly one page. */
  // ── Session contracts: three user-filled spaces. Send is blocked until all are signed. ──
  /** Explicit multi-page vault contract (Wave 2): pages joined at save time, split on load.
   * Older single-blob entries contain no marker and load as exactly one page. */
  const PAGE_SEPARATOR = '\n<!-- zlides:page-break -->\n';
  const DEFAULT_TYPE_PROMPT = docTypeJson.prompt;
  const SLIDES_TYPE_PROMPT = slidesTypeJson.prompt;
  const WEBPAGE_TYPE_PROMPT = webpageTypeJson.prompt;

  const DEFAULT_FORMAT_PROMPT = worksheetFormatJson.prompt;
  /** Always-on global rules. Loaded on EVERY call, never a user-selectable slot. */
  const PREFERENCES_TEXT = preferencesRaw.trim();
  const PREFERENCES_BLOCK = `=== GLOBAL PREFERENCES (ALWAYS APPLY — NOT CONTENT) ===\n${PREFERENCES_TEXT}`;
  /** The owner's design system, verbatim (machine-readable twin of DESIGN.md). */
  const GITENGLISH_STYLE_TEXT = JSON.stringify(gitEnglishJson, null, 2);
  /** Stitch-spec design system — tokens in YAML front matter + section rationale. */
  const DESIGN_MD_TEXT = designMdRaw.trim();

  const DEFAULT_STYLE_TOKENS = `DESIGN SYSTEM — GITENGLISH PALETTE A (Exact Color Tokens & Hierarchy)

LOAD THESE FONTS (include exact <link> in <head>):
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,560;9..144,700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Raleway:wght@400;600;700;800&display=swap" rel="stylesheet">

EMBEDDED CSS ARCHITECTURE (place directly inside embedded style block):
:root {
  /* Canvas Surfaces */
  --bg: #0f1112;
  --surface: #16181a;
  --surface-elevated: #1e2124;
  --line: #2e3236;
  --line-strong: #373b40;
  --line-soft: rgba(63, 63, 70, 0.50);

  /* High-Contrast Typography */
  --text-heading: #ffffff;
  --text: #e5e7eb;
  --text-body: #cfd3d8;
  --muted: #9ca3af;
  --faint: #6b7280;

  /* Brand Accents */
  --brand: #ff6b35;
  --brand-deep: #7e1500;
  --brand-soft: rgba(255, 107, 53, 0.12);
  --brand-glow: rgba(255, 107, 53, 0.25);

  /* Immutable Semantic Statuses */
  --amber: #f0b23e;
  --teal: #4fb3a9;
  --ok: #10b981;
  --err: #f43f5e;

  /* Section Domain Hues */
  --c-vocab: #447F9F;
  --c-phrasal: #3B8484;
  --c-colloc: #DE6E55;
  --c-grammar: #B06D29;
  --c-idioms: #62193D;
  --c-focus: #DCE62C;
  --c-practice: #B98CF0;
  --c-selfstudy: #6FC3DF;

  /* Active Accent Pointer (default = brand orange) */
  --accent: var(--brand);
  --accent-deep: var(--brand-deep);
  --accent-soft: var(--brand-soft);

  /* Font Families */
  --font-display: 'Fraunces', Georgia, serif;
  --font-head: 'Raleway', sans-serif;
  --font-body: 'Inter', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;

  /* Radii */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
}

/* SECTION ACCENT SCOPING (each section overrides --accent) */
#vocabulary          { --accent: var(--c-vocab); }
#phrasal-verbs       { --accent: var(--c-phrasal); }
#collocations        { --accent: var(--c-colloc); }
#grammar             { --accent: var(--c-grammar); }
#idioms-and-phrases  { --accent: var(--c-idioms); }
#focus-points        { --accent: var(--c-focus); }
#in-class-practice   { --accent: var(--c-practice); }
#self-study          { --accent: var(--c-selfstudy); }

/* BASE & TYPOGRAPHY RULES */
body { background: var(--bg); color: var(--text); font-family: var(--font-body); font-size: 15.5px; line-height: 1.6; margin: 0; padding: 24px; box-sizing: border-box; }
h1 { font-family: var(--font-display); font-weight: 560; font-size: clamp(30px, 4vw, 46px); color: var(--text-heading); margin: 0 0 8px 0; line-height: 1.2; }
h2 { font-family: var(--font-head); font-weight: 800; font-size: 22px; color: var(--text-heading); margin: 0 0 12px 0; letter-spacing: -0.01em; }
h3 { font-family: var(--font-head); font-weight: 700; font-size: 18px; color: var(--text-heading); margin: 0 0 8px 0; }

/* CARDS & INDICATOR RAILS */
.card { position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 18px 20px 18px 22px; overflow: hidden; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.25); }
.card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: linear-gradient(to bottom, var(--accent), color-mix(in srgb, var(--accent) 40%, #000)); }
.card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; border-bottom: 1px solid var(--line-soft); padding-bottom: 10px; margin-bottom: 14px; }

/* CHIPS, TAGS, & BADGES */
.chip, .pos-tag { font-family: var(--font-mono); font-size: 13px; font-weight: 600; color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); padding: 3px 9px; border-radius: var(--radius-sm); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); display: inline-flex; align-items: center; }
.badge { font-family: var(--font-mono); font-size: 13px; color: var(--muted); border: 1px solid var(--line-strong); padding: 2px 8px; border-radius: var(--radius-sm); background: transparent; }

/* INTERACTIVE CONTROLS & FEEDBACK */
.opt { background: var(--surface-elevated); border: 1px solid var(--line); color: var(--text); padding: 9px 14px; border-radius: var(--radius-sm); font-size: 14.5px; font-weight: 500; cursor: pointer; transition: all 0.15s ease; text-align: left; width: 100%; box-sizing: border-box; }
.opt:hover:not(:disabled) { border-color: var(--accent); color: #ffffff; background: color-mix(in srgb, var(--accent) 10%, var(--surface-elevated)); }
.opt[data-state="correct"], .opt.correct { background: rgba(16, 185, 129, 0.18) !important; border-color: #10b981 !important; color: #ffffff !important; }
.opt[data-state="incorrect"], .opt.incorrect { background: rgba(244, 63, 94, 0.18) !important; border-color: #f43f5e !important; color: #ffffff !important; }
input.blank { background: var(--bg); border: 1px solid var(--line); border-bottom: 2px solid var(--accent); color: #ffffff; font-family: var(--font-body); font-size: 15px; padding: 4px 8px; border-radius: var(--radius-sm); outline: none; }
input.blank:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--brand-glow); }
input.blank.correct { border-color: #10b981 !important; background: rgba(16, 185, 129, 0.12) !important; }
input.blank.incorrect { border-color: #f43f5e !important; background: rgba(244, 63, 94, 0.12) !important; }

`;

  // Contract version: bump to v4 for full format & style refresh
  const CONTRACT_VERSION = 'v6';
  const CONTRACT_VERSION_KEY = 'zlides_contract_version';
  const space = (key: string, fallback: string) => {
    if (typeof localStorage === 'undefined') return fallback;
    const storedVersion = localStorage.getItem(CONTRACT_VERSION_KEY);
    if (storedVersion !== CONTRACT_VERSION) {
      // Clear stale contract caches — new defaults will take effect.
      localStorage.removeItem(`zlides_space_type`);
      localStorage.removeItem(`zlides_space_format`);
      localStorage.removeItem(`zlides_space_style`);
      localStorage.setItem(CONTRACT_VERSION_KEY, CONTRACT_VERSION);
      return fallback;
    }
    return localStorage.getItem(`zlides_space_${key}`) || fallback;
  };
  const initialTypeText = space('type', DEFAULT_TYPE_PROMPT);
  let typeSpace = $state(initialTypeText);
  let formatSpace = $state(space('format', ''));
  let styleSpace = $state(space('style', DEFAULT_STYLE_TOKENS));
  let isContractsOpen = $state(false);
  let previewMode = $state<'document' | 'slides' | 'webpage'>(
    initialTypeText.trim() === SLIDES_TYPE_PROMPT.trim()
      ? 'slides'
      : initialTypeText.trim() === WEBPAGE_TYPE_PROMPT.trim()
        ? 'webpage'
        : 'document'
  );
  let stageFitMode = $state<'fill' | 'fit-page' | '100%'>('fill');

  function typePromptForMode(mode: 'document' | 'slides' | 'webpage'): string {
    if (mode === 'slides') return SLIDES_TYPE_PROMPT;
    if (mode === 'webpage') return WEBPAGE_TYPE_PROMPT;
    return DEFAULT_TYPE_PROMPT;
  }

  function applyLayoutType(mode: 'document' | 'slides' | 'webpage') {
    previewMode = mode;
    typeSpace = typePromptForMode(mode);
  }

  /** Which style is in the slot — derived, so editing it in Contracts stays truthful. */
  const styleChoice = $derived(
    styleSpace.trim() === ''
      ? 'auto'
      : styleSpace.trim() === DESIGN_MD_TEXT.trim()
        ? 'design-md'
        : styleSpace.trim() === DEFAULT_STYLE_TOKENS.trim()
          ? 'gitenglish'
          : 'custom'
  );

  const formatChoice = $derived(
    formatSpace.trim() === '' ? 'none'
      : formatSpace.trim() === DEFAULT_FORMAT_PROMPT.trim() ? 'worksheet'
        : 'custom'
  );

  function setStyleChoice(id: string) {
    if (id === 'auto') styleSpace = '';
    else if (id === 'gitenglish') styleSpace = DEFAULT_STYLE_TOKENS;
    else if (id === 'design-md') styleSpace = DESIGN_MD_TEXT;
  }

  $effect(() => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem('zlides_space_type', typeSpace);
    localStorage.setItem('zlides_space_format', formatSpace);
    localStorage.setItem('zlides_space_style', styleSpace);
  });

  const contractsSigned = $derived(typeSpace.trim().length > 0);

  // ── Resizable sidebar ───────────────────────────────────────────────────
  const SIDEBAR_MIN = 340;
  const SIDEBAR_MAX = 800;
  let sidebarWidth = $state(Number(typeof localStorage !== 'undefined' ? localStorage.getItem('zlides_sidebar_w') : null) || 420);
  let isResizing = $state(false);

  function startResize(e: PointerEvent) {
    e.preventDefault();
    isResizing = true;
    document.body.style.userSelect = 'none';
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function doResize(e: PointerEvent) {
    if (!isResizing) return;
    sidebarWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, e.clientX));
  }

  function endResize() {
    if (!isResizing) return;
    isResizing = false;
    document.body.style.userSelect = '';
    localStorage.setItem('zlides_sidebar_w', String(sidebarWidth));
  }

  async function refreshSavedSlides() {
    isLoadingSaved = true;
    try {
      savedSlides = await fetchSavedSlides();
    } catch (e) {
      console.warn("Failed to load saved slides:", e);
    } finally {
      isLoadingSaved = false;
    }
  }

  async function loadVigContract() {
    try {
      const res = await fetch('/api/vig/contract');
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error((detail && detail.error) || `HTTP ${res.status}`);
      }
      const payload = await res.json();
      if (!payload || typeof payload.contract !== 'string' || !payload.contract.trim()) {
        throw new Error('the contract response was empty');
      }
      const override = typeof localStorage !== 'undefined' ? localStorage.getItem(VIG_OVERRIDE_KEY) : null;
      if (override && override.trim()) {
        vigContract = {
          text: override,
          chars: override.length,
          sha256: 'edited-in-app',
          source: 'in-app override',
        };
      } else {
        vigContract = {
          text: payload.contract,
          chars: payload.chars,
          sha256: payload.sha256,
          source: payload.source,
        };
      }
      vigContractError = null;
      return vigContract;
    } catch (err: any) {
      vigContract = null;
      vigContractError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  onMount(() => {
    refreshSavedSlides();
    void loadVigContract();
    void loadLacContract();

    // Global keyboard navigation for slides (Left/Right arrows)
    const handleKeyNav = (e: KeyboardEvent) => {
      const activeTag = (document.activeElement?.tagName || '').toLowerCase();
      if (activeTag === 'input' || activeTag === 'textarea' || isSavedModalOpen || isEditingHtml || isApiKeyModalOpen) return;
      if (e.key === 'ArrowLeft') prevPage();
      else if (e.key === 'ArrowRight') nextPage();
    };

    window.addEventListener('keydown', handleKeyNav);
    return () => window.removeEventListener('keydown', handleKeyNav);
  });

  const OPEN_DOC_KIND_META = '<meta name="zlides-doc-kind" content="open-slide">';
  function markOpenDocument(html: string): string {
    if (html.includes(OPEN_DOC_KIND_META)) return html;
    if (/<head(\s[^>]*)?>/i.test(html)) {
      return html.replace(/<head(\s[^>]*)?>/i, (tag) => `${tag}\n${OPEN_DOC_KIND_META}`);
    }
    return `<!DOCTYPE html><html><head>${OPEN_DOC_KIND_META}</head><body>${html}</body></html>`;
  }

  async function selectSavedSlide(slide: SavedSlide) {
    status = `Loading ${slide.title}...`;
    try {
      let html = slide.html;
      if (!html) {
        html = await fetchSavedSlideHtml(slide.filename);
      }
      // A saved guide declares its kind explicitly: worksheet placeholder
      // injection would overwrite its sections with exercise scaffolding.
      if (html.includes(LAC_DOC_KIND_META)) {
        lacHtml = html;
        appMode = 'lac';
        pages = [];
        selectedPageIndex = 0;
        clearConversation();
        isSavedModalOpen = false;
        status = `Loaded worksheet: ${slide.title}`;
        addMessage(`[Loaded LAC worksheet] **${slide.title}** (${slide.dateStr})`, 'agent');
        return;
      }
      if (html.includes(VIG_DOC_KIND_META)) {
        vigHtml = html;
        vigTitleInput = slide.title;
        appMode = 'vig';
        pages = [];
        selectedPageIndex = 0;
        clearConversation();
        isSavedModalOpen = false;
        status = `Loaded guide: ${slide.title}`;
        addMessage(`[Loaded Video Immersion Guide] **${slide.title}** (${slide.dateStr})`, 'agent');
        return;
      }
      if (html.includes(OPEN_DOC_KIND_META)) {
        appMode = 'open';
        const openParts = splitSavedPages(html);
        pages = openParts.length > 0
          ? openParts.map((partHtml: string, i: number) => ({ position: i + 1, html: partHtml.trim() }))
          : [{ position: 1, html }];
        selectedPageIndex = 0;
        clearConversation();
        isSavedModalOpen = false;
        status = `Loaded: ${slide.title} (${pages.length} page${pages.length === 1 ? '' : 's'})`;
        addMessage(`[Loaded Open Deck] **${slide.title}** (${slide.dateStr}) · ${pages.length} page${pages.length === 1 ? '' : 's'}`, 'agent');
        return;
      }
      html = normalizeSavedHtml(html);
      appMode = 'sheet';
      const sheetParts = splitSavedPages(html);
      pages = sheetParts.length > 0
        ? sheetParts.map((partHtml: string, i: number) => ({ position: i + 1, html: ensurePlaceholders(partHtml) }))
        : [{ position: 1, html: ensurePlaceholders(html) }];
      selectedPageIndex = 0;
      // W3/W4: a vault deck has no live server conversation — decouple continuation
      // and server export from the previously streamed session.
      clearConversation();
      isSavedModalOpen = false;
      status = `Loaded: ${slide.title} (${pages.length} page${pages.length === 1 ? '' : 's'})`;
      addMessage(`[Loaded Saved Class] **${slide.title}** (${slide.dateStr}) · ${pages.length} page${pages.length === 1 ? '' : 's'}`, 'agent');
    } catch (err: any) {
      status = `Error loading slide: ${err.message}`;
    }
  }

  async function handleDownloadSaved(e: MouseEvent, slide: SavedSlide) {
    e.stopPropagation();
    try {
      let html = slide.html;
      if (!html) {
        html = await fetchSavedSlideHtml(slide.filename);
      }
      const outHtml = html.includes(OPEN_DOC_KIND_META) ? assembleSingleDocument(splitSavedPages(html)) : html;
      downloadHtmlFile(outHtml, cleanExportFilename(slide.title, outHtml, slide.filename));
    } catch (err: any) {
      console.error("Could not download slide:", err);
    }
  }

  let filteredSavedSlides = $derived(
    savedSlides.filter((s) => {
      if (!savedSearchQuery.trim()) return true;
      const q = savedSearchQuery.toLowerCase();
      return (
        (s.title && s.title.toLowerCase().includes(q)) ||
        (s.filename && s.filename.toLowerCase().includes(q)) ||
        (s.dateStr && s.dateStr.toLowerCase().includes(q))
      );
    })
  );

  function estimateTokensClient(): number {
    let rawLen = promptText.length + extractedMarkdown.length + activeSkillBlock().length;
    if (appMode === 'sheet') {
      rawLen += typeSpace.length + formatSpace.length + styleSpace.length;
    } else if (appMode === 'open') {
      rawLen += typeSpace.length;
    } else if (appMode === 'vig') {
      rawLen += vigLinkInput.length + vigTitleInput.length;
    } else if (appMode === 'lac' && lac) {
      rawLen += JSON.stringify(lac).length;
    }
    if (rawLen === 0) return 0;
    return Math.ceil(rawLen / 3.5);
  }

  function updateCostEstimate() {
    if (isGenerating) return;
    const hasInput =
      Boolean(promptText.trim()) ||
      Boolean(extractedMarkdown) ||
      (appMode === 'vig' && Boolean(vigLinkInput.trim())) ||
      (appMode === 'lac' && Boolean(lac));
    if (!hasInput) {
      if (pages.length === 0 && !vigHtml && !lacHtml) {
        cost = 0;
        lastTokens = null;
      }
      return;
    }
    const est = estimateTokensClient();
    lastTokens = est;
    cost = (est / 1_000_000) * 0.70;
  }

  let costTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    void promptText;
    void extractedMarkdown;
    void appMode;
    void vigLinkInput;
    void lac;
    clearTimeout(costTimer);
    costTimer = setTimeout(() => {
      updateCostEstimate();
    }, 250);
    return () => clearTimeout(costTimer);
  });

  async function handleFileSelect(e: Event) {
    const target = e.target as HTMLInputElement;
    if (target.files && target.files.length > 0) {
      const file = target.files[0];
      attachedFileName = file.name;
      isUploading = true;
      status = `Reading ${file.name}...`;

      try {
        extractedMarkdown = await file.text();
        status = `Attached: ${file.name} (${(extractedMarkdown.length / 1024).toFixed(1)} KB)`;
        updateCostEstimate();
      } catch (err: any) {
        status = `Failed to read file: ${err.message}`;
      } finally {
        isUploading = false;
      }
    }
  }

  function clearAttachedFile() {
    attachedFileName = "";
    extractedMarkdown = "";
    updateCostEstimate();
  }

  let currentController = $state<AbortController | null>(null);
  let chatMessages = $state<any[]>([
    { role: "agent", text: "Ready! Select your target format, structure, and style, then describe or attach your source notes." }
  ]);

  function scrollChatLive() {
    const h = document.getElementById("chat-history");
    if (!h) return;
    const nearBottom = h.scrollHeight - h.scrollTop - h.clientHeight < 120;
    if (nearBottom) h.scrollTop = h.scrollHeight;
  }

  function addMessage(text: string, role: string) {
    chatMessages = [...chatMessages, { role, text, thinking: '' }];
    requestAnimationFrame(() => {
      const h = document.getElementById("chat-history");
      if (h) h.scrollTop = h.scrollHeight;
    });
  }

  function stopRequest() {
    if (currentController) {
      currentController.abort();
      status = 'Stopping...';
    }
  }

  // ── R2: stepper over real pages (selection drives the derived stage srcdoc) ──
  function prevPage() {
    if (selectedPageIndex > 0) selectedPageIndex -= 1;
  }

  function nextPage() {
    if (selectedPageIndex < pages.length - 1) selectedPageIndex += 1;
  }

  // ── R5: editor paths (semantics preserved, now over pages) ──
  function applyEditorHtml() {
    if (appMode === 'vig') {
      vigHtml = editorHtml;
      isEditingHtml = false;
      return;
    }
    // An assembled worksheet must be stored exactly as edited: placeholder injection
    // would inject fake sections and strip the engine's escapes again.
    if (lacHtml || /zlides-doc-kind/.test(editorHtml)) {
      lacHtml = editorHtml;
      isEditingHtml = false;
      return;
    }
    const ensured = appMode === 'open' ? decodeHtmlPayload(editorHtml) : ensurePlaceholders(editorHtml);
    if (pages.length === 0) {
      pages = [{ position: 1, html: ensured }];
      selectedPageIndex = 0;
    } else if (pages[selectedPageIndex]) {
      pages[selectedPageIndex].html = ensured;
    }
    isEditingHtml = false;
  }

  function toggleEditor() {
    if (isEditingHtml) {
      applyEditorHtml();
    } else {
      editorHtml = appMode === 'vig' ? (vigHtml ?? '') : appMode === 'lac' ? (lacHtml ?? '') : (selectedPage?.html ?? iframeSrcDoc);
      isEditingHtml = true;
    }
  }

  // ── R4: typed HTTP failure so mapping keys on the status field, never message sniffing ──
  class HttpError extends Error {
    readonly status: number;
    readonly statusText: string;
    constructor(status: number, statusText: string) {
      super(`API returned ${status}: ${statusText}`);
      this.name = 'HttpError';
      this.status = status;
      this.statusText = statusText;
    }
  }

  function describeFailure(err: unknown): string {
    if (err instanceof HttpError) {
      if (err.status === 401 || err.status === 403) return 'API key invalid or missing. Check Settings (key button, top left)';
      if (err.status === 429) return 'Rate limited by the provider. Wait a moment and try again';
      if (err.status >= 500) return 'Provider server error. Please retry in a moment';
      return `Request rejected (HTTP ${err.status} ${err.statusText})`;
    }
    if (err instanceof Error) {
      if (err.name === 'AbortError') return 'Generation stopped';
      return `Connection to Z.AI failed: ${err.message}`;
    }
    return `Generation failed: ${String(err)}`;
  }

  function humanizeStreamError(code: string | null): string {
    if (code === '1301') return 'Content policy blocked this request';
    return 'The generation stream reported a failure';
  }

  // ── Preview stage geometry: measured at runtime, zero hardcoded viewport clamps ──
  let stageBoxW = $state(0);
  let stageBoxH = $state(0);
  const DOC_LOGICAL_W = 794; // 210mm at 96 CSS dpi
  const DOC_LOGICAL_H = 1123; // 297mm at 96 CSS dpi (A4 portrait)
  const SLIDE_LOGICAL_W = 1280;
  const SLIDE_LOGICAL_H = 720;
  const stageInnerW = $derived(Math.max(0, stageBoxW - 32)); // minus stage padding
  const stageInnerH = $derived(Math.max(0, stageBoxH - 32));

  // A4 portrait proportional fit for 'fit-page' mode
  const a4FitScale = $derived(
    stageInnerW > 0 && stageInnerH > 0
      ? Math.min(stageInnerW / DOC_LOGICAL_W, stageInnerH / DOC_LOGICAL_H)
      : 1
  );

  // Slides: scale whole 1280×720 canvas to fit both dimensions (up/down).
  const slideScale = $derived(
    stageInnerW > 0 && stageInnerH > 0
      ? (stageFitMode === '100%' ? 1 : Math.min(stageInnerW / SLIDE_LOGICAL_W, stageInnerH / SLIDE_LOGICAL_H))
      : 1
  );

  const VIG_AGENT_URL = 'https://api.z.ai/api/v1/agents';

  async function loadLacContract() {
    try {
      const res = await fetch('/api/lac/contract');
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error((detail && detail.error) || `HTTP ${res.status}`);
      }
      const payload = await res.json();
      if (!payload || typeof payload.contract !== 'string' || !payload.contract.trim()) {
        throw new Error('the skill response was empty');
      }
      const lacOverride = typeof localStorage !== 'undefined' ? localStorage.getItem(LAC_OVERRIDE_KEY) : null;
      if (lacOverride && lacOverride.trim()) {
        lacContract = { text: lacOverride, chars: lacOverride.length, sha256: 'edited-in-app' };
      } else {
        lacContract = { text: payload.contract, chars: payload.chars, sha256: payload.sha256 };
      }
      lacChassis = payload.styles && payload.engine ? { styles: payload.styles, engine: payload.engine, links: payload.links } : null;
      lacContractError = null;
      return lacContract;
    } catch (err: any) {
      lacContract = null;
      lacContractError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  /** One input, any file. A LAC JSON is used directly; anything else becomes source
   *  material the agent derives a LAC from. The extension never decides this. */
  async function handleLacFile(e: Event) {
    const target = e.target as HTMLInputElement;
    const file = target.files && target.files[0];
    if (!file) return;
    lacError = null;
    try {
      const parsed = parseLac(JSON.parse(await file.text()));
      if (!parsed.lac) {
        lac = null;
        lacPlan = [];
        lacFileName = file.name;
        lacError = `That file is not a LAC: ${parsed.errors.join('; ')}`;
        return;
      }
      lac = parsed.lac;
      lacFileName = file.name;
      lacSeed = hashSeed(`${lac.title ?? ''}|${lac.sessionDate ?? ''}`);
      const plan = buildPlacementPlan(lac, lacSeed);
      lacPlan = plan.slots;
      if (plan.uncovered.length) lacError = `unplaced items: ${plan.uncovered.join(', ')}`;
      status = `LAC ready: ${lacItems(lac).length} items, ${plan.slots.length} placements`;
    } catch (err: any) {
      lac = null;
      lacPlan = [];
      lacError = `Not valid JSON: ${err.message}`;
    }
  }

  async function callAgentText(prompt: string): Promise<string> {
    const parser = new SseParser();
    let answer = '';
    const handle = (events: SseEvent[]) => {
      for (const ev of events) {
        if (ev.kind === 'answer') answer += ev.text;
        else if (ev.kind === 'usage') {
          lastTokens = ev.totalTokens;
          cost = Number(((ev.totalTokens / 1_000_000) * 0.70).toFixed(4));
        } else if (ev.kind === 'stream_error') {
          streamErrors = [...streamErrors, { code: ev.code, message: ev.message }];
        }
      }
    };
    const response = await fetch('https://api.z.ai/api/v1/agents', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept-Language': 'en-US,en',
      },
      body: JSON.stringify({
        agent_id: 'slides_glm_agent',
        stream: true,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      }),
      signal: currentController ? currentController.signal : undefined,
    });
    if (!response.ok) throw new HttpError(response.status, response.statusText);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Response has no readable body. Stream unavailable');
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
      if (buffer.trim().length > 0) {
        for (const line of feedSseFrame(`${buffer}\n`).lines) handle(parser.push(line));
      }
    } finally {
      handle(parser.flush());
    }
    return answer;
  }

  /** Re-roll one exercise: same widget, same four items, new sentences and options. */
  async function regenerateModule(index: number) {
    if (!lacBuild || !lac || !lacChassis || isGenerating) return;
    const module = lacBuild.modules[index];
    if (!module) return;
    const items = lacPlan.slice(index * 4, index * 4 + 4).map((slot) => slot.item);
    regenerating = index;
    isGenerating = true;
    currentController = new AbortController();
    status = `New version of ${module.id ?? index + 1} (${module.widget})…`;
    try {
      const prompt = [
        'Regenerate ONE module of an existing worksheet.',
        `Module: ${module.id ?? ''} (${module.widget})`,
        `Keep this widget and these four target items: ${items.join(', ')}.`,
        'Write NEW sentences, options, answers and explanations. Do not reuse the previous wording.',
        'Return ONLY that module as one JSON object, same shape as before.',
        '',
        '===== SHAPES =====',
        lacContract ? lacContract.text : '',
        '',
        '===== LAC =====',
        JSON.stringify(lac, null, 2),
      ].join('\n');
      const answer = await callAgentText(prompt);
      const parsed = parseLacModule(answer);
      if (!parsed.module) throw new Error(parsed.errors.join('; '));
      const modules = lacBuild.modules.map((m, i) => (i === index ? { ...parsed.module!, id: m.id } : m));
      const next: LacBuild = { ...lacBuild, modules };
      const html = buildLacDocument(next, lacChassis, lac.sessionDate ?? '');
      const check = validateLacDocument(html);
      if (check.errors.length) throw new Error(check.errors.join('; '));
      lacBuild = next;
      lacHtml = markLacDocument(html);
      const saved = await saveSlideToStorage(lacHtml, lac.title || lacFileName || 'LAC worksheet');
      await refreshSavedSlides();
      status = `New version of ${module.id ?? index + 1} ready · saved as ${saved.title}`;
    } catch (err: any) {
      const human = err instanceof HttpError ? describeFailure(err) : err instanceof Error ? err.message : String(err);
      streamErrors = [...streamErrors, { code: null, message: human }];
      status = human;
    } finally {
      regenerating = null;
      isGenerating = false;
      currentController = null;
    }
  }

  async function generateLac() {
    if (isGenerating) return;
    if (!apiKey) { isApiKeyModalOpen = true; status = 'Please set your API Key to generate.'; return; }
    if (!lac) {
      streamErrors = [{ code: null, message: 'Attach a LAC JSON first.' }];
      status = 'No LAC attached';
      return;
    }

    let contract = lacContract;
    if (!contract) contract = await loadLacContract();
    if (!contract) {
      streamErrors = [{ code: null, message: `The LAC skill could not be read: ${lacContractError ?? 'unknown error'}` }];
      status = 'LAC skill unavailable';
      return;
    }

    const slots = lacPlan.length ? lacPlan : buildPlacementPlan(lac, lacSeed).slots;
    if (!lacPlan.length) lacPlan = slots;

    streamErrors = [];
    wireNotices = 0;
    lacHtml = null;
    isGenerating = true;
    currentController = new AbortController();
    status = 'Building the worksheet from the LAC...';

    addMessage(`[LAC Studio]\n${lac.title ?? lacFileName}`, 'user');
    const agentMsgIndex = chatMessages.length;
    chatMessages = [...chatMessages, { role: 'agent', text: '', thinking: '' }];

    let thinkingAccumulator = '';
    let answerAccumulator = '';

    const skillsPrefix = activeSkillBlock();
    const fullPrompt = [
      skillsPrefix,
      LAC_BUILD_CONTRACT,
      '',
      '===== REFERENCE — the studio your JSON is assembled into. Read it for module mechanics; do NOT write it. =====',
      contract.text,
      '',
      '===== PLACEMENT PLAN — exactly these modules, in this order =====',
      formatPlanForPrompt(slots, lac),
      lacDirection.trim() ? `\n===== ONE-OFF DIRECTION FOR THIS SESSION =====\n${lacDirection.trim()}` : '',
      '',
      `===== LAC (${lacFileName || 'lac.json'}) =====`,
      JSON.stringify(lac, null, 2),
      PREFERENCES_BLOCK,
    ].filter(Boolean).join('\n');

    try {
      const parser = new SseParser();
      const store = new PageStore();
      const response = await fetch('https://api.z.ai/api/v1/agents', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept-Language': 'en-US,en',
        },
        body: JSON.stringify({
          agent_id: 'slides_glm_agent',
          stream: true,
          messages: [{ role: 'user', content: [{ type: 'text', text: fullPrompt }] }],
        }),
        signal: currentController.signal,
      });
      if (!response.ok) throw new HttpError(response.status, response.statusText);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Response has no readable body. Stream unavailable');
      const decoder = new TextDecoder();
      let buffer = '';

      const handleLacEvents = (events: SseEvent[]) => {
        for (const ev of events) {
          switch (ev.kind) {
            case 'thinking':
              thinkingAccumulator += ev.text;
              chatMessages[agentMsgIndex].thinking = thinkingAccumulator;
              chatMessages = [...chatMessages];
              scrollChatLive();
              break;
            case 'answer': {
              answerAccumulator += ev.text;
              chatMessages[agentMsgIndex].text = answerAccumulator;
              chatMessages = [...chatMessages];
              scrollChatLive();
              const received = (answerAccumulator.match(/"widget"\s*:/g) || []).length;
              if (received > 0) status = `Receiving module configs: ${Math.min(received, 8)}/8`;
              break;
            }
            case 'page':
              store.applyEvent(ev);
              break;
            case 'usage':
              lastTokens = ev.totalTokens;
              cost = Number(((ev.totalTokens / 1_000_000) * 0.70).toFixed(4));
              break;
            case 'stream_error':
              streamErrors = [...streamErrors, { code: ev.code, message: ev.message }];
              status = humanizeStreamError(ev.code);
              break;
            case 'done':
              break;
          }
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { lines, rest } = feedSseFrame(buffer);
          buffer = rest;
          for (const line of lines) handleLacEvents(parser.push(line));
        }
        buffer += decoder.decode();
        if (buffer.trim().length > 0) {
          for (const line of feedSseFrame(`${buffer}\n`).lines) handleLacEvents(parser.push(line));
        }
      } finally {
        handleLacEvents(parser.flush());
      }
      wireNotices = parser.warnings.length;

      const asBuild = parseLacBuild(answerAccumulator);
      if (asBuild.warnings.length) {
        chatMessages[agentMsgIndex].text += `\n\n**Kept with issues:**\n${asBuild.warnings.map((w) => `- ${w}`).join('\n')}`;
        chatMessages = [...chatMessages];
      }
      let assembled: string;
      if (asBuild.build && lacChassis) {
        lacBuild = asBuild.build;
        assembled = buildLacDocument(asBuild.build, lacChassis, lac.sessionDate ?? '');
        status = 'Configs received · assembling the worksheet...';
      } else {
        let html = '';
        if (store.pages.length) html = assembleSingleDocument(store.pages.map((p) => p.html));
        else if (store.unpositioned.length) html = assembleSingleDocument(store.unpositioned.map((u) => u.html));
        if (!html.trim() && answerAccumulator.trim()) html = rescueDocumentFromAnswer(answerAccumulator) ?? '';
        if (!html.trim()) throw new Error('The agent returned neither build JSON nor HTML. Its text reply is in the chat.');
        assembled = lacChassis ? attachLacChassis(html, lacChassis) : html;
      }
      const docCheck = validateLacDocument(assembled);
      if (docCheck.mounts === 0 || docCheck.configs === 0) {
        throw new Error(`The agent did not follow the structure (${docCheck.errors.join('; ')}), so nothing was saved.`);
      }
      if (docCheck.errors.length) {
        chatMessages[agentMsgIndex].text += `\n\n**Kept with notices:**\n${docCheck.errors.map((e) => `- ${e}`).join('\n')}`;
        chatMessages = [...chatMessages];
      }
      const marked = markLacDocument(assembled);
      lacHtml = marked;
      const saved = await saveSlideToStorage(marked, lac.title || lacFileName || 'LAC worksheet');
      await refreshSavedSlides();
      status = `Worksheet ready: ${lacItems(lac).length} LAC items placed · saved as ${saved.title}`;
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        status = 'Generation stopped';
      } else {
        const human = err instanceof HttpError ? describeFailure(err) : err instanceof Error ? err.message : String(err);
        streamErrors = [...streamErrors, { code: null, message: human }];
        status = human;
        if (chatMessages[agentMsgIndex] && !chatMessages[agentMsgIndex].text) {
          chatMessages[agentMsgIndex].text = `**Generation Error:** ${human}`;
          chatMessages = [...chatMessages];
        }
      }
    } finally {
      isGenerating = false;
      currentController = null;
    }
  }

  // ── VIG engine: YouTube link → real transcript → curriculum JSON → compiled
  // guide. Deliberately a separate path: it never touches pages, PageStore or
  // ensurePlaceholders (placeholder injection would wreck the guide). ──
  async function generateVig() {
    if (isGenerating) return;
    if (!apiKey) {
      isApiKeyModalOpen = true;
      status = 'Please set your API Key to generate.';
      return;
    }
    const videoId = parseYouTubeId(vigLinkInput);
    if (!videoId) {
      streamErrors = [{ code: null, message: 'That is not a YouTube link or an 11-character video id.' }];
      status = 'Invalid YouTube link';
      return;
    }
    const title = vigTitleInput.trim() || videoId;

    // The rules live in the skill, not in this app: fetch them at run time and
    // refuse to generate on a stale or missing copy.
    let contract = vigContract;
    if (!contract) contract = await loadVigContract();
    if (!contract) {
      streamErrors = [{ code: null, message: `VIG contract unavailable from the skill: ${vigContractError ?? 'unknown error'}` }];
      status = 'VIG contract unavailable';
      return;
    }

    streamErrors = [];
    wireNotices = 0;
    vigHtml = null;
    isGenerating = true;
    currentController = new AbortController();
    status = 'Fetching the YouTube transcript...';

    const textToSend = `Video Immersion Guide for ${videoId}${vigTitleInput.trim() ? ` ("${vigTitleInput.trim()}")` : ''}`;
    addMessage(`[Video Immersion Guide]\n${textToSend}`, 'user');
    const agentMsgIndex = chatMessages.length;
    chatMessages = [...chatMessages, { role: 'agent', text: '', thinking: '' }];

    let thinkingAccumulator = '';
    let answerAccumulator = '';

    try {
      const transcriptResponse = await fetch(
        `/api/vig/transcript?video=${encodeURIComponent(videoId)}`,
        { signal: currentController.signal }
      );
      if (!transcriptResponse.ok) {
        const detail = await transcriptResponse.json().catch(() => null);
        const reason = detail && detail.error ? `: ${detail.error}` : '';
        throw new Error(`Transcript fetch failed (HTTP ${transcriptResponse.status})${reason}`);
      }
      const payload = await transcriptResponse.json();
      const cues: VigCue[] = Array.isArray(payload?.cues) ? payload.cues : [];
      if (cues.length === 0) {
        throw new Error('The transcript came back with zero cues, so nothing can be synchronized.');
      }
      console.log('[vig] transcript', videoId, payload?._source, cues.length, 'cues');
      status = `Transcript ready: ${cues.length} cues · streaming the curriculum...`;

      const skillsPrefix = activeSkillBlock();
      const fullPrompt = assemblePrompt({
        typeText: (skillsPrefix ? skillsPrefix + '\n\n' : '') + `GLOBAL RULE FOR THIS APP: the learner's first language is not specified. Do not assume Spanish and do not apply Spanish-specific cognate rules.\n\n` + contract.text,
        formatText: '',
        userText: `Build the curriculum for ${textToSend}. The learner is an adult English learner of any first language. Return only the JSON object.`,
        styleText: '',
        attachedMarkdown: JSON.stringify(cues),
        attachedFileName: 'transcript.json',
        preferencesText: PREFERENCES_TEXT,
      });
      console.log('[vig] prompt chars:', fullPrompt.length);

      const parser = new SseParser();
      const response = await fetch(VIG_AGENT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept-Language': 'en-US,en',
        },
        body: JSON.stringify({
          agent_id: 'slides_glm_agent',
          stream: true,
          messages: [{ role: 'user', content: [{ type: 'text', text: fullPrompt }] }],
        }),
        signal: currentController.signal,
      });
      if (!response.ok) throw new HttpError(response.status, response.statusText);

      const reader = response.body?.getReader();
      if (!reader) throw new Error('Response has no readable body. Stream unavailable');
      const decoder = new TextDecoder();
      let buffer = '';

      const handleEvents = (events: SseEvent[]) => {
        for (const ev of events) {
          switch (ev.kind) {
            case 'thinking': {
              thinkingAccumulator += ev.text;
              chatMessages[agentMsgIndex].thinking = thinkingAccumulator;
              chatMessages = [...chatMessages];
              scrollChatLive();
              break;
            }
            case 'answer': {
              answerAccumulator += ev.text;
              chatMessages[agentMsgIndex].text = answerAccumulator;
              chatMessages = [...chatMessages];
              scrollChatLive();
              break;
            }
            case 'usage': {
              lastTokens = ev.totalTokens;
              cost = Number(((ev.totalTokens / 1_000_000) * 0.70).toFixed(4));
              break;
            }
            case 'stream_error': {
              streamErrors = [...streamErrors, { code: ev.code, message: ev.message }];
              status = humanizeStreamError(ev.code);
              break;
            }
            case 'done':
              break;
          }
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { lines, rest } = feedSseFrame(buffer);
          buffer = rest;
          for (const line of lines) handleEvents(parser.push(line));
        }
        buffer += decoder.decode();
        if (buffer.trim().length > 0) {
          for (const line of feedSseFrame(`${buffer}\n`).lines) handleEvents(parser.push(line));
        }
      } finally {
        handleEvents(parser.flush());
      }
      wireNotices = parser.warnings.length;

      console.log('[vig] raw answer chars:', answerAccumulator.length);

      let extracted = extractCurriculumJson(answerAccumulator);
      if (!extracted) {
        status = 'No curriculum JSON — asking once more…';
        const retryAnswer = await callAgentText(
          `${fullPrompt}\n\nYOUR PREVIOUS REPLY WAS REJECTED: it contained no curriculum JSON. Return ONLY the JSON object described above. No slides, no HTML, no prose.`
        );
        extracted = extractCurriculumJson(retryAnswer);
        if (extracted) answerAccumulator = retryAnswer;
      }
      if (!extracted) {
        chatMessages[agentMsgIndex].text = `**Not curriculum JSON — raw reply:**\n\n\`\`\`\n${answerAccumulator.slice(0, 4000)}\n\`\`\``;
        chatMessages = [...chatMessages];
        throw new Error('The agent did not return curriculum JSON after a second attempt. Its raw reply is in the chat.');
      }

      const { vocab, repairs } = repairCurriculum(extracted, cues);
      if (repairs.length) {
        console.warn('[vig] repairs:', repairs);
        chatMessages[agentMsgIndex].text += `\n\n**Repairs (the guide still built):**\n${repairs.map((r) => `- ${r}`).join('\n')}`;
        chatMessages = [...chatMessages];
      }
      const report = validateCurriculum(vocab, cues);
      report.warnings.forEach((w) => console.warn('[vig]', w));
      if (vocab.segments.length === 0) {
        throw new Error('The curriculum had no usable segments after repair.');
      }
      if (report.errors.length > 0) {
        const detail = report.errors.map((e) => `- ${e}`).join('\n');
        chatMessages[agentMsgIndex].text += `\n\n**Kept with issues (the guide still built):**\n${detail}`;
        chatMessages = [...chatMessages];
        console.warn('[vig] kept with issues:', report.errors);
      }
      status = `${vocab.segments.length} segments validated · compiling the guide...`;

      const compiled = compileVigGuide(vigTemplate, { title, videoId, vocab, cues });
      vigHtml = compiled;
      const saved = await saveSlideToStorage(compiled, title);
      await refreshSavedSlides();
      status = `Guide ready: ${vocab.segments.length} segments · saved as ${saved.title}`;
      addMessage(`[Guide ready] **${title}** — ${vocab.segments.length} segments, ${cues.length} cues, saved as ${saved.title}`, 'agent');
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        status = 'Generation stopped';
      } else {
        const human = err instanceof HttpError ? describeFailure(err) : err instanceof Error ? err.message : String(err);
        streamErrors = [...streamErrors, { code: null, message: human }];
        status = human;
        if (chatMessages[agentMsgIndex] && !chatMessages[agentMsgIndex].text) {
          chatMessages[agentMsgIndex].text = `**Generation Error:** ${human}`;
          chatMessages = [...chatMessages];
        }
      }
    } finally {
      isGenerating = false;
      currentController = null;
    }
  }

  async function generate(opts?: {
    fullPrompt?: string;
    userLabel?: string;
    conversationId?: string | null;
    resetDeck?: boolean;
    autoDepth?: number;
  }) {
    if (!opts?.fullPrompt && !promptText.trim() && !extractedMarkdown) return;
    if (!apiKey) {
      isApiKeyModalOpen = true;
      status = "Please set your API Key to generate.";
      return;
    }

    const autoDepth = opts?.autoDepth ?? 0;
    const prevPageCount = pages.length;

    // W3: fresh request state; a continuation (opts.conversationId set) keeps the deck.
    lastStreamInterrupted = false;
    offerRestartWithContext = false;
    // Open mode keeps ONE conversation: once a deck exists, every send is an edit in the same
    // conversation (same conversation_id, deck kept). "New chat" clears it explicitly.
    const isOpenFollowUp = appMode === 'open' && opts?.conversationId == null && conversationId !== null && pages.length > 0;
    const requestConversationId = opts?.conversationId ?? (isOpenFollowUp ? conversationId : null);
    const isContinuation = requestConversationId != null;

    isGenerating = true;
    const textToSend = opts?.userLabel ?? promptText.trim();
    const fileName = attachedFileName;
    promptText = "";
    status = "Connecting to Z.AI Agent...";

    const isOpenMode = appMode === 'open';
    const finalizePageHtml = (rawHtml: string) =>
      isOpenMode ? decodeHtmlPayload(rawHtml) : ensurePlaceholders(rawHtml);

    // ── Strict injection order: 1. Layout (Type) → 2. Format / Active Skill → 3. Content → 4. Style ──
    const skillsBlock = activeSkillBlock();
    const fullPrompt =
      opts?.fullPrompt ??
      (isOpenMode
        ? assemblePrompt({
            typeText: isOpenFollowUp ? '' : typeSpace,
            formatText: skillsBlock,
            userText: textToSend,
            styleText: '',
            attachedMarkdown: extractedMarkdown,
            attachedFileName: fileName,
            preferencesText: PREFERENCES_TEXT,
          })
        : assemblePrompt({
            typeText: typeSpace,
            formatText: [formatSpace.trim(), skillsBlock].filter(Boolean).join('\n\n'),
            userText: textToSend,
            styleText: styleSpace,
            attachedMarkdown: extractedMarkdown,
            attachedFileName: fileName,
            preferencesText: PREFERENCES_TEXT,
          }));

    addMessage(
      opts?.fullPrompt
        ? `[${textToSend}]`
        : `[Generation${fileName ? ` · ${fileName}` : ""}]\n${textToSend || "(from attached source material)"}`,
      "user"
    );

    // Agent response holder
    const agentMsgIndex = chatMessages.length;
    chatMessages = [...chatMessages, { role: "agent", text: "", thinking: "" }];

    // ── R1/R2: fresh typed-event pipeline. No regex, no chunk joining, no silent catches. ──
    const parser = new SseParser();
    const store = new PageStore();
    if (opts?.resetDeck ?? !isOpenFollowUp) {
      pages = [];
      selectedPageIndex = 0;
    } else {
      // Keeping the deck: seed the store so edited pages overwrite by position and the rest survive.
      for (const p of pages) {
        store.apply({ kind: 'page', position: p.position, html: p.html, tool: 'seed', title: p.title ?? null });
      }
    }
    livePageHtml = null;
    livePagePosition = null;
    lastLiveHeadHtml = '';
    savedLiveScroll = null;
    streamErrors = [];
    wireNotices = 0;
    currentController = new AbortController();

    let thinkingAccumulator = "";
    let answerAccumulator = "";
    let lastLivePaintMs = 0;
    let gotPageEvent = false;
    let truncatedByLength = false;
    let abortedByUser = false;

    // R4: malformed/unknown wire frames go to console + a quiet counter, never the void.
    const drainWireNotices = () => {
      const total = parser.warnings.length + store.warnings.length;
      if (total <= wireNotices) return;
      for (let i = wireNotices; i < parser.warnings.length; i++) console.warn('[sse]', parser.warnings[i]);
      for (let i = parser.warnings.length; i < total; i++) console.warn('[page]', store.warnings[i - parser.warnings.length]);
      wireNotices = total;
    };

    const handleEvents = (events: SseEvent[]) => {
      for (const ev of events) {
        switch (ev.kind) {
          case 'thinking': {
            thinkingAccumulator += ev.text;
            chatMessages[agentMsgIndex].thinking = thinkingAccumulator;
            chatMessages = [...chatMessages];
            scrollChatLive();
            break;
          }
          case 'page': {
            gotPageEvent = true;
            store.applyEvent(ev);
            lastLivePaintMs = Date.now();
            captureLiveScroll(ev.position);
            pages = store.pages.map((p) => ({ ...p, html: finalizePageHtml(p.html) }));
            const finalized = finalizePageHtml(ev.html);
            lastLiveHeadHtml = splitLiveHtml(finalized)?.head ?? '';
            livePageHtml = finalized;
            livePagePosition = ev.position;
            status = `Streaming... page ${ev.position ?? '?'} received`;
            break;
          }
          case 'page_progress': {
            // In-page streaming: wait until <body> starts so we never mount an
            // unclosed <head><style> and flash blank; once <head> is mounted,
            // patch document.body.innerHTML in-place so srcdoc doesn't reload.
            const now = Date.now();
            if (now - lastLivePaintMs >= 200) {
              lastLivePaintMs = now;
              status = `Streaming... page ${ev.position ?? '?'} · ${Math.max(1, Math.round(ev.bytes / 1024))} KB`;
              const parts = splitLiveHtml(ev.html);
              if (!parts) break;
              if (!tryPatchLiveIframeBody(ev.html, ev.position)) {
                captureLiveScroll(ev.position);
                lastLiveHeadHtml = parts.head;
                livePageHtml = ev.html;
                livePagePosition = ev.position;
              }
            }
            break;
          }
          case 'tool_misc': {
            // Non-page tools (search, access_page, …) log to chat, never touch pages.
            answerAccumulator += `\n\n**Tool · ${ev.tool}**\n${ev.summary}`;
            chatMessages[agentMsgIndex].text = answerAccumulator;
            chatMessages = [...chatMessages];
            scrollChatLive();
            break;
          }
          case 'answer': {
            answerAccumulator += ev.text;
            chatMessages[agentMsgIndex].text = answerAccumulator;
            chatMessages = [...chatMessages];
            scrollChatLive();
            break;
          }
          case 'stream_error': {
            // R4: surfaced in banner + chat + status; never swallowed, never silently retried.
            streamErrors = [...streamErrors, { code: ev.code, message: ev.message }];
            status = humanizeStreamError(ev.code);
            answerAccumulator += `\n\n**Generation Error:** ${humanizeStreamError(ev.code)}${ev.code ? ` (code ${ev.code})` : ''}\n\n${ev.message}`;
            chatMessages[agentMsgIndex].text = answerAccumulator;
            chatMessages = [...chatMessages];
            scrollChatLive();
            // W3: a failed continuation (anything except a 1301 content block) is
            // conversation-level — offer the one-click restart-with-context fallback.
            if (isContinuation && ev.code !== '1301') offerRestartWithContext = true;
            break;
          }
          case 'usage': {
            lastTokens = ev.totalTokens;
            cost = Number(((ev.totalTokens / 1_000_000) * 0.70).toFixed(4));
            break;
          }
          case 'finish': {
            if (ev.reason === 'length') truncatedByLength = true;
            break;
          }
          case 'done': {
            // Termination is finalized via flush() at stream close below.
            break;
          }
        }
      }
      drainWireNotices();
    };

    try {
      const response = await fetch("https://api.z.ai/api/v1/agents", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Accept-Language": "en-US,en",
        },
        body: JSON.stringify({
          agent_id: "slides_glm_agent",
          stream: true,
          ...(requestConversationId ? { conversation_id: requestConversationId } : {}),
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: fullPrompt }],
            },
          ],
        }),
        signal: currentController.signal,
      });

      if (!response.ok) {
        throw new HttpError(response.status, response.statusText);
      }

      status = "Streaming generation & live preview...";
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Response has no readable body. Stream unavailable");
      const decoder = new TextDecoder();
      let buffer = "";

      // ── R1: reader loop feeds SSE frames into the parser; parser events drive state. ──
      // flush() lives in finally: on network kill or abort mid-stream, a completed page
      // still buffered in the parser must be delivered before we evaluate the outcome.
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const { lines, rest } = feedSseFrame(buffer);
          buffer = rest;

          for (const line of lines) {
            handleEvents(parser.push(line));
          }
        }

        // A final line without a trailing newline is a complete frame at EOF.
        buffer += decoder.decode();
        if (buffer.trim().length > 0) {
          for (const line of feedSseFrame(`${buffer}\n`).lines) {
            handleEvents(parser.push(line));
          }
        }
      } finally {
        // R1: ALWAYS flush at stream close — the live stream has no [DONE] terminator.
        handleEvents(parser.flush());
      }

      // ── ANSWER-PHASE HTML RESCUE ──
      // The Z.AI agent sometimes returns the full HTML document in the answer
      // text instead of through add_slide tool calls — sometimes as a
      // JSON-string-encoded artifact, wrapped in prose or code fences. The
      // decoder (lib/sse/rescue.ts) handles all three shapes; detection stays
      // structural (DOCTYPE/html/body markers), never content sniffing.
      if (pages.length === 0 && store.unpositioned.length === 0 && answerAccumulator.trim().length > 0) {
        const rescuedDoc = rescueDocumentFromAnswer(answerAccumulator);
        if (rescuedDoc) {
          const rescuedHtml = finalizePageHtml(rescuedDoc);
          store.apply({ kind: 'page', position: 1, html: rescuedHtml, tool: 'answer_rescue', title: null });
          pages = store.pages.map((p) => ({ ...p, html: finalizePageHtml(p.html) }));
          selectedPageIndex = 0;
          status = 'Worksheet rescued from answer text: 1 page generated';
          // Clear the answer accumulator from chat since it was raw HTML, not prose.
          chatMessages[agentMsgIndex].text = '[Worksheet generated. See preview]';
          chatMessages = [...chatMessages];
        }
      }

      // ── UNPOSITIONED PAGE RESCUE ──
      // Pages that arrived without a position from the SSE stream are in
      // store.unpositioned. Assign them sequential positions and promote.
      if (store.unpositioned.length > 0 && pages.length === 0) {
        for (let i = 0; i < store.unpositioned.length; i++) {
          const u = store.unpositioned[i];
          store.apply({ kind: 'page', position: i + 1, html: u.html, tool: u.tool, title: u.title });
        }
        pages = store.pages.map((p) => ({ ...p, html: finalizePageHtml(p.html) }));
        selectedPageIndex = 0;
        status = `${store.unpositioned.length} page(s) rescued from unpositioned delivery`;
      }

      // Spec §8: zero pages + zero errors is a real outcome — never a fabricated slide.
      if (pages.length === 0 && store.unpositioned.length === 0 && streamErrors.length === 0) {
        const emptyMsg = answerAccumulator.trim()
          ? 'Agent returned no pages. Its text reply is shown in the chat.'
          : 'Agent returned no pages and no reply text. Try rephrasing the prompt.';
        streamErrors = [{ code: null, message: emptyMsg }];
        status = 'Agent returned no pages';
        answerAccumulator += `\n\n**Generation Error:** ${emptyMsg}`;
        chatMessages[agentMsgIndex].text = answerAccumulator;
        chatMessages = [...chatMessages];
        // W3: live-verified empty-result shape (bogus conversation id → HTTP 200 with
        // empty message content) — the one silent "conversation unusable" symptom.
        if (isContinuation) offerRestartWithContext = true;
      } else if (streamErrors.length === 0) {
        status = pages.length > 0
          ? `${pages.length} page${pages.length === 1 ? '' : 's'} generated`
          : 'Pages arrived without positions, kept out of deck ordering (see wire notices)';
      } else {
        status = `Finished with errors: ${pages.length} page${pages.length === 1 ? '' : 's'} retained`;
      }

      // R5: vault keeps working; multi-page decks assemble as SINGLE document (one doctype, sequential bodies).
      // A text-only reply to a follow-up (no page events) must not re-save an unchanged deck.
      if (pages.length > 0 && (!isOpenFollowUp || gotPageEvent)) {
        // Open mode keeps pages separable (PAGE_SEPARATOR) so reloading from the vault restores the page stepper.
        const deckHtml = isOpenMode
          ? markOpenDocument(pages.map((p) => p.html).join(PAGE_SEPARATOR))
          : assembleSingleDocument(pages.map((p) => p.html));
        const saved = await saveSlideToStorage(deckHtml, textToSend || fileName || pages[0]?.title || (isOpenMode ? 'Open Slide' : 'Worksheet'));
        await refreshSavedSlides();
        status = streamErrors.length === 0
          ? `Ready! ${pages.length} page${pages.length === 1 ? '' : 's'}, saved as ${saved.title}`
          : `Finished with errors: ${pages.length} page(s) retained, saved as ${saved.title}`;
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        abortedByUser = true;
        // Mid-stream user abort: partial pages stay viewable (spec §8).
        status = `Generation stopped: ${pages.length} page${pages.length === 1 ? '' : 's'} retained`;
        lastStreamInterrupted = pages.length > 0;
        if (chatMessages[agentMsgIndex] && !chatMessages[agentMsgIndex].text && !chatMessages[agentMsgIndex].thinking) {
          chatMessages[agentMsgIndex].text = '[Stopped by user]';
        }
      } else {
        // R4: fetch/network/auth failures — mapped to human text, unmissable, non-blocking.
        const human = describeFailure(err);
        streamErrors = [...streamErrors, { code: null, message: human }];
        status = human;
        const retained = pages.length > 0
          ? `\n\n${pages.length} page${pages.length === 1 ? '' : 's'} received before the failure, still viewable in the stage.`
          : '';
        lastStreamInterrupted = pages.length > 0;
        if (isContinuation) offerRestartWithContext = true;
        if (chatMessages[agentMsgIndex]) {
          chatMessages[agentMsgIndex].text += `\n\n**Generation Error:** ${human}${retained}`;
        } else {
          addMessage(`**Generation Error:** ${human}${retained}`, 'agent');
        }
      }
    } finally {
      isGenerating = false;
      currentController = null;
      // W3: persist the conversation id from every path — success, abort, and error —
      // so continuation and server-side export survive partial/failed streams.
      if (parser.conversationId) persistConversation(parser.conversationId);
      // R3: stream over — stage shows the selected page; point it at the last live page.
      if (pages.length > 0) {
        const idx = livePagePosition !== null ? pages.findIndex((p) => p.position === livePagePosition) : -1;
        // Open mode, fresh deck: land on page 1, not on the last streamed page.
        selectedPageIndex = isOpenMode && !isContinuation ? 0 : idx >= 0 ? idx : Math.min(selectedPageIndex, pages.length - 1);
      }
      livePageHtml = null;
      livePagePosition = null;
    }

    // Auto-continue when a turn stopped at the model's per-turn output boundary (`finish_reason: "length"`).
    if (
      truncatedByLength &&
      !abortedByUser &&
      streamErrors.length === 0 &&
      conversationId !== null &&
      pages.length > prevPageCount &&
      autoDepth < 6
    ) {
      lastStreamInterrupted = true;
      const nextPos = (pages[pages.length - 1]?.position ?? pages.length) + 1;
      status = `Turn hit per-call output boundary at ${pages.length} pages — continuing from page ${nextPos}...`;
      const contPrompt = [
        'Continue the existing document/presentation in this conversation.',
        `Pages already delivered: ${deckContextSummary()}.`,
        `Do not regenerate delivered pages. Continue from position ${nextPos} and finish all remaining pages and exercises.`,
        '继续生成剩余页面',
      ].join('\n');
      await generate({
        fullPrompt: contPrompt,
        userLabel: `Auto-continue from page ${nextPos}`,
        conversationId,
        resetDeck: false,
        autoDepth: autoDepth + 1,
      });
    } else if (truncatedByLength && !abortedByUser) {
      lastStreamInterrupted = pages.length > 0;
    }
  }

  // ── W3: continuation. Live-verified trigger ("继续生成剩余页面") + prior-page
  // context; pages append by position (PageStore overwrites duplicates legally). ──
  function deckContextSummary(): string {
    return pages
      .map((p) => `Page ${p.position}${p.title ? `: "${p.title}"` : ' (untitled)'}`)
      .join(', ');
  }

  async function continueRemainingPages() {
    if (!apiKey) {
      isApiKeyModalOpen = true;
      status = 'Please set your API Key to continue.';
      return;
    }
    const conv = conversationId;
    if (!conv || pages.length === 0 || isGenerating) return;
    const nextPos = (pages[pages.length - 1]?.position ?? 0) + 1;
    const fullPrompt = [
      'Continue the existing presentation in this conversation.',
      `Pages already delivered: ${deckContextSummary()}.`,
      `Do not regenerate delivered pages. Continue from position ${nextPos} and finish the remaining pages.`,
      '继续生成剩余页面',
    ].join('\n');
    await generate({
      fullPrompt,
      userLabel: 'Continue remaining pages',
      conversationId: conv,
      resetDeck: false,
    });
  }

  // ── W3 expiry fallback (reality-patched): the provider silently adopts unknown
  // conversation ids, so "expired" never surfaces as a wire error. On any real
  // continuation failure, this one-click restart seeds a FRESH conversation with a
  // compact summary of the pages already generated (positions + titles, no HTML). ──
  async function restartWithContext() {
    if (!apiKey) {
      isApiKeyModalOpen = true;
      status = 'Please set your API Key to restart.';
      return;
    }
    if (pages.length === 0 || isGenerating) return;
    const userText = [
      'Start a fresh presentation that reproduces this deck, keeping the same topics and order, then finish any remaining pages.',
      `Pages already generated in the previous session: ${deckContextSummary()}.`,
    ].join('\n');
    clearConversation();
    await generate({
      fullPrompt: assemblePrompt({
        typeText: typeSpace,
        formatText: formatSpace,
        userText,
        styleText: styleSpace,
        attachedMarkdown: '',
        attachedFileName: '',
        preferencesText: PREFERENCES_TEXT,
      }),
      userLabel: 'Restart deck with context (fresh session)',
      resetDeck: true,
    });
  }

  // ── W4: real export. LIVE-VERIFIED (2026-08-31): POST /api/v1/agents/conversation/
  // (slash-agnostic) with custom_variables {include_html,include_pdf} returns
  // choices[].messages[].content.type==='file_url' pairs {tag, file_url} (zip + pdf);
  // failure = HTTP 200 with empty message content (no file_url), never an HTTP error. ──
  interface ExportFile {
    name: string;
    url: string;
  }

  function extractExportFiles(data: unknown): ExportFile[] {
    const out: ExportFile[] = [];
    if (typeof data !== 'object' || data === null) return out;
    const choices = (data as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) return out;
    for (const choice of choices) {
      if (typeof choice !== 'object' || choice === null) continue;
      const messages = (choice as { messages?: unknown }).messages;
      if (!Array.isArray(messages)) continue;
      for (const msg of messages) {
        if (typeof msg !== 'object' || msg === null) continue;
        const content = (msg as { content?: unknown }).content;
        const items = Array.isArray(content) ? content : [content];
        for (const item of items) {
          if (typeof item !== 'object' || item === null) continue;
          const it = item as { type?: unknown; file_url?: unknown; tag?: unknown };
          if (it.type === 'file_url' && typeof it.file_url === 'string' && it.file_url.length > 0) {
            out.push({
              name: typeof it.tag === 'string' && it.tag.length > 0 ? it.tag : 'zlides_export',
              url: it.file_url,
            });
          }
        }
      }
    }
    return out;
  }

  // mfile.z.ai serves no CORS headers (live-verified) — a blob fetch is impossible;
  // anchor navigation is the verified download path. Zips download natively.
  function downloadRemoteFile(url: string, name: string) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function buildFullDeckExport(): { html: string; filename: string; pageCount: number } {
    if (appMode === 'lac' && lacHtml) {
      return {
        html: lacHtml,
        filename: cleanExportFilename(lac?.title || lacFileName, lacHtml, 'LAC-Worksheet'),
        pageCount: 1,
      };
    }
    if (appMode === 'vig' && vigHtml) {
      return {
        html: vigHtml,
        filename: cleanExportFilename(vigTitleInput || vigLinkInput, vigHtml, 'Video-Immersion-Guide'),
        pageCount: 1,
      };
    }
    if (pages.length > 0) {
      const assembled = assembleSingleDocument(pages.map((p) => p.html));
      const preferredTitle = pages[0]?.title || attachedFileName.replace(/\.[^.]+$/, '');
      return {
        html: assembled,
        filename: cleanExportFilename(preferredTitle, assembled, appMode === 'open' ? 'Document' : 'Worksheet'),
        pageCount: pages.length,
      };
    }
    const fallbackHtml = selectedPage?.html ?? iframeSrcDoc;
    return {
      html: fallbackHtml,
      filename: cleanExportFilename(null, fallbackHtml, 'Worksheet'),
      pageCount: 1,
    };
  }

  async function exportViaConversation() {
    if (isExporting) return;
    const conv = conversationId;
    if (!conv) {
      const { html, filename, pageCount } = buildFullDeckExport();
      downloadHtmlFile(html, filename);
      status = `Downloaded ${filename} (${pageCount} page${pageCount === 1 ? '' : 's'})`;
      return;
    }
    if (!apiKey) {
      isApiKeyModalOpen = true;
      status = 'Please set your API Key to export.';
      return;
    }
    isExporting = true;
    status = 'Requesting export files from Z.AI...';
    try {
      const resp = await fetch('https://api.z.ai/api/v1/agents/conversation/', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agent_id: 'slides_glm_agent',
          conversation_id: conv,
          custom_variables: { include_html: true },
        }),
      });
      if (!resp.ok) throw new HttpError(resp.status, resp.statusText);
      const files = extractExportFiles(await resp.json());
      if (files.length === 0) throw new Error('Export returned no files for this conversation');
      for (const f of files) downloadRemoteFile(f.url, f.name);
      status = `Export ready: ${files.length} file${files.length === 1 ? '' : 's'} downloaded`;
    } catch (err: unknown) {
      const human = err instanceof HttpError
        ? describeFailure(err)
        : err instanceof Error
          ? err.message
          : String(err);
      const { html, filename, pageCount } = buildFullDeckExport();
      streamErrors = [
        ...streamErrors,
        { code: null, message: `Server export failed: ${human}. Downloaded ${filename} (${pageCount} page${pageCount === 1 ? '' : 's'}) locally instead` },
      ];
      status = `Downloaded ${filename} (${pageCount} page${pageCount === 1 ? '' : 's'})`;
      downloadHtmlFile(html, filename);
    } finally {
      isExporting = false;
    }
  }

  function downloadCurrentHtml() {
    if (appMode === 'lac' && !lacHtml) {
      status = 'No worksheet to download yet';
      return;
    }
    if (appMode === 'vig' && !vigHtml) {
      status = 'No guide to download yet';
      return;
    }
    if ((appMode === 'sheet' || appMode === 'open') && pages.length === 0) {
      status = 'No pages to download yet';
      return;
    }
    const { html, filename, pageCount } = buildFullDeckExport();
    downloadHtmlFile(html, filename);
    status = `Downloaded ${filename} (${pageCount} page${pageCount === 1 ? '' : 's'})`;
  }

  async function regenerateWorksheetSection(sectionId: string) {
    if (!apiKey) {
      isApiKeyModalOpen = true;
      status = 'Please set your API Key to regenerate.';
      return;
    }
    if (pages.length === 0 || isGenerating) return;
    isWorksheetTypeOpen = false;
    isWorksheetSectionExpanded = false;
    const pos = selectedPage?.position ?? selectedPageIndex + 1;
    let sectionInstruction: string;
    if (sectionId === 'full') {
      sectionInstruction = `Regenerate the entire worksheet at page ${pos}: rebuild all .dynamic-slot exercise content with fresh material while preserving the overall section structure, card chrome, and design system.`;
    } else {
      sectionInstruction = `Regenerate only the "${sectionId}" section of page ${pos}: replace that section's .dynamic-slot exercise content with fresh, hyper-specific "${sectionId}" material; leave every other section and every other page exactly as-is.`;
    }
    const fullPrompt = [
      sectionInstruction,
      `Current deck: ${deckContextSummary()}.`,
      `Target: position ${pos}, section "${sectionId}": replace .dynamic-slot content only for that section, preserve all other chrome.`,
    ].join('\n');
    await generate({
      fullPrompt: assemblePrompt({
        typeText: typeSpace,
        formatText: formatSpace,
        userText: fullPrompt,
        styleText: styleSpace,
        attachedMarkdown: '',
        attachedFileName: '',
        preferencesText: PREFERENCES_TEXT,
      }),
      userLabel: sectionId === 'full' ? `Regenerate worksheet (page ${pos})` : `Regenerate ${sectionId} (page ${pos})`,
      conversationId: conversationId,
      resetDeck: false,
    });
  }

  function formatUsd(v: number): string {
    if (v > 0 && v < 0.001) return v.toFixed(5);
    return v.toFixed(3);
  }

  function saveApiKey() {
    apiKey = tempApiKey.trim();
    localStorage.setItem('zlides_api_key', apiKey);
    isApiKeyModalOpen = false;
    status = "API Key saved.";
  }
</script>

<main class="min-h-screen bg-ge-bg text-ge-text flex-col md:flex-row h-screen overflow-hidden flex font-inter text-base">

  <!-- Sidebar: draggable right edge -->
  <div
    class="w-full p-5 flex-col gap-4 bg-ge-card border-r border-ge-border shadow-xl z-10 flex-shrink-0 hidden md:flex relative overflow-hidden ge-depth-card"
    style="width: {sidebarWidth}px; max-width: 80vw;"
  >
    <!-- Logo + the three slots in order: Layout → Format → Style -->
    <div class="flex items-start gap-3 flex-shrink-0">
      <LogoHeroHeader class="w-auto shrink-0 border-b-0 py-0 pb-0 justify-start" />
      <div class="flex-1 min-w-0 flex flex-wrap items-start gap-1.5 pt-1">
        <MorphDropdown
          value={previewMode}
          label={`Layout: ${previewMode === 'document' ? 'A4' : previewMode === 'slides' ? '16:9' : 'Web'}`}
          width={200}
          buttonClass="px-2 py-1"
          onselect={(opt) => applyLayoutType(opt.id as 'document' | 'slides' | 'webpage')}
          options={[
            { id: 'document', label: 'A4 Document', accentColor: '#f0b23e' },
            { id: 'slides', label: '16:9 Slides', accentColor: '#4fb3a9' },
            { id: 'webpage', label: 'Fluid Webpage', accentColor: '#ffffff' }
          ]}
        />
        <MorphDropdown
          value={formatChoice}
          label={`Format: ${formatChoice === 'none' ? 'None' : formatChoice === 'worksheet' ? worksheetFormatJson.name : 'Custom'}`}
          width={210}
          buttonClass="px-2 py-1"
          onselect={() => { formatSpace = DEFAULT_FORMAT_PROMPT; }}
          options={[
            { id: 'worksheet', label: worksheetFormatJson.name, accentColor: '#f0b23e' },
            { id: 'none', label: 'None', accentColor: '#9ca3af', onclick: () => { formatSpace = ''; } }
          ]}
        />
        <MorphDropdown
          value={styleChoice}
          label={`Style: ${styleChoice === 'auto' ? 'Auto' : styleChoice === 'gitenglish' ? 'gitEnglish' : styleChoice === 'design-md' ? 'DESIGN.md' : 'Custom'}`}
          width={210}
          buttonClass="px-2 py-1"
          onselect={(opt) => setStyleChoice(opt.id)}
          options={[
            { id: 'gitenglish', label: 'gitEnglish', accentColor: '#ff6b35' },
            { id: 'design-md', label: 'DESIGN.md', accentColor: '#4fb3a9' },
            { id: 'auto', label: 'Auto (None)', accentColor: '#9ca3af' },
            { id: 'custom', label: 'Custom', accentColor: '#ffffff' }
          ]}
        />
      </div>
    </div>

    <!-- Engine tabs (owner's original strip) + Skills -->
    <div class="flex items-center gap-2 flex-shrink-0">
      <div class="grid grid-cols-2 gap-1 p-1 bg-ge-bg border border-ge-border rounded-xl" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={appMode === 'sheet'}
          onclick={() => { appMode = 'sheet'; }}
          title="Worksheet Engine"
          class="py-1.5 px-1 rounded-lg text-sm font-semibold transition-colors cursor-pointer truncate {appMode === 'sheet' ? 'bg-ge-card text-white border border-ge-border-strong' : 'text-neutral-300 hover:text-white'}"
        >Worksheet</button>
        <button
          type="button"
          role="tab"
          aria-selected={appMode === 'vig'}
          onclick={() => { appMode = 'vig'; }}
          title="Video Immersion Guide"
          class="py-1.5 px-1 rounded-lg text-sm font-semibold transition-colors cursor-pointer truncate {appMode === 'vig' ? 'bg-ge-card text-white border border-ge-border-strong' : 'text-neutral-300 hover:text-white'}"
        >Video Guide</button>
      </div>
      <button
        type="button"
        class="ml-auto w-8 h-8 shrink-0 flex items-center justify-center bg-ge-bg border {activeSkills.length > 0 ? 'border-ge-accent/70' : 'border-ge-border'} rounded-lg text-white hover:border-ge-accent/50 transition-colors cursor-pointer"
        onclick={() => openSkillsModal(appMode === 'lac' ? 'lac' : appMode === 'vig' ? 'vig' : 'library')}
        title="Skills ({activeSkills.length} active of {savedSkills.length})"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-ge-accent"><path d="M13 2 4.5 13H11l-1 9 8.5-11H12l1-9z"/></svg>
      </button>
    </div>

    <div id="chat-history" class="flex-1 min-h-[140px] min-w-0 overflow-y-auto flex flex-col gap-4 p-4 bg-ge-bg rounded-xl border border-ge-border text-base leading-relaxed">
      {#each chatMessages as msg}
        {#if msg.role === 'user'}
          <div class="p-4 rounded-xl max-w-[90%] whitespace-pre-wrap bg-[#202326] text-white ml-auto border border-[#34383d] text-base leading-relaxed shadow-md font-normal">{msg.text}</div>
        {:else if msg.thinking || msg.text}
          <div class="max-w-[98%] mr-auto space-y-3 w-full">
            {#if msg.thinking}
              <div class="p-4 rounded-xl bg-[#16181b] border border-[#2e3236] shadow-sm w-full min-w-0 overflow-hidden">
                <Reasoning
                  isStreaming={true}
                  defaultOpen={true}
                >
                  <ReasoningTrigger class="text-base font-semibold text-ge-accent hover:text-white" />
                  <ReasoningContent content={msg.thinking} class="text-lg leading-relaxed text-white font-normal w-full min-w-0 break-words whitespace-pre-wrap" />
                </Reasoning>
              </div>
            {/if}
            {#if msg.text}
              <div class="pl-4 border-l-2 border-ge-accent py-1">
                <div class="text-sm font-bold text-ge-accent mb-1.5 flex items-center gap-1.5">
                  <span class="inline-block h-2 w-2 rounded-full bg-ge-accent"></span>
                  Worksheet Engine
                </div>
                <Response content={msg.text} class="prose-invert text-base text-white max-w-none leading-relaxed font-normal [&_ul]:pl-5 [&_ol]:pl-5" />
              </div>
            {/if}
          </div>
        {/if}
      {/each}
    </div>

    <!-- Composer -->
    <div class="flex flex-col gap-3 flex-shrink-0">
      {#if appMode === 'vig'}
      <div class="flex flex-col gap-3 bg-ge-bg rounded-xl p-3 border border-ge-border">
        <label class="flex flex-col gap-1.5">
          <span class="text-sm font-semibold text-neutral-200">YouTube link or video id</span>
          <input
            type="text"
            bind:value={vigLinkInput}
            onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); generateVig(); } }}
            placeholder="https://www.youtube.com/watch?v=..."
            class="w-full bg-ge-card border border-ge-border rounded-lg px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:border-ge-accent outline-none"
          />
        </label>
        <label class="flex flex-col gap-1.5">
          <span class="text-sm font-semibold text-neutral-200">Guide title <span class="text-neutral-400 font-normal">(optional)</span></span>
          <input
            type="text"
            bind:value={vigTitleInput}
            placeholder="Guide heading and saved filename"
            class="w-full bg-ge-card border border-ge-border rounded-lg px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:border-ge-accent outline-none"
          />
        </label>
        <p class="text-sm text-neutral-300 leading-relaxed">
          The transcript comes straight from YouTube so the subtitles and the word timings stay in sync with the video, then the guide is compiled from the vendored template.
        </p>
        <div class="text-sm font-mono text-neutral-400">
          {#if vigContract}
            Contract: SKILL.md · {vigContract.chars.toLocaleString()} chars · {vigContract.sha256.slice(0, 12)}
          {:else if vigContractError}
            <span class="text-ge-danger">Contract unavailable: {vigContractError}</span>
          {:else}
            Loading contract from the skill...
          {/if}
        </div>
        <button
          type="button"
          onclick={() => generateVig()}
          disabled={isGenerating || !vigLinkInput.trim()}
          class="px-4 py-1.5 text-sm rounded-lg bg-ge-accent text-black font-extrabold hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
        >{isGenerating ? 'Generating…' : 'Generate Guide'}</button>
      </div>
      {:else if appMode === 'lac'}
      <div class="flex flex-col gap-3 bg-ge-bg rounded-xl p-3 border border-ge-border max-h-[46vh] overflow-y-auto">
        <label class="cursor-pointer text-sm font-semibold flex items-center justify-center gap-2 bg-ge-card hover:bg-ge-card-elevated px-3 py-2 rounded-lg border border-ge-border text-white transition-colors">
          {lacFileName ? 'Replace LAC JSON' : 'Attach LAC JSON'}
          <input type="file" class="hidden" accept=".json,application/json" onchange={handleLacFile} />
        </label>
        <div class="text-sm text-neutral-300 font-mono truncate" title={lacFileName || 'no file'}>
          {lacFileName || 'No LAC attached'}
        </div>
        {#if lac}
          <div class="text-sm text-neutral-200">
            {lac.title || 'Untitled lesson'} · {lac.sessionDate || 'no date'}
          </div>
          <div class="text-sm text-neutral-400">
            {lacPlan.length} placements · seed {lacSeed} · {lacInventory(lac).map((i) => `${i.count} ${i.kind}`).join(' · ')}
          </div>
        {:else if lacError}
          <div class="text-sm text-ge-danger">{lacError}</div>
        {/if}
        {#if lacBuild}
          <div class="flex flex-col gap-1.5">
            <span class="text-sm font-semibold text-neutral-200">Modules — re-roll any one</span>
            {#each lacBuild.modules as m, i}
              <div class="flex items-center justify-between gap-2 text-sm">
                <span class="text-neutral-300 truncate">{m.id ?? i + 1} · {m.widget}</span>
                <button
                  type="button"
                  onclick={() => regenerateModule(i)}
                  disabled={isGenerating}
                  class="shrink-0 px-2 py-1 rounded-md border border-ge-border bg-ge-card hover:border-ge-accent text-white disabled:opacity-40"
                  title="Generate a new version of this exercise"
                >{regenerating === i ? '…' : '↻ New'}</button>
              </div>
            {/each}
          </div>
        {/if}
        <textarea
          bind:value={lacDirection}
          rows="3"
          placeholder="Say what to change — 'make chapter two about water levels', 'harder register', or paste anything."
          class="w-full bg-ge-card border border-ge-border rounded-lg px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:border-ge-accent outline-none resize-y"
        ></textarea>
        <div class="flex items-center justify-between gap-2 text-sm font-mono text-neutral-300">
          {#if lacContract}
            <span>Skill: {lacContract.chars.toLocaleString()} chars · {lacContract.sha256.slice(0, 12)}{hasLacOverride ? ' (edited)' : ''}</span>
          {:else if lacContractError}
            <span class="text-ge-danger">Skill unavailable: {lacContractError}</span>
          {:else}
            <span>Loading the LAC skill...</span>
          {/if}
          <button
            type="button"
            onclick={() => openSkillsModal('lac')}
            class="shrink-0 px-2.5 py-1 rounded-md border border-ge-border bg-ge-card hover:border-ge-accent text-white font-sans text-sm font-medium cursor-pointer"
          >View / Edit Skill</button>
        </div>
        <button
          type="button"
          onclick={() => generateLac()}
          disabled={isGenerating || !lac}
          class="px-4 py-1.5 text-sm rounded-lg bg-ge-accent text-black font-extrabold hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
        >{isGenerating ? 'Generating…' : 'Generate from LAC'}</button>
      </div>
      {:else}
      <div class="flex flex-col bg-ge-bg rounded-xl p-3 border border-ge-border">
        <textarea
          bind:value={promptText}
          onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generate(); } }}
          placeholder={appMode === 'open' ? 'Write any one-shot prompt directly for the slide agent — no worksheet contracts injected.' : 'Paste anything — notes, a transcript, a LAC, an article — then Generate.'}
          rows="3"
          class="w-full bg-transparent border-none outline-none resize-y p-1 text-white placeholder:text-neutral-500 text-base min-h-[84px] font-inter leading-relaxed"
        ></textarea>
        <div class="flex items-center justify-between gap-2 pt-2.5 border-t border-ge-border-soft">
          <label class="cursor-pointer w-8 h-8 shrink-0 flex items-center justify-center bg-ge-card hover:bg-ge-card-elevated rounded-lg border border-ge-border text-white transition-colors" title="Attach file">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
            <input type="file" class="hidden" onchange={handleFileSelect} accept=".txt,.md,.json,.html,.csv" disabled={isUploading} />
          </label>
          <div class="flex items-center gap-2 min-w-0">
            {#if attachedFileName}
              <span class="text-sm text-ge-accent truncate max-w-[150px]" title={attachedFileName}>{attachedFileName}</span>
            {/if}
            {#if isGenerating}
              <button
                type="button"
                onclick={stopRequest}
                class="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg bg-ge-danger text-white hover:bg-ge-danger/90 cursor-pointer"
                title="Stop"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
              </button>
            {:else}
              <button
                type="button"
                onclick={() => generate()}
                disabled={!promptText.trim() && !extractedMarkdown}
                class="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg bg-ge-accent text-black hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
                title={appMode === 'open' ? 'Send to Agent' : 'Generate'}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
              </button>
            {/if}
          </div>
        </div>
      </div>
      {/if}

      {#if (appMode === 'sheet' || appMode === 'open') && offerRestartWithContext}
        <button
          type="button"
          onclick={() => restartWithContext()}
          disabled={isGenerating}
          title="Start a fresh conversation seeded with a summary of the pages already generated"
          class="w-full py-2 px-3 text-sm rounded-lg border border-ge-accent/60 bg-ge-accent/10 text-white font-semibold hover:bg-ge-accent/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          Conversation lost — restart deck with context
        </button>
      {:else if (appMode === 'sheet' || appMode === 'open') && canContinue}
        <button
          type="button"
          onclick={() => continueRemainingPages()}
          disabled={isGenerating}
          title="Send the continuation trigger to the same server conversation and append the remaining pages"
          class="w-full py-2 px-3 text-sm rounded-lg border border-ge-accent/60 bg-ge-bg text-white font-semibold hover:border-ge-accent hover:bg-ge-card transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          Continue remaining pages{pageGapCount > 0 ? ` · ${pageGapCount} missing` : ''}
        </button>
      {/if}
    </div>

    <!-- Cost: out of the way, bottom of the sidebar -->
    <div class="flex-shrink-0 text-[13px] font-mono text-neutral-500 text-right" title="Estimated cost">
      ${formatUsd(cost)}{lastTokens !== null ? ` · ${lastTokens.toLocaleString()}t` : ''}
    </div>

    <!-- Resize handle -->
    <div
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      tabindex="-1"
      class="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-ge-accent/40 active:bg-ge-accent/60 z-20"
      onpointerdown={startResize}
      onpointermove={doResize}
      onpointerup={endResize}
      onpointercancel={endResize}
      ondblclick={() => { sidebarWidth = 420; localStorage.setItem('zlides_sidebar_w', '420'); }}
    ></div>
  </div>

  <!-- Preview stage: responsive layout with zero outer scrollbars -->
  <div class="flex-grow bg-ge-bg relative flex flex-col min-w-0 overflow-hidden">
    <!-- Preview Top Bar: View mode, Stage fit, Centered Page Stepper, and Actions -->
    <div class="flex-shrink-0 h-12 border-b border-ge-border bg-ge-card flex items-center justify-between px-3 gap-2 relative z-20 overflow-visible">
      <!-- Center: Live Streaming Indicator -->
      <div class="flex-1 flex items-center justify-center gap-2">
        {#if status !== 'Ready' && !isGenerating}
          <span class="text-sm text-neutral-300 truncate max-w-[300px]" title={status}>{status}</span>
        {/if}
        {#if appMode === 'sheet' || appMode === 'open'}
        {#if isGenerating}
          <div class="flex items-center gap-2 px-3 py-1 rounded-lg border border-ge-accent/40 bg-ge-accent/10 whitespace-nowrap">
            <span class="h-2 w-2 rounded-full bg-ge-accent animate-ping"></span>
            <span class="text-sm font-semibold text-ge-accent whitespace-nowrap">{livePageHtml !== null ? 'Streaming page…' : 'Agent is planning…'}</span>
          </div>
        {/if}
        {/if}
      </div>

      <!-- Right: Consolidated Actions (Export Dropdown, Vault, API Key) -->
      <div class="flex items-center gap-2.5 shrink-0">
        {#if appMode === 'open' && !isGenerating && (conversationId !== null || pages.length > 0)}
          <button
            type="button"
            onclick={() => { clearConversation(); pages = []; selectedPageIndex = 0; status = 'New chat: context cleared'; }}
            class="text-sm px-3 py-1.5 bg-ge-bg border border-ge-border text-white font-medium hover:border-ge-accent/50 rounded-lg cursor-pointer"
            title="Clear the conversation and the deck so the next send starts fresh"
          >New chat</button>
        {/if}
        <!-- Export & Document Actions Morph Dropdown -->
        <MorphDropdown
          label="Export"
          align="right"
          width={240}
          options={[
            {
              id: 'html',
              label: 'Download Full HTML',
              sublabel: 'All pages as one standalone HTML',
              accentColor: '#4fb3a9',
              onclick: () => downloadCurrentHtml()
            },
            {
              id: 'bundle',
              label: isExporting ? 'Exporting Bundle...' : 'Export HTML Bundle',
              sublabel: 'Compile archive via Z.AI API',
              accentColor: '#f0b23e',
              onclick: () => exportViaConversation()
            },
            {
              id: 'edit',
              label: isEditingHtml ? 'Close Editor' : 'Edit Raw HTML',
              sublabel: 'Live code editor drawer',
              accentColor: '#ffffff',
              onclick: () => toggleEditor()
            }
          ]}
        />

        <button
          type="button"
          class="text-sm px-3 py-1.5 bg-ge-bg border border-ge-border hover:border-ge-accent/50 rounded-lg text-white font-medium hover:text-ge-accent transition-colors flex items-center gap-1.5 cursor-pointer shadow-sm active:scale-95"
          onclick={() => { isSavedModalOpen = true; refreshSavedSlides(); }}
          title="Browse saved worksheets and past classes"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-ge-accent shrink-0"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
          <span>Vault <span class="font-mono text-neutral-400">({savedSlides.length})</span></span>
        </button>

        <div class="h-4 w-[1px] bg-ge-border mx-0.5"></div>

        <button
          type="button"
          class="text-sm px-2.5 py-1.5 bg-ge-bg border border-ge-border hover:border-ge-accent/50 rounded-lg text-neutral-300 font-medium hover:text-white transition-colors flex items-center gap-1.5 cursor-pointer shadow-sm active:scale-95"
          onclick={() => { tempApiKey = apiKey; isApiKeyModalOpen = true; }}
          title="Configure Z.AI API Key"
        >
          <span class="h-2 w-2 rounded-full {apiKey ? 'bg-ge-success' : 'bg-ge-danger'}"></span>
          <span>API Key</span>
        </button>
      </div>
    </div>

    <!-- R4: unmissable, non-blocking error surface (≥14px, white-on-dark, red accent) -->
    {#if streamErrors.length > 0}
      <div class="absolute top-14 left-4 right-4 z-30 flex flex-col gap-2 items-center pointer-events-none" role="alert" aria-live="assertive">
        {#each streamErrors as err, i (i)}
          <div class="pointer-events-auto w-full max-w-2xl flex items-start gap-3 rounded-xl border border-red-500/70 bg-[#2b0b0b]/95 px-4 py-3 shadow-2xl backdrop-blur">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-red-400 shrink-0 mt-0.5"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
            <div class="min-w-0 flex-1">
              <p class="text-base font-bold text-white leading-snug">{humanizeStreamError(err.code)}</p>
              <p class="text-sm text-neutral-200 mt-0.5 break-words leading-relaxed">{err.message}{err.code ? ` (code ${err.code})` : ''}</p>
            </div>
            <button
              onclick={() => { streamErrors = []; }}
              class="shrink-0 text-sm px-2 py-1 rounded-lg text-neutral-200 hover:text-white hover:bg-red-500/20 transition-colors"
              aria-label="Dismiss error banner"
            >✕</button>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Responsive Stage Canvas -->
    <div
      class="flex-1 min-h-0 p-3 sm:p-4 flex items-center justify-center overflow-hidden relative select-none"
      bind:clientWidth={stageBoxW}
      bind:clientHeight={stageBoxH}
    >
      <div
        class="stage-morph bg-[#131313] rounded-xl border border-ge-border overflow-hidden relative shadow-2xl flex items-center justify-center"
        style={
          appMode === 'vig' || appMode === 'lac'
            ? 'width: 100%; height: 100%;'
            : pages.length === 0 && !isGenerating && !livePageHtml
            ? 'width: 100%; height: 100%;'
            : previewMode === 'slides'
            ? (stageFitMode === '100%'
                ? `width: ${SLIDE_LOGICAL_W}px; height: ${SLIDE_LOGICAL_H}px; max-width: 100%; max-height: 100%;`
                : `width: ${SLIDE_LOGICAL_W * slideScale}px; height: ${SLIDE_LOGICAL_H * slideScale}px;`)
            : previewMode === 'document'
              ? (stageFitMode === 'fill'
                  ? 'width: 100%; height: 100%;'
                  : stageFitMode === 'fit-page'
                    ? `width: ${DOC_LOGICAL_W * a4FitScale}px; height: ${DOC_LOGICAL_H * a4FitScale}px;`
                    : `width: ${DOC_LOGICAL_W}px; height: 100%; max-width: 100%;`)
              : (stageFitMode === 'fill'
                  ? 'width: 100%; height: 100%;'
                  : stageFitMode === 'fit-page'
                    ? 'width: min(100%, 1200px); height: 100%;'
                    : 'width: min(100%, 960px); height: 100%;')
        }
      >
        {#if (appMode === 'sheet' || appMode === 'open') && pages.length > 0}
          <button
            type="button"
            class="absolute left-1.5 top-1/2 -translate-y-1/2 z-20 w-7 h-7 flex items-center justify-center rounded-full bg-[#16181a]/85 border border-ge-border text-white hover:text-ge-accent hover:border-ge-accent/60 transition-colors cursor-pointer disabled:opacity-25 disabled:hover:text-white disabled:hover:border-ge-border"
            disabled={selectedPageIndex <= 0}
            onclick={prevPage}
            title="Previous page"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
          </button>
          <button
            type="button"
            class="absolute right-1.5 top-1/2 -translate-y-1/2 z-20 w-7 h-7 flex items-center justify-center rounded-full bg-[#16181a]/85 border border-ge-border text-white hover:text-ge-accent hover:border-ge-accent/60 transition-colors cursor-pointer disabled:opacity-25 disabled:hover:text-white disabled:hover:border-ge-border"
            disabled={selectedPageIndex >= pages.length - 1}
            onclick={nextPage}
            title="Next page"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
          </button>
        {/if}
        {#if (appMode === 'sheet' || appMode === 'open') && pages.length === 0 && !isGenerating && !livePageHtml}
          <LogoHeroSplash />
        {:else}
          <iframe
            bind:this={previewIframeEl}
            onload={handleIframeLoad}
            title="Worksheet Preview"
            srcdoc={iframeSrcDoc}
            class={previewMode === 'document' && !(isGenerating && pages.length === 0 && livePageHtml === null) ? 'bg-white' : 'bg-[#131313]'}
            style={
              appMode === 'vig' || appMode === 'lac'
                ? 'width: 100%; height: 100%; border: 0; display: block;'
                : previewMode === 'slides'
                ? (stageFitMode === '100%'
                    ? 'width: 100%; height: 100%; border: 0; display: block;'
                    : `width: ${SLIDE_LOGICAL_W}px; height: ${SLIDE_LOGICAL_H}px; transform: scale(${slideScale}); transform-origin: top left; border: 0; display: block;`)
                : previewMode === 'document'
                  ? (stageFitMode === 'fill'
                      ? 'width: 100%; height: 100%; border: 0; display: block;'
                      : stageFitMode === 'fit-page'
                        ? `width: ${DOC_LOGICAL_W}px; height: ${DOC_LOGICAL_H}px; transform: scale(${a4FitScale}); transform-origin: top left; border: 0; display: block;`
                        : 'width: 100%; height: 100%; border: 0; display: block;')
                  : 'width: 100%; height: 100%; border: 0; display: block;'
            }
            allow="autoplay; encrypted-media; fullscreen"
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          ></iframe>
        {/if}

        {#if isEditingHtml}
        <div class="absolute inset-0 bg-ge-bg z-10 flex flex-col">
          <div class="p-3 bg-ge-card text-sm border-b border-ge-border flex justify-between items-center">
            <span class="font-medium text-ge-text">Edit HTML Document</span>
            <button
              class="px-3.5 py-1.5 bg-ge-accent rounded-lg text-black font-bold transition-all text-sm hover:brightness-110"
              onclick={applyEditorHtml}
            >
              Apply & Close
            </button>
          </div>
          <textarea
            bind:value={editorHtml}
            class="w-full flex-1 min-h-0 p-4 bg-[#121415] text-[#d4d4d4] font-mono text-sm resize-none focus:outline-none leading-relaxed"
            placeholder="Paste or edit HTML here..."
          ></textarea>
        </div>
        {/if}
      </div>
    </div>
  </div>

  <!-- API Key Modal -->
  {#if isApiKeyModalOpen}
  <div
    transition:fade={{ duration: 200 }}
    class="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4"
    onclick={(e) => { if (e.target === e.currentTarget) isApiKeyModalOpen = false; }}
    onkeydown={(e) => { if (e.key === 'Escape') isApiKeyModalOpen = false; }}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
  >
    <div
      transition:scale={{ start: 0.95, duration: 250 }}
      class="bg-ge-card border border-ge-border rounded-xl shadow-2xl w-full max-w-md p-5 flex flex-col gap-4 ring-1 ring-white/10"
    >
      <div class="flex justify-between items-center border-b border-ge-border pb-3">
        <h2 class="text-lg font-bold text-white font-raleway flex items-center gap-2">
          <span class="h-2.5 w-2.5 rounded-full {apiKey ? 'bg-ge-success' : 'bg-ge-danger'}"></span>
          Z.AI API Key Configuration
        </h2>
        <button onclick={() => isApiKeyModalOpen = false} class="text-neutral-400 hover:text-white">✕</button>
      </div>
      <p class="text-xs text-neutral-400">
        Enter your Z.AI API Key. The key is stored locally in your browser and used to stream SSE returns directly from <code class="text-ge-accent font-mono">https://api.z.ai/api/v1/agents</code>.
      </p>
      <input
        type="password"
        bind:value={tempApiKey}
        placeholder="Enter your Z_AI_API_KEY..."
        class="w-full bg-ge-bg border border-ge-border rounded-lg px-3 py-2 text-sm text-white focus:border-ge-accent outline-none font-mono"
      />
      <div class="flex justify-end gap-2 pt-2">
        <button
          class="px-3 py-1.5 rounded-lg bg-ge-bg border border-ge-border text-neutral-300 text-xs hover:text-white"
          onclick={() => isApiKeyModalOpen = false}
        >
          Cancel
        </button>
        <button
          class="px-4 py-1.5 rounded-lg bg-ge-accent text-black font-bold text-xs hover:brightness-110"
          onclick={saveApiKey}
        >
          Save Key
        </button>
      </div>
    </div>
  </div>
  {/if}

  <!-- Saved Slides / Past Classes Modal -->
  {#if isSavedModalOpen}
  <div
    transition:fade={{ duration: 220 }}
    class="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4"
    onclick={(e) => { if (e.target === e.currentTarget) isSavedModalOpen = false; }}
    onkeydown={(e) => { if (e.key === 'Escape') isSavedModalOpen = false; }}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
  >
    <div
      transition:scale={{ start: 0.95, duration: 260 }}
      class="bg-ge-card border border-ge-border rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden ring-1 ring-white/10"
    >
      <div class="p-4 border-b border-ge-border flex justify-between items-center bg-ge-bg">
        <div class="flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-ge-accent"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
          <h2 class="text-lg font-bold font-raleway text-white">Past Classes & Saved Worksheets</h2>
          <span class="text-xs px-2 py-0.5 rounded-full bg-ge-border text-neutral-400 font-mono">{filteredSavedSlides.length} items</span>
        </div>
        <button
          class="text-neutral-400 hover:text-white p-1.5 rounded-lg hover:bg-ge-border transition-colors"
          onclick={() => isSavedModalOpen = false}
        >
          ✕
        </button>
      </div>

      <div class="p-4 border-b border-ge-border bg-ge-card flex gap-3 items-center">
        <div class="relative flex-grow">
          <input
            type="text"
            bind:value={savedSearchQuery}
            placeholder="Search classes, lessons, topics, or dates..."
            class="w-full bg-ge-bg border border-ge-border rounded-lg px-3 py-2 pl-9 text-sm text-white placeholder:text-neutral-500 focus:border-ge-accent outline-none"
          />
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="absolute left-3 top-3 text-neutral-500"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </div>
        <button
          class="px-3 py-2 text-xs bg-ge-bg border border-ge-border rounded-lg hover:bg-ge-border text-white transition-colors flex items-center gap-1.5"
          onclick={refreshSavedSlides}
          disabled={isLoadingSaved}
        >
          <span class:animate-spin={isLoadingSaved}>↻</span>
          Refresh
        </button>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto p-4 space-y-2">
        {#if isLoadingSaved && savedSlides.length === 0}
          <div class="text-center py-12 text-neutral-400 text-sm flex flex-col items-center gap-2">
            <span class="animate-spin h-5 w-5 border-2 border-ge-accent border-t-transparent rounded-full"></span>
            Loading saved classes...
          </div>
        {:else if filteredSavedSlides.length === 0}
          <div class="text-center py-12 text-neutral-400 text-sm">
            {savedSearchQuery ? `No saved worksheets matching "${savedSearchQuery}"` : 'No saved worksheets in storage yet.'}
          </div>
        {:else}
          <div class="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {#each filteredSavedSlides as slide}
              <div
                class="text-left p-3.5 rounded-lg border border-ge-border bg-ge-bg hover:border-ge-accent hover:bg-ge-card transition-all group flex flex-col justify-between cursor-pointer"
                role="button"
                tabindex="0"
                onclick={() => selectSavedSlide(slide)}
                onkeydown={(e) => {
                  // Guard: only direct keys on the card — nested download button events must not re-trigger load.
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectSavedSlide(slide); }
                }}
              >
                <div>
                  <div class="font-medium text-sm text-white group-hover:text-ge-accent line-clamp-2 transition-colors">
                    {slide.title}
                  </div>
                  <div class="text-xs text-neutral-400 truncate mt-1 font-mono">
                    {slide.filename}
                  </div>
                </div>
                <div class="flex items-center justify-between mt-3 text-xs text-neutral-400 border-t border-ge-border/50 pt-2">
                  <span>{slide.dateStr}</span>
                  <div class="flex items-center gap-2">
                    <button
                      onclick={(e) => handleDownloadSaved(e, slide)}
                      class="hover:text-ge-accent text-neutral-400 p-1"
                      title="Download HTML"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                    </button>
                    <span class="text-ge-accent font-medium group-hover:underline ml-1">Load →</span>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="p-3 bg-ge-bg border-t border-ge-border flex justify-between items-center text-xs text-neutral-400">
        <span>Click any past class to load it directly into the preview stage.</span>
        <button
          class="px-4 py-1.5 bg-ge-card border border-ge-border rounded hover:bg-ge-border text-white transition-colors"
          onclick={() => isSavedModalOpen = false}
        >
          Close
        </button>
      </div>
    </div>
  </div>
  {/if}

  {#if isSkillsModalOpen}
  <div
    class="fixed inset-0 bg-black/75 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
    onclick={(e) => { if (e.target === e.currentTarget) isSkillsModalOpen = false; }}
  >
    <div class="bg-ge-card border border-ge-border rounded-xl shadow-2xl w-full max-w-5xl max-h-[88vh] flex flex-col overflow-hidden text-white">
      <div class="p-4 border-b border-ge-border flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 flex-wrap">
          <h3 class="text-base font-bold text-white mr-2">Skills &amp; Attached Contracts</h3>
          <button
            type="button"
            onclick={() => { skillsModalTab = 'library'; }}
            class="px-3 py-1.5 rounded-lg text-sm font-semibold border cursor-pointer {skillsModalTab === 'library' ? 'bg-ge-accent text-black border-ge-accent' : 'bg-ge-bg border-ge-border text-white hover:border-ge-accent/50'}"
          >Saved Skills ({savedSkills.length})</button>
          <button
            type="button"
            onclick={() => { skillsModalTab = 'lac'; if (!lacSkillDraft && lacContract) lacSkillDraft = lacContract.text; }}
            class="px-3 py-1.5 rounded-lg text-sm font-semibold border cursor-pointer {skillsModalTab === 'lac' ? 'bg-ge-accent text-black border-ge-accent' : 'bg-ge-bg border-ge-border text-white hover:border-ge-accent/50'}"
          >Attached LAC Skill{hasLacOverride ? ' *' : ''}</button>
          <button
            type="button"
            onclick={() => { skillsModalTab = 'vig'; if (!vigSkillDraft && vigContract) vigSkillDraft = vigContract.text; }}
            class="px-3 py-1.5 rounded-lg text-sm font-semibold border cursor-pointer {skillsModalTab === 'vig' ? 'bg-ge-accent text-black border-ge-accent' : 'bg-ge-bg border-ge-border text-white hover:border-ge-accent/50'}"
          >Attached VIG Skill{hasVigOverride ? ' *' : ''}</button>
        </div>
        <button
          type="button"
          class="text-neutral-300 hover:text-white p-1.5 rounded-lg hover:bg-ge-border/50 transition-colors cursor-pointer"
          onclick={() => { isSkillsModalOpen = false; }}
          aria-label="Close skills modal"
        >✕</button>
      </div>

      {#if skillsModalTab === 'library'}
        <div class="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-3 overflow-hidden">
          <div class="border-b md:border-b-0 md:border-r border-ge-border p-3 flex flex-col gap-2 overflow-y-auto bg-ge-bg/50">
            <div class="flex items-center gap-2">
              <button
                type="button"
                onclick={() => createNewSkill('New Skill', '')}
                class="flex-1 px-3 py-2 rounded-lg bg-ge-accent text-black font-bold text-sm hover:brightness-110 cursor-pointer"
              >+ New Skill</button>
              <label class="px-3 py-2 rounded-lg bg-ge-card border border-ge-border hover:border-ge-accent/50 text-sm font-medium text-white cursor-pointer">
                Import
                <input type="file" accept=".md,.txt,.json" class="hidden" onchange={handleSkillFileImport} />
              </label>
            </div>
            {#if savedSkills.length === 0}
              <p class="text-sm text-neutral-300 p-2 leading-relaxed">
                No saved skills yet. Click <strong>+ New Skill</strong>, import a <code>.md</code> file, or save a copy from the Attached LAC/VIG tabs.
              </p>
            {:else}
              {#each savedSkills as sk (sk.id)}
                <div
                  class="p-2.5 rounded-lg border transition-colors flex flex-col gap-2 {selectedSkillId === sk.id ? 'bg-ge-card border-ge-accent/70' : 'bg-ge-bg border-ge-border hover:border-ge-border-strong'}"
                >
                  <div class="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onclick={() => selectSkillForEdit(sk.id)}
                      class="text-left text-sm font-semibold text-white truncate flex-1 cursor-pointer"
                    >{sk.name}</button>
                    <button
                      type="button"
                      onclick={() => toggleSkillActive(sk.id)}
                      class="px-2 py-0.5 rounded text-sm font-semibold border cursor-pointer {sk.active ? 'bg-ge-accent text-black border-ge-accent' : 'bg-ge-card border-ge-border text-neutral-300'}"
                    >{sk.active ? 'Active' : 'Off'}</button>
                  </div>
                  <div class="flex items-center justify-between text-sm text-neutral-400 font-mono">
                    <span>{sk.content.length.toLocaleString()} chars</span>
                    <button
                      type="button"
                      onclick={() => deleteSkillEntry(sk.id)}
                      class="text-ge-danger hover:underline font-sans text-sm cursor-pointer"
                    >Delete</button>
                  </div>
                </div>
              {/each}
            {/if}
          </div>

          <div class="md:col-span-2 p-4 flex flex-col gap-3 min-h-0 overflow-hidden">
            {#if selectedSkillId}
              <div class="flex items-center gap-2">
                <input
                  type="text"
                  bind:value={skillDraftName}
                  placeholder="Skill name..."
                  class="flex-1 bg-ge-bg border border-ge-border rounded-lg px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:border-ge-accent outline-none"
                />
                <button
                  type="button"
                  onclick={saveCurrentSkillDraft}
                  class="px-4 py-2 rounded-lg bg-ge-accent text-black font-bold text-sm hover:brightness-110 cursor-pointer"
                >Save Skill</button>
              </div>
              <textarea
                bind:value={skillDraftContent}
                placeholder="Paste or write skill instructions, rules, or markdown here. When Active, this block is automatically injected into your prompts."
                class="flex-1 min-h-[280px] w-full bg-ge-bg border border-ge-border rounded-lg p-3 text-sm font-mono text-white placeholder:text-neutral-500 focus:border-ge-accent outline-none resize-none leading-relaxed"
              ></textarea>
            {:else}
              <div class="flex-1 flex items-center justify-center text-base text-neutral-300">
                Select or create a skill to edit and activate it.
              </div>
            {/if}
          </div>
        </div>
      {:else if skillsModalTab === 'lac'}
        <div class="flex-1 min-h-0 p-4 flex flex-col gap-3 overflow-hidden">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <div class="text-sm font-mono text-neutral-300">
              {#if lacContract}
                {lacContract.chars.toLocaleString()} chars · {lacContract.sha256.slice(0, 12)} {hasLacOverride ? '(in-app override active)' : '(disk default)'}
              {:else if lacContractError}
                <span class="text-ge-danger">{lacContractError}</span>
              {:else}
                Loading attached LAC skill...
              {/if}
            </div>
            <div class="flex items-center gap-2">
              <button
                type="button"
                onclick={() => createNewSkill('LAC Skill Copy', lacSkillDraft)}
                class="px-3 py-1.5 rounded-lg bg-ge-bg border border-ge-border hover:border-ge-accent/50 text-sm font-medium text-white cursor-pointer"
              >Save Copy to Library</button>
              {#if hasLacOverride}
                <button
                  type="button"
                  onclick={resetLacSkillOverride}
                  class="px-3 py-1.5 rounded-lg bg-ge-bg border border-ge-border hover:border-ge-danger text-sm font-medium text-white cursor-pointer"
                >Reset to Disk</button>
              {/if}
              <button
                type="button"
                onclick={applyLacSkillOverride}
                class="px-4 py-1.5 rounded-lg bg-ge-accent text-black font-bold text-sm hover:brightness-110 cursor-pointer"
              >Apply Edit</button>
            </div>
          </div>
          <textarea
            bind:value={lacSkillDraft}
            class="flex-1 min-h-[340px] w-full bg-ge-bg border border-ge-border rounded-lg p-3 text-sm font-mono text-white focus:border-ge-accent outline-none resize-none leading-relaxed"
          ></textarea>
        </div>
      {:else}
        <div class="flex-1 min-h-0 p-4 flex flex-col gap-3 overflow-hidden">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <div class="text-sm font-mono text-neutral-300">
              {#if vigContract}
                {vigContract.chars.toLocaleString()} chars · {vigContract.sha256.slice(0, 12)} {hasVigOverride ? '(in-app override active)' : '(disk default)'}
              {:else if vigContractError}
                <span class="text-ge-danger">{vigContractError}</span>
              {:else}
                Loading attached VIG skill...
              {/if}
            </div>
            <div class="flex items-center gap-2">
              <button
                type="button"
                onclick={() => createNewSkill('VIG Skill Copy', vigSkillDraft)}
                class="px-3 py-1.5 rounded-lg bg-ge-bg border border-ge-border hover:border-ge-accent/50 text-sm font-medium text-white cursor-pointer"
              >Save Copy to Library</button>
              {#if hasVigOverride}
                <button
                  type="button"
                  onclick={resetVigSkillOverride}
                  class="px-3 py-1.5 rounded-lg bg-ge-bg border border-ge-border hover:border-ge-danger text-sm font-medium text-white cursor-pointer"
                >Reset to Disk</button>
              {/if}
              <button
                type="button"
                onclick={applyVigSkillOverride}
                class="px-4 py-1.5 rounded-lg bg-ge-accent text-black font-bold text-sm hover:brightness-110 cursor-pointer"
              >Apply Edit</button>
            </div>
          </div>
          <textarea
            bind:value={vigSkillDraft}
            class="flex-1 min-h-[340px] w-full bg-ge-bg border border-ge-border rounded-lg p-3 text-sm font-mono text-white focus:border-ge-accent outline-none resize-none leading-relaxed"
          ></textarea>
        </div>
      {/if}
    </div>
  </div>
  {/if}

</main>

<style>
  .stage-morph {
    transition:
      width 400ms cubic-bezier(0.4, 0.0, 0.2, 1),
      height 400ms cubic-bezier(0.4, 0.0, 0.2, 1),
      transform 400ms cubic-bezier(0.4, 0.0, 0.2, 1),
      box-shadow 400ms cubic-bezier(0.4, 0.0, 0.2, 1);
  }

  iframe {
    transition: opacity 300ms cubic-bezier(0.4, 0.0, 0.2, 1);
  }
</style>
