<script lang="ts">
  import { onMount } from 'svelte';
  // All imports relative: tsconfig.app.json has no $lib/$contracts paths mapping (pre-existing debt).
  import { Reasoning, ReasoningTrigger, ReasoningContent } from './lib/components/ai-elements/reasoning/index.js';
  import Response from './lib/components/ai-elements/response/response.svelte';
  import { assemblePrompt } from './contracts/promptBuilder';
  import { fetchSavedSlides, fetchSavedSlideHtml, saveSlideToStorage, downloadHtmlFile, type SavedSlide } from './contracts/storage';
  // Typed SSE pipeline.
  import { SseParser, PageStore, feedSseFrame, type PageEntry, type SseEvent } from './lib/sse/parser';
  import { ensurePlaceholders, assembleSingleDocument, normalizeSavedHtml } from './lib/sse/placeholders.js';

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

  const selectedPage = $derived(pages[selectedPageIndex] ?? null);
  const iframeSrcDoc = $derived(
    (isGenerating && livePageHtml !== null) ? livePageHtml : (selectedPage?.html ?? EMPTY_DOC_HTML)
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
  const PAGE_SEPARATOR = '\n<!-- zlides:page-break -->\n';
  const DEFAULT_TYPE_PROMPT = `Create a complete A4 portrait worksheet as one standalone HTML document — return only the HTML.\nPages are sequential <div class="page"> blocks, each 210 × 297 mm (width: 210mm; min-height: 297mm). Multi-page is normal when the content needs it — never squeeze content to fit one page.\nComposition: use the full page width; compact multi-column card grids within sections where natural; dense, adult print typography.`;
  const DEFAULT_FORMAT_PROMPT = `FORMAT BLUEPRINT (Structural Composition & Component Hierarchy — No Style Rules):\n\n1. CALLABLE CATEGORIES & SECTION HIERARCHY:\n   - Structure as a semantic document: <main> wrapping an intro <header> followed by modular <section> containers.\n   - Every section MUST declare its callable category via both id and data-category attribute, e.g.:\n     <section id="{{category_id}}" data-category="{{category_id}}">\n   - Canonical callable categories include:\n     • vocabulary\n     • phrasal-verbs\n     • collocations\n     • grammar\n     • idioms-and-phrases\n     • focus-points\n     • in-class-practice\n     • self-study\n   - Header Area: Contains document title, category eyebrow, session date/meta, and contextual lesson theme summary.\n\n2. EXERCISE CARD ARCHITECTURE & DYNAMIC SLOTS:\n   - Every exercise item is encapsulated inside a self-contained card: <article class="card" data-category="{{category_id}}">\n   - Inside each card, wrap the dynamic practice content in an identifiable slot container (class="dynamic-slot" or id ending in "-content" / "-container").\n   - Arrange atomic pieces flexibly across cards (dialogues, scenario clozes, decision trees, matching grids) to match the learning material rather than a rigid fixed template.\n\n3. IN-BOX REGENERATION ACTIONS (WILDCARDS):\n   - Place an in-box regeneration trigger inside each major exercise card: <button class="regenerate-btn" data-category="{{category_id}}" data-prompt="...">\n   - The data-prompt attribute MUST be a fully articulated AI generation prompt containing contextual wildcards populated from the source material and calling on the specific category.\n\n4. INTERACTIVE EXERCISE STRUCTURES:\n   - Contextual Cloze / Blanks, Multiple Choice, Matching grids, Dialogue / Tone Repair — each with data-answer / data-correct / data-pair contracts.\n\n5. INTERACTIVE FEEDBACK CONTRACT:\n   - Embed lightweight JavaScript logic to provide instant visual validation upon answer submission/selection. All interactivity must be self-contained within the HTML document.`;
  const DEFAULT_STYLE_TOKENS = `:root {\n  --bg: #0f1112;\n  --surface: #16181a;\n  --surface-elevated: #1e2124;\n  --line: #2e3236;\n  --line-strong: #373b40;\n  --line-soft: rgba(63, 63, 70, 0.50);\n  --text-heading: #ffffff;\n  --text: #e5e7eb;\n  --text-body: #cfd3d8;\n  --muted: #9ca3af;\n  --faint: #6b7280;\n  --brand: #ff6b35;\n  --brand-deep: #7e1500;\n  --brand-soft: rgba(255, 107, 53, 0.12);\n  --brand-glow: rgba(255, 107, 53, 0.25);\n  --accent: var(--brand);\n  --font-display: 'Fraunces', Georgia, serif;\n  --font-head: 'Raleway', sans-serif;\n  --font-body: 'Inter', system-ui, sans-serif;\n  --font-mono: 'JetBrains Mono', ui-monospace, monospace;\n  --radius-sm: 3px;\n  --radius-md: 6px;\n}`;
  const space = (key: string, fallback: string) =>
    (typeof localStorage !== 'undefined' && localStorage.getItem(`zlides_space_${key}`)) || fallback;
  let typeSpace = $state(space('type', DEFAULT_TYPE_PROMPT));
  let formatSpace = $state(space('format', DEFAULT_FORMAT_PROMPT));
  let styleSpace = $state(space('style', DEFAULT_STYLE_TOKENS));
  let isContractsOpen = $state(false);
  // Viewer-only preview fit. Never enters the prompt.
  let previewMode = $state<'document' | 'slides' | 'webpage'>('document');
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

  onMount(() => {
    refreshSavedSlides();

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
      editorHtml = selectedPage?.html ?? iframeSrcDoc;
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
      if (err.status === 401 || err.status === 403) return 'API key invalid or missing — check Settings (key button, top left)';
      if (err.status === 429) return 'Rate limited by the provider — wait a moment and try again';
      if (err.status >= 500) return 'Provider server error — please retry in a moment';
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
  const SLIDE_LOGICAL_W = 1280;
  const SLIDE_LOGICAL_H = 720;
  const stageInnerW = $derived(Math.max(0, stageBoxW - 40)); // minus p-5 padding both sides
  const stageInnerH = $derived(Math.max(0, stageBoxH - 40));
  // Document: fit A4 width, never upscale (keeps text crisp); height overflow scrolls inside the iframe.
  const docScale = $derived(stageInnerW > 0 ? Math.min(1, stageInnerW / DOC_LOGICAL_W) : 1);
  // Slides: scale whole 1280×720 canvas to fit both dimensions (up/down).
  const slideScale = $derived(
    stageInnerW > 0 && stageInnerH > 0
      ? Math.min(stageInnerW / SLIDE_LOGICAL_W, stageInnerH / SLIDE_LOGICAL_H)
      : 1
  );

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
            pages = store.pages.map((p) => ({ ...p, html: ensurePlaceholders(p.html) }));
            livePageHtml = ensurePlaceholders(ev.html);
            livePagePosition = ev.position;
            status = `Streaming... page ${ev.position ?? '?'} received`;
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
            answerAccumulator += (answerAccumulator ? '\n' : '') + ev.text;
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
      if (!reader) throw new Error("Response has no readable body — stream unavailable");
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

      // Spec §8: zero pages + zero errors is a real outcome — never a fabricated slide.
      if (pages.length === 0 && store.unpositioned.length === 0 && streamErrors.length === 0) {
        const emptyMsg = answerAccumulator.trim()
          ? 'Agent returned no pages. Its text reply is shown in the chat.'
          : 'Agent returned no pages and no reply text — try rephrasing the prompt.';
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
          : 'Pages arrived without positions — kept out of deck ordering (see wire notices)';
      } else {
        status = `Finished with errors — ${pages.length} page${pages.length === 1 ? '' : 's'} retained`;
      }

      // R5: vault keeps working; multi-page decks assemble as SINGLE document (one doctype, sequential bodies).
      if (pages.length > 0) {
        const deckHtml = assembleSingleDocument(pages.map((p) => p.html));
        const saved = await saveSlideToStorage(deckHtml, textToSend || fileName || pages[0]?.title || 'Worksheet');
        await refreshSavedSlides();
        status = streamErrors.length === 0
          ? `Ready! ${pages.length} page${pages.length === 1 ? '' : 's'} — saved as ${saved.title}`
          : `Finished with errors — ${pages.length} page(s) retained, saved as ${saved.title}`;
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        // Mid-stream user abort: partial pages stay viewable (spec §8).
        status = `Generation stopped — ${pages.length} page${pages.length === 1 ? '' : 's'} retained`;
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
          ? `\n\n${pages.length} page${pages.length === 1 ? '' : 's'} received before the failure — still viewable in the stage.`
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
      status = 'No server conversation for this deck — saved the current page locally instead';
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
      status = `Export ready — ${files.length} file${files.length === 1 ? '' : 's'} downloaded`;
    } catch (err: unknown) {
      // Never silent: surface the failure, then fall back to the local blob download.
      const human = err instanceof HttpError
        ? describeFailure(err)
        : err instanceof Error
          ? err.message
          : String(err);
      streamErrors = [
        ...streamErrors,
        { code: null, message: `Server export failed: ${human} — downloaded the current page locally instead` },
      ];
      status = 'Export failed — local fallback saved';
      downloadHtmlFile(selectedPage?.html ?? iframeSrcDoc, `worksheet_${Date.now()}.html`);
    } finally {
      isExporting = false;
    }
  }

  function downloadCurrentHtml() {
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
      `Target: position ${pos} — section "${sectionId}" — replace .dynamic-slot content only for that section, preserve all other chrome.`,
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
    <div class="space-y-2 flex-shrink-0">
      <div class="flex items-center justify-between pb-3 border-b border-ge-border-soft">
        <div class="flex items-center gap-2.5">
          <img src="/logo.png" alt="GitEnglish" class="h-8 w-8 rounded-lg shadow-md border border-ge-border object-contain bg-[#fff8f0]" />
          <h1 class="text-2xl font-extrabold text-white font-raleway tracking-tight flex items-center gap-1.5">
            <span class="text-ge-accent text-3xl font-black drop-shadow-[0_0_12px_rgba(255,107,53,0.5)]">Z</span>lides
            <span class="bg-ge-accent/20 border border-ge-accent/60 text-ge-accent font-mono text-xs px-2 py-0.5 rounded-full font-bold ml-1">v28</span>
          </h1>
        </div>
        <div class="flex items-center gap-2">
          <button
            class="text-xs px-2.5 py-1.5 bg-ge-bg border border-ge-border hover:border-ge-accent/50 rounded-lg text-neutral-300 font-medium hover:text-white transition-colors flex items-center gap-1.5"
            onclick={() => { tempApiKey = apiKey; isApiKeyModalOpen = true; }}
            title="Configure Z.AI API Key"
          >
            <span class="h-2 w-2 rounded-full {apiKey ? 'bg-ge-success' : 'bg-ge-danger'}"></span>
            API Key
          </button>
          <button
            class="text-sm px-3 py-1.5 bg-ge-bg border border-ge-border hover:border-ge-accent/50 rounded-lg text-white font-medium hover:text-ge-accent transition-colors flex items-center gap-2"
            onclick={() => { isSavedModalOpen = true; refreshSavedSlides(); }}
            title="Browse saved worksheets and past classes"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-ge-accent"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
            Past Classes ({savedSlides.length})
          </button>
        </div>
      </div>
    </div>

    <div class="flex flex-col gap-1 flex-shrink-0">
      <button
        type="button"
        onclick={() => isContractsOpen = !isContractsOpen}
        aria-expanded={isContractsOpen}
        class="text-left text-sm text-neutral-400 hover:text-white flex items-center gap-1.5 py-1"
      >
        <span class="inline-block transition-transform text-xs" style={isContractsOpen ? 'transform: rotate(90deg)' : 'transform: rotate(0deg)'}>▸</span>
        <span class="underline decoration-dotted underline-offset-4">Contracts (optional)</span>
        <span class="text-xs text-neutral-500 truncate ml-1">Type: document · Format: regenerating-worksheet · Style: gitenglish</span>
      </button>
      {#if isContractsOpen}
        <div class="flex flex-col gap-2 rounded-lg border border-ge-border bg-ge-bg p-3">
          <div>
            <label class="block text-sm font-bold text-ge-accent mb-1 uppercase tracking-wide" for="space-type">Type — canvas target</label>
            <textarea
              id="space-type"
              bind:value={typeSpace}
              rows="2"
              class="w-full bg-ge-card border border-ge-border rounded-lg p-2 text-sm text-white placeholder:text-neutral-400 focus:border-ge-accent outline-none font-mono leading-relaxed"
            ></textarea>
          </div>
          <div class="rounded-md border border-ge-border bg-ge-card px-2.5 py-2">
            <p class="text-sm font-bold text-ge-accent uppercase tracking-wide">Format — structure blueprint</p>
            <p class="text-sm text-neutral-300 mt-1">Header Worksheet selector is source of truth · regenerating-worksheet blueprint (pre-filled, not duplicated)</p>
          </div>
          <div>
            <label class="block text-sm font-bold text-ge-accent mb-1 uppercase tracking-wide" for="space-style">Style — design system</label>
            <textarea
              id="space-style"
              bind:value={styleSpace}
              rows="3"
              class="w-full bg-ge-card border border-ge-border rounded-lg p-2 text-sm text-white placeholder:text-neutral-400 focus:border-ge-accent outline-none font-mono leading-relaxed"
            ></textarea>
          </div>
        </div>
      {/if}
      <div class="flex items-center gap-2">
        <span class="text-sm text-neutral-400">Preview fit (viewer only, never sent):</span>
        <select bind:value={previewMode} class="bg-ge-card border border-ge-border rounded-lg px-2 py-1 text-white text-sm focus:border-ge-accent outline-none">
          <option value="document">A4 document</option>
          <option value="slides">16:9 slides</option>
          <option value="webpage">Fluid webpage</option>
        </select>
        <span class="ml-auto text-sm font-mono {contractsSigned ? 'text-ge-success' : 'text-ge-danger'}">
          {contractsSigned ? 'contracts signed' : 'unsigned — send locked'}
        </span>
      </div>
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
      <div class="flex flex-col bg-ge-bg rounded-xl p-3 border border-ge-border">
        <textarea
          bind:value={promptText}
          onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generate(); } }}
          placeholder="Describe what you want or paste raw lesson notes..."
          rows="3"
          class="w-full bg-transparent border-none outline-none resize-y p-1 text-white placeholder:text-neutral-400 text-base min-h-[84px] font-inter leading-relaxed"
        ></textarea>

        <div class="flex items-center justify-between pt-2.5 border-t border-ge-border-soft">
          <div class="flex items-center gap-2">
            <label class="cursor-pointer text-xs font-semibold flex items-center gap-1.5 bg-ge-card hover:bg-ge-card-elevated px-3 py-1.5 rounded-lg border border-ge-border text-white transition-colors disabled:opacity-50 whitespace-nowrap" class:opacity-50={isUploading}>
              {#if isUploading}
                <span class="animate-spin h-3.5 w-3.5 border-2 border-ge-accent border-t-transparent rounded-full"></span>
              {:else}
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-ge-accent"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
              {/if}
              Attach File
              <input type="file" class="hidden" onchange={handleFileSelect} accept=".txt,.md,.json,.html,.csv,.doc,.docx" disabled={isUploading} />
            </label>

            {#if attachedFileName}
              <div class="flex items-center gap-1.5 bg-ge-card px-2.5 py-1 rounded-md border border-ge-accent/40 text-xs">
                <span class="text-ge-accent truncate max-w-[140px] font-medium" title={attachedFileName}>{attachedFileName}</span>
                <button onclick={clearAttachedFile} class="text-neutral-400 hover:text-white" title="Remove attachment">✕</button>
              </div>
            {/if}
          </div>
        </div>
      </div>

      <button
        onclick={isGenerating ? stopRequest : () => generate()}
        disabled={!isGenerating && (isUploading || !contractsSigned || (!promptText.trim() && !extractedMarkdown))}
        title={contractsSigned ? undefined : 'Sign all three contracts (Type, Format, Style) to enable send'}
        class="{isGenerating
          ? 'bg-ge-danger text-white hover:bg-ge-danger/90'
          : 'bg-ge-accent text-black font-extrabold hover:brightness-110'} py-3 px-4 text-base rounded-xl transition-all shadow-lg active:translate-y-[1px] disabled:opacity-50 disabled:cursor-not-allowed tracking-wide"
      >
        {isGenerating ? 'Stop Generation' : 'Generate Worksheet'}
      </button>

      {#if offerRestartWithContext}
        <button
          onclick={() => restartWithContext()}
          disabled={isGenerating}
          title="Start a fresh conversation seeded with a summary of the pages already generated"
          class="w-full py-2.5 px-4 text-sm rounded-xl border border-ge-accent/60 bg-ge-accent/10 text-white font-semibold hover:bg-ge-accent/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Conversation lost — restart deck with context
        </button>
      {:else if canContinue}
        <button
          onclick={() => continueRemainingPages()}
          disabled={isGenerating}
          title="Send the continuation trigger to the same server conversation and append the missing pages"
          class="w-full py-2.5 px-4 text-sm rounded-xl border border-ge-border bg-ge-bg text-neutral-200 font-semibold hover:border-ge-accent/50 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Continue remaining pages{pageGapCount > 0 ? ` · ${pageGapCount} position${pageGapCount === 1 ? '' : 's'} missing` : ''}
        </button>
      {/if}

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
    <div class="flex-shrink-0 h-10 border-b border-ge-border bg-ge-card flex items-center gap-2 px-3 relative z-20 overflow-visible">
      <div class="flex items-center gap-2 shrink-0">
        <span class="text-sm font-semibold text-white">Preview</span>
        <span class="text-sm text-neutral-400 font-mono">{pages.length} pages</span>
      </div>
      <div class="flex-1 min-w-0 mx-2 hidden sm:flex items-center gap-2 h-8 rounded-lg border border-ge-border bg-ge-bg px-3 overflow-hidden">
        <span class="text-sm font-semibold text-ge-accent shrink-0 whitespace-nowrap">Chain of thought</span>
        <span class="hidden md:inline text-sm text-neutral-500 shrink-0">|</span>
        <span class="text-sm truncate min-w-0 leading-none {isGenerating ? 'text-ge-accent' : 'text-white'}">
          {#if isGenerating}
            Reasoning streams live in chat — see below
          {:else if chatMessages[chatMessages.length - 1]?.thinking}
            {chatMessages[chatMessages.length - 1].thinking.slice(0, 160)}{chatMessages[chatMessages.length - 1].thinking.length > 160 ? '…' : ''}
          {:else}
            <span class="text-sm text-neutral-400">Idle — waiting for generation</span>
          {/if}
        </span>
        {#if isGenerating}
          <span class="ml-auto hidden lg:flex items-center gap-1.5 shrink-0">
            <span class="h-2 w-2 rounded-full bg-ge-accent animate-pulse"></span>
            <span class="text-sm font-medium text-ge-accent">streaming</span>
          </span>
        {/if}
      </div>
      <div class="flex items-center h-10 shrink-0 gap-2">
        <button
          class="h-8 w-8 flex items-center justify-center rounded-lg border border-ge-border bg-ge-bg text-white hover:border-ge-accent/50 hover:text-ge-accent transition-colors shrink-0"
          aria-label={isControlsCollapsed ? 'Expand controls' : 'Collapse controls'}
          aria-expanded={!isControlsCollapsed}
          onclick={() => { isControlsCollapsed = !isControlsCollapsed; if (isControlsCollapsed) { isDeckControlsOpen = false; isWorksheetTypeOpen = false; } }}
          title={isControlsCollapsed ? 'Expand controls' : 'Collapse controls'}
        >
          {#if isControlsCollapsed}
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
          {:else}
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          {/if}
        </button>
        {#if !isControlsCollapsed}
          <div class="flex items-center gap-2">
            <div class="relative">
              <button
                class="h-8 w-8 flex items-center justify-center rounded-lg border border-ge-border bg-ge-bg text-white hover:border-ge-accent/50 hover:text-ge-accent transition-colors"
                aria-label="Worksheet type"
                aria-expanded={isWorksheetTypeOpen}
                onclick={() => { isWorksheetTypeOpen = !isWorksheetTypeOpen; if (isWorksheetTypeOpen) isDeckControlsOpen = false; }}
                title="Worksheet type"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              </button>
              {#if isWorksheetTypeOpen}
                <div class="absolute right-0 top-full mt-2 w-72 rounded-xl border border-ge-border bg-ge-card shadow-2xl overflow-hidden z-30">
                  <div class="px-3 py-2 border-b border-ge-border flex items-center justify-between">
                    <p class="text-sm font-semibold text-white">Worksheet type</p>
                    <button class="text-sm text-neutral-400 hover:text-white px-1" aria-label="Close worksheet menu" onclick={() => isWorksheetTypeOpen = false}>✕</button>
                  </div>
                  <div class="p-2 flex flex-col gap-1">
                    <button class="w-full text-left text-sm px-3 py-2 rounded-lg bg-ge-bg border border-ge-border text-white hover:border-ge-accent/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" onclick={() => regenerateWorksheetSection('full')} disabled={isGenerating || pages.length === 0}>Regenerate worksheet</button>
                    <button class="w-full flex items-center justify-between text-sm px-3 py-2 rounded-lg bg-ge-bg border border-ge-border text-white hover:border-ge-accent/50 transition-colors" aria-expanded={isWorksheetSectionExpanded} onclick={() => isWorksheetSectionExpanded = !isWorksheetSectionExpanded}>
                      <span class="text-sm">Regenerate section</span>
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-neutral-400 shrink-0 transition-transform" style={isWorksheetSectionExpanded ? 'transform: rotate(180deg)' : 'transform: rotate(0deg)'}><path d="m6 9 6 6 6-6"/></svg>
                    </button>
                    {#if isWorksheetSectionExpanded}
                      <div class="ml-2 pl-2 border-l border-ge-border flex flex-col gap-1 mt-1">
                        {#each WORKSHEET_SECTION_TYPES as t (t.id)}
                          <button class="w-full text-left text-sm px-3 py-2 rounded-lg bg-ge-bg border border-ge-border text-white hover:border-ge-accent/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" onclick={() => regenerateWorksheetSection(t.id)} disabled={isGenerating || pages.length === 0}>{t.label}</button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                  <p class="px-3 pb-2 text-sm text-neutral-400">Applies to page {selectedPage?.position ?? 1}</p>
                </div>
              {/if}
            </div>
            <div class="relative">
              <button
                class="h-8 w-8 flex items-center justify-center rounded-lg border border-ge-border bg-ge-bg text-white hover:border-ge-accent/50 hover:text-ge-accent transition-colors"
                aria-label="Deck controls"
                aria-expanded={isDeckControlsOpen}
                onclick={() => { isDeckControlsOpen = !isDeckControlsOpen; if (isDeckControlsOpen) isWorksheetTypeOpen = false; }}
                title="Deck controls"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="8" cy="6" r="2" fill="currentColor" stroke="none"/><circle cx="16" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="10" cy="18" r="2" fill="currentColor" stroke="none"/></svg>
              </button>
              {#if isDeckControlsOpen}
                <div class="absolute right-0 top-full mt-2 w-[22rem] rounded-xl border border-ge-border bg-ge-card shadow-2xl overflow-hidden z-30 max-h-[70vh] overflow-y-auto">
                  <div class="px-3 py-2 border-b border-ge-border flex items-center justify-between sticky top-0 bg-ge-card">
                    <p class="text-sm font-semibold text-white">Deck controls</p>
                    <button class="text-sm text-neutral-400 hover:text-white px-1" aria-label="Close deck controls" onclick={() => isDeckControlsOpen = false}>✕</button>
                  </div>
                  <div class="p-3 flex flex-col gap-3">
                    <div class="flex flex-wrap items-center gap-2">
                      <button class="text-sm px-3 py-2 rounded-lg border border-ge-border bg-ge-bg text-white font-medium hover:border-ge-accent/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" onclick={() => continueRemainingPages()} disabled={isGenerating || !canContinue}>Continue</button>
                      <button class="text-sm px-3 py-2 rounded-lg border border-ge-accent/60 bg-ge-accent/10 text-white font-medium hover:bg-ge-accent/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" onclick={() => restartWithContext()} disabled={isGenerating || pages.length === 0}>Restart with context</button>
                      <button class="text-sm px-3 py-2 rounded-lg border border-ge-border bg-ge-bg text-white font-medium hover:border-ge-accent/50 transition-colors flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed" onclick={() => exportViaConversation()} disabled={isExporting}>{#if isExporting}<span class="animate-spin h-3.5 w-3.5 border-2 border-ge-accent border-t-transparent rounded-full"></span>{/if} Export (zip+pdf)</button>
                      <button class="text-sm px-3 py-2 rounded-lg border border-ge-border bg-ge-bg text-white font-medium hover:border-ge-accent/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" onclick={() => downloadCurrentHtml()} disabled={pages.length === 0 && !iframeSrcDoc}>Download HTML</button>
                    </div>
                    <div class="rounded-lg border border-ge-border bg-ge-bg px-3 py-2.5 flex flex-col gap-1">
                      <p class="text-sm font-semibold text-white">Conversation status</p>
                      <p class="text-sm text-neutral-300 font-mono break-all">{conversationId ? `Active: ${conversationId}` : 'No active conversation'}{#if canContinue} · can continue{/if}{#if lastStreamInterrupted} · interrupted{/if}{#if isGenerating} · streaming{/if}</p>
                      <p class="text-sm text-neutral-400">{pages.length} page{pages.length === 1 ? '' : 's'} · {pageGapCount} gap{pageGapCount === 1 ? '' : 's'} · {status}</p>
                    </div>
                    <div class="rounded-lg border border-ge-border bg-ge-bg px-3 py-2.5 flex flex-col gap-1">
                      <p class="text-sm font-semibold text-white">Recent errors</p>
                      {#if streamErrors.length === 0}
                        <p class="text-sm text-neutral-400">No recent errors</p>
                      {:else}
                        <ul class="flex flex-col gap-1.5 max-h-32 overflow-y-auto">
                          {#each streamErrors.slice(-5) as err, i (i)}
                            <li class="text-sm text-red-200 break-words leading-relaxed">{humanizeStreamError(err.code)}: {err.message}{err.code ? ` (code ${err.code})` : ''}</li>
                          {/each}
                        </ul>
                      {/if}
                      {#if wireNotices > 0}
                        <p class="text-sm text-neutral-400">{wireNotices} wire notice{wireNotices === 1 ? '' : 's'}</p>
                      {/if}
                    </div>
                  </div>
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    </div>
    <!-- R4: unmissable, non-blocking error surface (≥14px, white-on-dark, red accent) -->
    {#if streamErrors.length > 0}
      <div class="absolute top-4 left-4 right-4 z-30 flex flex-col gap-2 items-center pointer-events-none" role="alert" aria-live="assertive">
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
    <div
      class="flex-1 min-h-0 p-5 flex items-center justify-center overflow-hidden relative select-none"
      bind:clientWidth={stageBoxW}
      bind:clientHeight={stageBoxH}
    >
      <div
        class="stage-morph bg-[#131313] rounded-xl border border-ge-border overflow-hidden relative shadow-2xl"
        style={
          previewMode === 'slides'
            ? `width: ${SLIDE_LOGICAL_W * slideScale}px; height: ${SLIDE_LOGICAL_H * slideScale}px;`
            : previewMode === 'document'
              ? `width: ${DOC_LOGICAL_W * docScale}px; height: ${stageInnerH}px;`
              : 'max-width: 100%; width: min(100%, 960px); height: 100%;'
        }
      >
        <iframe
          title="Worksheet Preview"
          srcdoc={iframeSrcDoc}
          class="bg-[#131313]"
          style={
            previewMode === 'slides'
              ? `width: ${SLIDE_LOGICAL_W}px; height: ${SLIDE_LOGICAL_H}px; transform: scale(${slideScale}); transform-origin: top left; border: 0; display: block;`
              : previewMode === 'document'
                ? `width: ${DOC_LOGICAL_W}px; height: ${stageInnerH / docScale}px; transform: scale(${docScale}); transform-origin: top left; border: 0; display: block;`
                : 'width: 100%; height: 100%; border: 0; display: block;'
          }
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        ></iframe>

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

    <!-- Quiet Bottom Action Bar: slide stepper + edit/export actions -->
    <div class="h-14 border-t border-ge-border flex items-center justify-between px-6 bg-ge-card flex-shrink-0">
      <div class="flex items-center gap-2.5">
        <button
          class="text-sm px-3 py-1.5 bg-ge-bg border border-ge-border rounded-lg hover:border-ge-accent/50 text-neutral-300 hover:text-white transition-colors"
          onclick={toggleEditor}
        >
          {isEditingHtml ? 'Apply HTML' : 'Edit HTML'}
        </button>

        <button
          class="text-sm px-3 py-1.5 bg-ge-bg border border-ge-border rounded-lg hover:border-ge-accent/50 text-neutral-300 hover:text-white transition-colors flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          onclick={() => exportViaConversation()}
          disabled={isExporting}
          title={conversationId
            ? 'Export the full deck (HTML + PDF) from the server conversation — local fallback on failure'
            : 'Download the current page as HTML (no server conversation for this deck)'}
        >
          {#if isExporting}
            <span class="animate-spin h-3.5 w-3.5 border-2 border-ge-accent border-t-transparent rounded-full"></span>
          {:else}
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-ge-accent"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
          {/if}
          Export
        </button>
      </div>

      <div class="flex items-center gap-3.5">
        <button
          class="px-3.5 py-1.5 rounded-lg border border-ge-border bg-ge-bg hover:border-ge-accent/50 transition-colors text-sm disabled:opacity-40"
          disabled={selectedPageIndex <= 0}
          onclick={prevPage}
        >
          Prev
        </button>
        <span class="text-sm text-neutral-400 font-mono">
          Page {selectedPage ? selectedPageIndex + 1 : 1} of {Math.max(1, pages.length)}{#if pageGapCount > 0} · {pageGapCount} position{pageGapCount === 1 ? '' : 's'} not delivered{/if}
        </span>
        <button
          class="px-3.5 py-1.5 rounded-lg border border-ge-border bg-ge-bg hover:border-ge-accent/50 transition-colors text-sm disabled:opacity-40"
          disabled={selectedPageIndex >= pages.length - 1}
          onclick={nextPage}
        >
          Next
        </button>
      </div>
    </div>
  </div>

  <!-- API Key Modal -->
  {#if isApiKeyModalOpen}
  <div class="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
    <div class="bg-ge-card border border-ge-border rounded-xl shadow-2xl w-full max-w-md p-5 flex flex-col gap-4">
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
  <div class="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
    <div class="bg-ge-card border border-ge-border rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden">
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
