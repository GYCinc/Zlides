<script lang="ts">
  import { onMount } from 'svelte';
  import { fade, scale } from 'svelte/transition';
  // All imports relative: tsconfig.app.json has no $lib/$contracts paths mapping (pre-existing debt).
  import { Reasoning, ReasoningTrigger, ReasoningContent } from './lib/components/ai-elements/reasoning/index.js';
  import Response from './lib/components/ai-elements/response/response.svelte';
  import { assemblePrompt } from './contracts/promptBuilder';
  import { fetchSavedSlides, fetchSavedSlideHtml, saveSlideToStorage, downloadHtmlFile, type SavedSlide } from './contracts/storage';
  // Typed SSE pipeline.
  import { SseParser, PageStore, feedSseFrame, type PageEntry, type SseEvent } from './lib/sse/parser';
  import { ensurePlaceholders, assembleSingleDocument, normalizeSavedHtml } from './lib/sse/placeholders.js';
  import { rescueDocumentFromAnswer } from './lib/sse/rescue';
  import LogoHeroHeader from './lib/components/brand/LogoHeroHeader.svelte';
  import LogoHeroSplash from './lib/components/brand/LogoHeroSplash.svelte';
  import MorphDropdown from './lib/components/ui/MorphDropdown.svelte';
  import ContractsMorphPopover from './lib/components/ui/ContractsMorphPopover.svelte';
  import {
    VIG_DOC_KIND_META,
    parseYouTubeId,
    extractCurriculumJson,
    validateCurriculum,
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
    buildLacDocument,
    LAC_BUILD_CONTRACT,
    type LacChassis,
    type Lac,
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

  // R4: every failure class lands here — rendered unmissable, non-blocking.
  let streamErrors = $state<{ code: string | null; message: string }[]>([]);
  // R4: visible-but-quiet counter for malformed/unknown wire frames (never silent).
  let wireNotices = $state(0);

  let isGenerating = $state(false);

  // ── VIG engine state: link in, compiled guide out ──
  let appMode = $state<'worksheet' | 'vig'>('worksheet');
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

  const LAC_EMPTY_HTML = `<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;background:#131313;color:#e5e7eb;font-family:sans-serif;margin:0;padding:32px;text-align:center;"><p style="font-size:18px;font-weight:600;">Attach a LAC JSON to build its worksheet</p></body></html>`;

  const VIG_EMPTY_HTML = `<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;background:#131313;color:#e5e7eb;font-family:sans-serif;margin:0;padding:32px;text-align:center;"><p style="font-size:18px;font-weight:600;">Paste a YouTube link to build a Video Immersion Guide</p></body></html>`;

  const selectedPage = $derived(pages[selectedPageIndex] ?? null);
  const iframeSrcDoc = $derived(
    appMode === 'vig'
      ? (vigHtml ?? VIG_EMPTY_HTML)
      : (lacHtml ?? ((isGenerating && livePageHtml !== null) ? livePageHtml : (selectedPage?.html ?? LAC_EMPTY_HTML)))
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
  const DEFAULT_TYPE_PROMPT = `Create a complete A4 portrait worksheet as one standalone HTML document — return only the HTML.\nPages are sequential <div class="page"> blocks, each 210 × 297 mm (width: 210mm; min-height: 297mm). Multi-page is normal when the content needs it — never squeeze content to fit one page.\nComposition: use the full page width; compact multi-column card grids within sections where natural; dense, adult print typography.`;
  const SLIDES_TYPE_PROMPT = `Create a 16:9 widescreen slide deck (1280 × 720 px per slide) as one standalone HTML document — return only the HTML.`;
  const WEBPAGE_TYPE_PROMPT = `Format: Continuous vertical visual document (HTML single-scroll report).\nLayout Engine: Responsive auto-height container. No slides, no fixed viewports, no pagination.\nNative mode cue: 长图 / long image — extended vertical scroll with content-adaptive section heights.\nOutput contract: one self-contained standalone HTML document (inline CSS/JS) — return only the HTML.`;

  const DEFAULT_FORMAT_PROMPT = `FORMAT BLUEPRINT (Structural Composition & Component Hierarchy — No Style Rules):\n\n1. CALLABLE CATEGORIES & SECTION HIERARCHY:\n   - Structure as a semantic document: <main> wrapping an intro <header> followed by modular <section> containers.\n   - Every section MUST declare its callable category via both id and data-category attribute, e.g.:\n     <section id="{{category_id}}" data-category="{{category_id}}">\n   - Canonical callable categories include:\n     • vocabulary\n     • phrasal-verbs\n     • collocations\n     • grammar\n     • idioms-and-phrases\n     • focus-points\n     • in-class-practice\n     • self-study\n   - Header Area: Contains document title, category eyebrow, session date/meta, and contextual lesson theme summary.\n\n2. EXERCISE CARD ARCHITECTURE & DYNAMIC SLOTS:\n   - Every exercise item is encapsulated inside a self-contained card: <article class="card" data-category="{{category_id}}">\n   - Inside each card, wrap the dynamic practice content in an identifiable slot container (class="dynamic-slot" or id ending in "-content" / "-container").\n   - Arrange atomic pieces flexibly across cards (dialogues, scenario clozes, decision trees, matching grids) to match the learning material rather than a rigid fixed template.\n\n3. IN-BOX REGENERATION ACTIONS (WILDCARDS):\n   - Place an in-box regeneration trigger inside each major exercise card: <button class="regenerate-btn" data-category="{{category_id}}" data-prompt="...">\n   - The data-prompt attribute MUST be a fully articulated AI generation prompt containing contextual wildcards populated from the source material and calling on the specific category.\n\n4. INTERACTIVE EXERCISE STRUCTURES:\n   - Contextual Cloze / Blanks, Multiple Choice, Matching grids, Dialogue / Tone Repair — each with data-answer / data-correct / data-pair contracts.\n\n5. INTERACTIVE FEEDBACK CONTRACT:\n   - Embed lightweight JavaScript logic to provide instant visual validation upon answer submission/selection. All interactivity must be self-contained within the HTML document.`;
  const CONTINUOUS_REPORT_PROMPT = `TEMPLATE BLUEPRINT (Structural Composition & Component Hierarchy — No Style Rules):\n\n1. DOCUMENT FLOW:\n   - One <main> wrapping an intro <header> (document title, eyebrow, audience/date meta, mini table of contents with in-page anchors) followed by modular <section data-section="{{section_id}}"> containers in outline order.\n   - Sections stack vertically with auto-height; never fixed-height panels, never page breaks, never slide chrome.\n\n2. CARD & COMPONENT ARCHITECTURE:\n   - Content units are self-contained cards: <article class="card" data-section="{{section_id}}">.\n   - Peer cards arrange into auto-wrapping bento grids.\n   - Key metrics render as KPI callout blocks (<div class="kpi"> — value + label + context line).\n   - Tradeoffs and comparisons render as clean 2-column <table> blocks.\n   - Every section heading carries an id matching its table-of-contents anchor.\n\n3. CONTINUATION CONTRACT:\n   - Emit sections strictly in outline order so an interrupted pass resumes with '继续生成剩余部分' without re-emitting delivered sections.\n   - On continuation, never reorder, renumber, or re-emit delivered sections.\n\n4. DENSITY SLOTS (structure only):\n   - Each bullet item opens with a bold lead-in phrase wrapped in <strong> (first 2–4 words).\n   - Every card carries substantive data or an explicit takeaway — no conversational filler, no empty placeholder text.`;

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

/* STRICT PROHIBITIONS */
- NO text below 13px anywhere on the sheet.
- NO external CSS frameworks (no Tailwind CDN, no Bootstrap CDN).
- All CSS must reside in a single self-contained embedded style element.
- NO PDF or print-break logic.
- Ban the word "drill" — use "Practice", "Scenario", "Precision Check", or "Challenge" instead.`;

  // Contract version: bump to v4 for full format & style refresh
  const CONTRACT_VERSION = 'v4';
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
  let typeSpace = $state(space('type', DEFAULT_TYPE_PROMPT));
  let formatSpace = $state(space('format', DEFAULT_FORMAT_PROMPT));
  let styleSpace = $state(space('style', DEFAULT_STYLE_TOKENS));
  let isContractsOpen = $state(false);
  // Viewer-only preview fit. Never enters the prompt.
  let previewMode = $state<'document' | 'slides' | 'webpage'>('document');
  let stageFitMode = $state<'fill' | 'fit-page' | '100%'>('fill');
  $effect(() => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem('zlides_space_type', typeSpace);
    localStorage.setItem('zlides_space_format', formatSpace);
    localStorage.setItem('zlides_space_style', styleSpace);
  });

  const contractsSigned = $derived(
    typeSpace.trim().length > 0 && formatSpace.trim().length > 0 && styleSpace.trim().length > 0
  );

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
      vigContract = {
        text: payload.contract,
        chars: payload.chars,
        sha256: payload.sha256,
        source: payload.source,
      };
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
        appMode = 'worksheet';
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
      html = normalizeSavedHtml(html);
      pages = html.includes(PAGE_SEPARATOR)
        ? html.split(PAGE_SEPARATOR).map((partHtml: string, i: number) => ({ position: i + 1, html: ensurePlaceholders(partHtml) }))
        : [{ position: 1, html: ensurePlaceholders(html) }];
      selectedPageIndex = 0;
      // W3/W4: a vault deck has no live server conversation — decouple continuation
      // and server export from the previously streamed session.
      clearConversation();
      isSavedModalOpen = false;
      status = `Loaded: ${slide.title}`;
      addMessage(`[Loaded Saved Class] **${slide.title}** (${slide.dateStr})`, 'agent');
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
      downloadHtmlFile(html, slide.filename);
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
    const rawLen = promptText.length + extractedMarkdown.length;
    if (rawLen === 0) return 0;
    return Math.ceil(rawLen / 3.5);
  }

  function updateCostEstimate() {
    if (!promptText.trim() && !extractedMarkdown) {
      cost = 0;
      lastTokens = null;
      return;
    }
    const est = estimateTokensClient();
    lastTokens = est;
    cost = Number(((est / 1_000_000) * 0.70).toFixed(4));
  }

  let costTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    void promptText;
    void extractedMarkdown;
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
    const ensured = ensurePlaceholders(editorHtml);
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
      editorHtml = appMode === 'vig' ? (vigHtml ?? '') : (selectedPage?.html ?? iframeSrcDoc);
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
      lacContract = { text: payload.contract, chars: payload.chars, sha256: payload.sha256 };
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

    const fullPrompt = [
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
            case 'answer':
              answerAccumulator += ev.text;
              chatMessages[agentMsgIndex].text = answerAccumulator;
              chatMessages = [...chatMessages];
              scrollChatLive();
              break;
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
      let assembled: string;
      if (asBuild.build && lacChassis) {
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
      if (docCheck.errors.length) {
        throw new Error(`The agent did not follow the structure (${docCheck.errors.join('; ')}), so nothing was saved.`);
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

      const fullPrompt = assemblePrompt({
        typeText: contract.text,
        formatText: '',
        userText: `Build the curriculum for ${textToSend}. The learner is a Spanish-speaking adult. Return only the JSON object.`,
        styleText: '',
        attachedMarkdown: JSON.stringify(cues),
        attachedFileName: 'transcript.json',
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

      const vocab = extractCurriculumJson(answerAccumulator);
      if (!vocab) {
        chatMessages[agentMsgIndex].text = `**Not curriculum JSON — raw reply:**\n\n\`\`\`\n${answerAccumulator.slice(0, 4000)}\n\`\`\``;
        chatMessages = [...chatMessages];
        throw new Error('The agent did not return curriculum JSON. Its raw reply is in the chat.');
      }

      const report = validateCurriculum(vocab, cues);
      report.warnings.forEach((w) => console.warn('[vig]', w));
      if (report.errors.length > 0) {
        const detail = report.errors.map((e) => `- ${e}`).join('\n');
        chatMessages[agentMsgIndex].text = `**Curriculum failed validation:**\n\n${detail}`;
        chatMessages = [...chatMessages];
        throw new Error(`Curriculum failed validation with ${report.errors.length} error${report.errors.length === 1 ? '' : 's'} (listed in the chat).`);
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
  }) {
    if (!opts?.fullPrompt && !promptText.trim() && !extractedMarkdown) return;
    if (!apiKey) {
      isApiKeyModalOpen = true;
      status = "Please set your API Key to generate.";
      return;
    }

    // W3: fresh request state; a continuation (opts.conversationId set) keeps the deck.
    lastStreamInterrupted = false;
    offerRestartWithContext = false;
    const isContinuation = opts?.conversationId != null;

    isGenerating = true;
    const textToSend = opts?.userLabel ?? promptText.trim();
    const fileName = attachedFileName;
    promptText = "";
    status = "Connecting to Z.AI Agent...";

    // ── Pure assembly: your signed contracts + content. Nothing injected. ──
    const fullPrompt =
      opts?.fullPrompt ??
      assemblePrompt({
        typeText: typeSpace,
        formatText: formatSpace,
        userText: textToSend,
        styleText: styleSpace,
        attachedMarkdown: extractedMarkdown,
        attachedFileName: fileName,
      });

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
    if (opts?.resetDeck ?? true) {
      pages = [];
      selectedPageIndex = 0;
    }
    livePageHtml = null;
    livePagePosition = null;
    streamErrors = [];
    wireNotices = 0;
    currentController = new AbortController();

    let thinkingAccumulator = "";
    let answerAccumulator = "";
    let lastLivePaintMs = 0;

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
            store.applyEvent(ev);
            lastLivePaintMs = Date.now();
            pages = store.pages.map((p) => ({ ...p, html: ensurePlaceholders(p.html) }));
            livePageHtml = ensurePlaceholders(ev.html);
            livePagePosition = ev.position;
            status = `Streaming... page ${ev.position ?? '?'} received`;
            break;
          }
          case 'page_progress': {
            // In-page streaming: the wire delivers page HTML as output delta
            // fragments (live-verified add_slide). Preview-only event — raw
            // accumulated HTML, never ensurePlaceholders on partials (ghost
            // sections would flicker), throttled to ~200 ms.
            const now = Date.now();
            if (now - lastLivePaintMs >= 200) {
              lastLivePaintMs = now;
              livePageHtml = ev.html;
              livePagePosition = ev.position;
              status = `Streaming... page ${ev.position ?? '?'} · ${Math.max(1, Math.round(ev.bytes / 1024))} KB`;
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
          ...(opts?.conversationId ? { conversation_id: opts.conversationId } : {}),
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
          const rescuedHtml = ensurePlaceholders(rescuedDoc);
          store.apply({ kind: 'page', position: 1, html: rescuedHtml, tool: 'answer_rescue', title: null });
          pages = store.pages.map((p) => ({ ...p, html: ensurePlaceholders(p.html) }));
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
        pages = store.pages.map((p) => ({ ...p, html: ensurePlaceholders(p.html) }));
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
      if (pages.length > 0) {
        const deckHtml = assembleSingleDocument(pages.map((p) => p.html));
        const saved = await saveSlideToStorage(deckHtml, textToSend || fileName || pages[0]?.title || 'Worksheet');
        await refreshSavedSlides();
        status = streamErrors.length === 0
          ? `Ready! ${pages.length} page${pages.length === 1 ? '' : 's'}, saved as ${saved.title}`
          : `Finished with errors: ${pages.length} page(s) retained, saved as ${saved.title}`;
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
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
        selectedPageIndex = idx >= 0 ? idx : Math.min(selectedPageIndex, pages.length - 1);
      }
      livePageHtml = null;
      livePagePosition = null;
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

  async function exportViaConversation() {
    if (isExporting) return;
    const conv = conversationId;
    if (!conv) {
      // No live conversation (vault-loaded / edited deck): straight to the local fallback.
      downloadHtmlFile(selectedPage?.html ?? iframeSrcDoc, `worksheet_${Date.now()}.html`);
      status = 'No server conversation for this deck, saved the current page locally instead';
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
          custom_variables: { include_html: true, include_pdf: true },
        }),
      });
      if (!resp.ok) throw new HttpError(resp.status, resp.statusText);
      const files = extractExportFiles(await resp.json());
      if (files.length === 0) throw new Error('Export returned no files for this conversation');
      for (const f of files) downloadRemoteFile(f.url, f.name);
      status = `Export ready: ${files.length} file${files.length === 1 ? '' : 's'} downloaded`;
    } catch (err: unknown) {
      // Never silent: surface the failure, then fall back to the local blob download.
      const human = err instanceof HttpError
        ? describeFailure(err)
        : err instanceof Error
          ? err.message
          : String(err);
      streamErrors = [
        ...streamErrors,
        { code: null, message: `Server export failed: ${human}. Downloaded the current page locally instead` },
      ];
      status = 'Export failed, local fallback saved';
      downloadHtmlFile(selectedPage?.html ?? iframeSrcDoc, `worksheet_${Date.now()}.html`);
    } finally {
      isExporting = false;
    }
  }

  function downloadCurrentHtml() {
    if (lacHtml) {
      if (!lacHtml) { status = 'No worksheet to download yet'; return; }
      downloadHtmlFile(lacHtml, `lac_worksheet_${Date.now()}.html`);
      status = 'Downloaded the worksheet HTML';
      return;
    }
    if (appMode === 'vig') {
      if (!vigHtml) {
        status = 'No guide to download yet';
        return;
      }
      downloadHtmlFile(vigHtml, `video_immersion_guide_${Date.now()}.html`);
      status = 'Downloaded the guide HTML';
      return;
    }
    const html = selectedPage?.html ?? iframeSrcDoc;
    downloadHtmlFile(html, `worksheet_page_${selectedPage?.position ?? 1}_${Date.now()}.html`);
    status = 'Downloaded current page HTML';
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
    <LogoHeroHeader />

    <div class="grid grid-cols-2 gap-1 p-1 bg-ge-bg border border-ge-border rounded-xl flex-shrink-0" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={appMode === 'worksheet'}
        onclick={() => { appMode = 'worksheet'; }}
        title="Worksheet Engine"
        class="py-2 px-1 rounded-lg text-sm font-semibold transition-colors cursor-pointer truncate {appMode === 'worksheet' ? 'bg-ge-card text-white border border-ge-border-strong' : 'text-neutral-300 hover:text-white'}"
      >
        Worksheet
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={appMode === 'vig'}
        onclick={() => { appMode = 'vig'; }}
        title="Video Immersion Guide"
        class="py-2 px-1 rounded-lg text-sm font-semibold transition-colors cursor-pointer truncate {appMode === 'vig' ? 'bg-ge-card text-white border border-ge-border-strong' : 'text-neutral-300 hover:text-white'}"
      >
        Video Guide
      </button>
    </div>


    <!-- Chat History & Large High-Contrast Reasoning Stream -->
    <div id="chat-history" class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4 p-4 bg-ge-bg rounded-xl border border-ge-border text-base leading-relaxed">
      {#each chatMessages as msg}
        {#if msg.role === 'user'}
          <div class="p-4 rounded-xl max-w-[90%] whitespace-pre-wrap bg-[#202326] text-white ml-auto border border-[#34383d] text-base leading-relaxed shadow-md font-normal">{msg.text}</div>
        {:else if msg.thinking || msg.text}
          <div class="max-w-[98%] mr-auto space-y-3 w-full">
            {#if msg.thinking}
              <div class="p-4 rounded-xl bg-[#16181b] border border-[#2e3236] shadow-sm">
                <Reasoning
                  isStreaming={true}
                  defaultOpen={true}
                >
                  <ReasoningTrigger class="text-base font-semibold text-ge-accent hover:text-white" />
                  <ReasoningContent content={msg.thinking} class="text-lg leading-relaxed text-white font-normal" />
                </Reasoning>
              </div>
            {/if}
            {#if msg.text}
              <div class="pl-3.5 border-l-2 border-ge-accent py-1">
                <div class="text-sm font-bold text-ge-accent mb-1.5 flex items-center gap-1.5">
                  <span class="inline-block h-2 w-2 rounded-full bg-ge-accent"></span>
                  Worksheet Engine
                </div>
                <Response content={msg.text} class="prose-invert text-base text-white max-w-none leading-relaxed font-normal" />
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
      </div>
      {:else}
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
        <label class="flex flex-col gap-1.5">
          <span class="text-sm font-semibold text-neutral-200">One-off direction <span class="text-neutral-400 font-normal">(optional)</span></span>
          <textarea
            bind:value={lacDirection}
            rows="3"
            placeholder="Make this one differently today — a new chapter theme, a different order, a harder register..."
            class="w-full bg-ge-card border border-ge-border rounded-lg px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:border-ge-accent outline-none resize-y"
          ></textarea>
        </label>
        <div class="text-sm font-mono text-neutral-400">
          {#if lacContract}
            Skill: {lacContract.chars.toLocaleString()} chars · {lacContract.sha256.slice(0, 12)}
          {:else if lacContractError}
            <span class="text-ge-danger">Skill unavailable: {lacContractError}</span>
          {:else}
            Loading the LAC skill...
          {/if}
        </div>
      </div>
      {/if}

      <button
        onclick={isGenerating ? stopRequest : (appMode === 'vig' ? () => generateVig() : () => generateLac())}
        disabled={!isGenerating && (appMode === 'vig' ? !vigLinkInput.trim() : !lac)}
        title={appMode === 'worksheet' && !lac ? 'Attach a LAC JSON to enable send' : undefined}
        class="{isGenerating
          ? 'bg-ge-danger text-white hover:bg-ge-danger/90'
          : 'bg-ge-accent text-black font-extrabold hover:brightness-110'} py-3 px-4 text-base rounded-xl transition-all shadow-lg active:translate-y-[1px] disabled:opacity-50 disabled:cursor-not-allowed tracking-wide"
      >
        {isGenerating ? 'Stop Generation' : (appMode === 'vig' ? 'Generate Video Guide' : 'Generate Worksheet')}
      </button>


      <div class="px-3.5 py-2 bg-ge-bg rounded-lg text-xs border border-ge-border flex justify-between items-center font-mono">
        <span class="text-neutral-300 flex items-center gap-2 font-medium">
          <span class="relative flex h-2 w-2">
            {#if isGenerating || isUploading}
              <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-ge-accent opacity-75"></span>
              <span class="relative inline-flex rounded-full h-2 w-2 bg-ge-accent"></span>
            {:else}
              <span class="relative inline-flex rounded-full h-2 w-2 bg-ge-success"></span>
            {/if}
          </span>
          Cost{lastTokens !== null ? ` · ${lastTokens.toLocaleString()} tokens` : ''}
        </span>
        <span class="text-ge-success font-bold text-sm">${formatUsd(cost)}</span>
      </div>

      <div class="text-center text-sm text-neutral-400 font-mono h-5 truncate">
        {status !== 'Ready' ? status : ''}{wireNotices > 0 ? ` · ${wireNotices} wire notice${wireNotices === 1 ? '' : 's'}` : ''}
      </div>
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
      <!-- Left: View Mode & Stage Fit controls with Animated Morph Dropdowns -->
      <div class="flex items-center gap-2 shrink-0">
        {#if appMode === 'worksheet'}
        <!-- Preview / Stage View Size Morph Dropdown -->
        <MorphDropdown
          label="Preview"
          bind:value={stageFitMode}
          width={240}
          options={[
            { id: 'fill', label: 'Fill Stage (Full Screen)', sublabel: 'Dynamic responsive scaling', accentColor: '#4fb3a9' },
            { id: 'fit-page', label: 'Fit Page View', sublabel: 'Preserve natural aspect ratio', accentColor: '#f0b23e' },
            { id: '100%', label: '100% Scale', sublabel: 'Literal 1:1 pixel rendering', accentColor: '#ffffff' }
          ]}
        />

        <!-- Mode / Archetype Morph Dropdown -->
        <MorphDropdown
          bind:value={previewMode}
          width={230}
          options={[
            { id: 'document', label: 'A4 Document', sublabel: 'Portrait 794×1123 print worksheet', accentColor: '#f0b23e' },
            { id: 'slides', label: '16:9 Slides', sublabel: 'Widescreen 1280×720 canvas', accentColor: '#4fb3a9' },
            { id: 'webpage', label: 'Fluid Webpage', sublabel: 'Responsive single-scroll report', accentColor: '#ffffff' }
          ]}
        />
        {/if}
      </div>

      <!-- Center: Page Navigation Stepper & Live Streaming Indicator -->
      <div class="flex items-center gap-2">
        {#if appMode === 'worksheet' && !lacHtml}
        {#if isGenerating}
          <div class="flex items-center gap-2 px-3 py-1 rounded-lg border border-ge-accent/40 bg-ge-accent/10">
            <span class="h-2 w-2 rounded-full bg-ge-accent animate-ping"></span>
            <span class="text-sm font-semibold text-ge-accent">Streaming Page {livePagePosition ?? (pages.length + 1)}...</span>
          </div>
        {:else}
          <div class="flex items-center gap-1 bg-ge-bg border border-ge-border rounded-lg p-0.5">
            <button
              class="px-2 py-1.5 rounded-md hover:bg-ge-card text-neutral-300 hover:text-white transition-colors disabled:opacity-25 disabled:hover:bg-transparent cursor-pointer flex items-center justify-center"
              disabled={selectedPageIndex <= 0}
              onclick={prevPage}
              title="Previous page (Left arrow)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <span class="text-sm font-inter px-2.5 text-white font-semibold">
              Page {selectedPage ? selectedPageIndex + 1 : 1} of {Math.max(1, pages.length)}
            </span>
            <button
              class="px-2 py-1.5 rounded-md hover:bg-ge-card text-neutral-300 hover:text-white transition-colors disabled:opacity-25 disabled:hover:bg-transparent cursor-pointer flex items-center justify-center"
              disabled={selectedPageIndex >= pages.length - 1}
              onclick={nextPage}
              title="Next page (Right arrow)"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>
        {/if}
        {/if}
      </div>

      <!-- Right: Consolidated Actions (Export Dropdown, Vault, API Key) -->
      <div class="flex items-center gap-2.5 shrink-0">
        <!-- Export & Document Actions Morph Dropdown -->
        <MorphDropdown
          label="Export"
          align="right"
          width={240}
          options={[
            {
              id: 'pdf',
              label: isExporting ? 'Exporting PDF...' : 'Export PDF / ZIP',
              sublabel: 'Compile bundle via Z.AI API',
              accentColor: '#f0b23e',
              onclick: () => exportViaConversation()
            },
            {
              id: 'html',
              label: 'Download HTML',
              sublabel: 'Save standalone file locally',
              accentColor: '#4fb3a9',
              onclick: () => downloadCurrentHtml()
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
          appMode === 'vig'
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
        {#if appMode === 'worksheet' && !lacHtml && pages.length === 0 && !isGenerating && !livePageHtml}
          <LogoHeroSplash />
        {:else}
          <iframe
            title="Worksheet Preview"
            srcdoc={iframeSrcDoc}
            class="bg-[#131313]"
            style={
              appMode === 'vig'
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
