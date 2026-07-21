<script lang="ts">
  import { onMount, tick } from 'svelte';
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Carousel from "$lib/components/ui/carousel/index.js";

  import * as ChainOfThought from '$lib/components/ai-elements/chain-of-thought';
  import SvelteVirtualChat from '@humanspeak/svelte-virtual-chat';
  import SvelteMarkdown from '@humanspeak/svelte-markdown';



  let cost = $state(0.00);
  let isGenerating = $state(false);

  let isUploading = $state(false);
  let status = $state("Ready");

  let customApiKey = $state("");
  let customBaseUrl = $state("");
  let showApiSettings = $state(false);

  let slides = $state<{html: string, title: string}[]>([]);
  let currentSlideIndex = $state(0);
  // Included a mock RR button to prove the concept works when dropped in
  let iframeSrcDoc = $state("<html><body style='display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#131313;color:#888;font-family:sans-serif;margin:0;'><div style='text-align:center;'><h3>Zlides Preview</h3><p style='font-size:12px;color:#555;'>Your generated presentation will appear here.</p></div></body></html>");

  let promptText = $state("");
  let files = $state<FileList | null>(null);
  let extractedMarkdown = $state("");
  let uploadMode = $state("none"); // 'none', 'content', 'style', or 'reference'

  onMount(async () => {
    if (typeof localStorage !== 'undefined') {
      customApiKey = localStorage.getItem('zlides_api_key') || '';
      customBaseUrl = localStorage.getItem('zlides_base_url') || 'https://api.z.ai/api/v1/agents';
      accumulatedCost = parseFloat(localStorage.getItem('zlides_accumulated_cost') || '0');
      costResetDate = localStorage.getItem('zlides_cost_reset_date') || '';
      if (!costResetDate) {
        costResetDate = new Date().toLocaleString();
        localStorage.setItem('zlides_cost_reset_date', costResetDate);
      }
      try {
        costHistory = JSON.parse(localStorage.getItem('zlides_cost_history') || '[]');
      } catch (e) {
        costHistory = [];
      }
    }

    // Load styles from the backend
    try {
      const resp = await fetch("/styles");
      availableStyles = await resp.json();
    } catch (e) {
      console.warn("Could not load styles:", e);
    }

    // Load roles from the backend
    try {
      const resp = await fetch("/roles");
      availableRoles = await resp.json();
    } catch (e) {
      console.warn("Could not load roles:", e);
    }

    // Listen for RR format regeneration requests from the iframe
    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'regenerate') {
        status = `RR Event: Triggering regeneration with prompt: "${event.data.prompt}"`;
        // We'd pass this to the backend with the ongoing conversation_id to patch the slide
        setTimeout(() => {
          status = "Ready";
          // We'd postMessage back to the iframe to swap the HTML here
        }, 2000);
      }
    });
  });

  async function updateCost() {
    if (isGenerating) return;
    if (!promptText.trim() && !files && !extractedMarkdown) {
      if (slides.length === 0) {
        cost = 0;
      }
      return;
    }
    try {
      const res = await fetch("/estimate-cost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: promptText + (extractedMarkdown || ""),
          files_attached: files ? files.length : 0,
          format: apiFormat,
          page_count: pageCount
        })
      });
      const data = await res.json();
      cost = data.cost_usd;
    } catch (e) {
      console.error(e);
    }
  }

  $effect(() => {
    promptText;
    extractedMarkdown;
    files;
    apiFormat;
    pageCount;
    updateCost();
  });
  let forceBatchMode = $state(false);
  let isBatchMode = $derived(forceBatchMode || promptText.trim().startsWith("/batch"));

  async function handleFileSelect(e: Event) {
    const target = e.target as HTMLInputElement;
    if (target.files && target.files.length > 0) {
      files = target.files;
      if (uploadMode === "none") {
        extractedMarkdown = "";
        status = `File attached: ${files[0].name}`;
        updateCost();
        return;
      }
      isUploading = true;
      status = `Ingesting ${files[0].name} via File Parser API...`;

      const formData = new FormData();
      formData.append("file", files[0]);

      formData.append("type", uploadMode);
      if (customApiKey) {
        formData.append("api_key", customApiKey);
      }

      try {
        const res = await fetch("/upload", { method: "POST", body: formData });
        const data = await res.json();

        extractedMarkdown = data.parsed_markdown || "";

        if (data.style_extracted) {
          status = `Reverse engineered style "${data.style_extracted.name}" saved!`;
          // Dynamically add to availableStyles so it shows up in Style Theme dropdown instantly
          availableStyles = [
            ...availableStyles,
            {
              id: data.style_extracted.id,
              name: data.style_extracted.name,
              preview_colors: data.style_extracted.preview_colors || [],
              brand_png: data.style_extracted.brand_png
            }
          ];
          selectedStyle = data.style_extracted.id;
        } else if (uploadMode === "reference") {
          status = "Reference attached. Write your own prompt to create.";
        } else {
          status = "File parsed into Markdown. Ready to generate.";
        }
        updateCost();
      } catch (err) {
        status = "Upload / Parsing failed.";
      }
      isUploading = false;
    }
  }


  let isThinking = $state(false);
  let thoughts = $state<string[]>([]);

  let toolCalls = $state<{name: string, input: string}[]>([]);
  let currentToolBuffer = $state('');
  let currentToolName = $state('');

  let currentController = $state<AbortController | null>(null);
  interface LiveHtmlPage {
    position: number[];
    html: string;
  }
  let liveHtmlPages = $state<LiveHtmlPage[]>([]);
  let iframeElement = $state<HTMLIFrameElement | null>(null);
  let thinkingBuffer = $state('');

  // We'll define these fully in Step 3, but provide stubs to make TS happy
  let msgIdCounter = $state(0);
  function nextId() { return `msg-${++msgIdCounter}`; }
  let chatMessages = $state<any[]>([]);
  let selectedLayout = $state("slides");
  let selectedContentLayout = $state("auto");
  let selectedStyle = $state("auto");
  let selectedRole = $state("balanced");
  let pageCount = $state<number | null>(null);
  let availableStyles = $state<any[]>([]);
  let availableRoles = $state<any[]>([]);

  // Layout Shape options
  const layoutShapeOptions = [
    { id: "slides", name: "Slides" },
    { id: "document", name: "Document" },
    { id: "web page", name: "Web Page" }
  ];

  // Content Layout options
  const contentLayoutOptions = [
    { id: "auto", name: "Auto" },
    { id: "worksheet", name: "Worksheet" },
    { id: "report", name: "Report" },
    { id: "rr", name: "RR (RegenResource)" },
    { id: "swarm", name: "Swarm (Agent Test)" }
  ];

  let styleOptions = $derived([
    { id: "auto", name: "Auto" },
    ...availableStyles.filter(s => s.id !== "auto")
  ]);

  let roleOptions = $derived([
    { id: "balanced", name: "Balanced" },
    ...availableRoles.filter(r => r.id !== "balanced")
  ]);

  // Map to API values
  let apiStyle = $derived(selectedStyle);
  let apiFormat = $derived(
    selectedContentLayout !== "auto"
      ? selectedContentLayout
      : selectedLayout === "slides"
      ? "slides"
      : selectedLayout === "document"
      ? "report"
      : selectedLayout === "web page"
      ? "poster"
      : "slides"
  );

  let showStyleEditor = $state(false);
  let showAdvancedColors = $state(false);
  let showPreferences = $state(false);
  let preferencesText = $state("");
  let requestSystemPrompt = $state("");
  let showAdvancedPromptOptions = $state(false);
  let showPromptPreviewModal = $state(false);
  let isEditMode = $state(false);
  let showExportDropdown = $state(false);
  let showRecent = $state(false);
  let recentSlides = $state<any[]>([]);
  let chatViewport = $state<any>(null);

  // SvelteVirtualChat handles follow-bottom natively, so we don't need manual scrolling.
  let editingStyleId = $state("");
  let editingStyleName = $state("");
  let editingStylePromptHint = $state("");
  let editingStyleBg = $state("#ffffff");
  let editingStyleCard = $state("#f8f9fa");
  let editingStyleText = $state("#1e293b");
  let editingStyleAccent = $state("#2563eb");
  let editingStyleTextSecondary = $state("#64748b");
  let editingStyleBorder = $state("#e2e8f0");
  let editingStyleSuccess = $state("#16a34a");
  let editingStyleDanger = $state("#dc2626");
  let editingStyleAccentHover = $state("#1d4ed8");

  // Cost and Preview Management
  let accumulatedCost = $state(0.00);
  let costResetDate = $state("");
  let costHistory = $state<any[]>([]);
  let showCostHistory = $state(false);
  let previewSlideFile = $state<any>(null);

  function saveGenerationCost(prompt: string, finalCost: number) {
    accumulatedCost += finalCost;
    const newEntry = {
      id: nextId(),
      prompt: prompt || "Vibe generation",
      cost: finalCost,
      date: new Date().toLocaleString(),
    };
    costHistory = [newEntry, ...costHistory];
    
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('zlides_accumulated_cost', accumulatedCost.toString());
      localStorage.setItem('zlides_cost_history', JSON.stringify(costHistory));
    }
  }

  function resetAccumulatedCost() {
    accumulatedCost = 0.00;
    costResetDate = new Date().toLocaleString();
    costHistory = [];
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('zlides_accumulated_cost', '0');
      localStorage.setItem('zlides_cost_reset_date', costResetDate);
      localStorage.setItem('zlides_cost_history', '[]');
    }
  }

  function cyclePreview(direction: number) {
    if (!previewSlideFile || recentSlides.length <= 1) return;
    const idx = recentSlides.findIndex(s => s.filename === previewSlideFile.filename);
    if (idx === -1) return;
    let nextIdx = idx + direction;
    if (nextIdx < 0) nextIdx = recentSlides.length - 1;
    if (nextIdx >= recentSlides.length) nextIdx = 0;
    previewSlideFile = recentSlides[nextIdx];
  }

  async function loadPreviewedToWorkspace() {
    if (!previewSlideFile) return;
    await openRecentSlide(previewSlideFile.filename, previewSlideFile.title);
    previewSlideFile = null;
  }

  async function openStyleEditor() {
    if (selectedStyle === 'auto') return;
    try {
      status = "Loading style details...";
      const resp = await fetch(`/styles/${selectedStyle}`);
      if (!resp.ok) throw new Error("Failed to fetch style");
      const style = await resp.json();

      editingStyleId = style.id;
      editingStyleName = style.name;
      editingStylePromptHint = style.prompt_hint || "";
      editingStyleBg = style.css?.bg || "#ffffff";
      editingStyleCard = style.css?.card || "#f8f9fa";
      editingStyleText = style.css?.text || "#1e293b";
      editingStyleAccent = style.css?.accent || "#2563eb";
      editingStyleTextSecondary = style.css?.text_secondary || "#64748b";
      editingStyleBorder = style.css?.border || "#e2e8f0";
      editingStyleSuccess = style.css?.success || "#16a34a";
      editingStyleDanger = style.css?.danger || "#dc2626";
      editingStyleAccentHover = style.css?.accent_hover || "#1d4ed8";

      showStyleEditor = true;
      status = "Ready";
    } catch (e: any) {
      status = "Error: " + e.message;
    }
  }

  function createNewStyle() {
    editingStyleId = `custom-style-${Date.now()}`;
    editingStyleName = "My New Style";
    editingStylePromptHint = "Use a modern typography with clean layout. Define appropriate CSS colors.";
    editingStyleBg = "#ffffff";
    editingStyleCard = "#f8f9fa";
    editingStyleText = "#1e293b";
    editingStyleAccent = "#2563eb";
    editingStyleTextSecondary = "#64748b";
    editingStyleBorder = "#e2e8f0";
    editingStyleSuccess = "#16a34a";
    editingStyleDanger = "#dc2626";
    editingStyleAccentHover = "#1d4ed8";

    showStyleEditor = true;
  }

  async function saveStyle() {
    if (!editingStyleName.trim()) {
      alert("Style Name cannot be empty.");
      return;
    }
    try {
      status = "Saving style pack...";
      const stylePack = {
        id: editingStyleId,
        name: editingStyleName,
        prompt_hint: editingStylePromptHint,
        css: {
          bg: editingStyleBg,
          card: editingStyleCard,
          text: editingStyleText,
          text_secondary: editingStyleTextSecondary,
          accent: editingStyleAccent,
          accent_hover: editingStyleAccentHover,
          border: editingStyleBorder,
          success: editingStyleSuccess,
          danger: editingStyleDanger
        },
        preview_colors: [editingStyleBg, editingStyleCard, editingStyleAccent, editingStyleText]
      };

      const resp = await fetch("/styles/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ style: stylePack })
      });

      if (!resp.ok) throw new Error("Save failed");

      // Reload style list
      const listResp = await fetch("/styles");
      availableStyles = await listResp.json();

      selectedStyle = editingStyleId;
      showStyleEditor = false;
      status = `Style "${editingStyleName}" saved successfully!`;
    } catch (e: any) {
      status = "Save failed: " + e.message;
    }
  }

  async function deleteStyle() {
    if (editingStyleId === 'auto') return;
    if (!confirm(`Are you sure you want to delete the style "${editingStyleName}"?`)) return;

    try {
      status = "Deleting style...";
      const resp = await fetch(`/styles/${editingStyleId}`, {
        method: "DELETE"
      });

      if (!resp.ok) throw new Error("Delete failed");

      // Reload style list
      const listResp = await fetch("/styles");
      availableStyles = await listResp.json();

      selectedStyle = "auto";
      showStyleEditor = false;
      status = "Style deleted.";
    } catch (e: any) {
      status = "Delete failed: " + e.message;
    }
  }

  async function exportPdf(branded = false) {
    let filename = prompt("Enter a filename for the PDF:", "document.pdf");
    if (!filename) return; // User cancelled
    if (!filename.toLowerCase().endsWith('.pdf')) filename += '.pdf';
    
    status = branded ? "Generating branded PDF..." : "Generating print-friendly PDF...";
    try {
      let html = "";
      if (iframeElement?.contentDocument?.documentElement) {
        html = `<!DOCTYPE html>\n${iframeElement.contentDocument.documentElement.outerHTML}`;
      } else if (slides.length > 0) {
        html = slides[currentSlideIndex].html;
      } else {
        html = iframeSrcDoc;
      }
      if (!html) throw new Error("No HTML content available to export");

      const resp = await fetch("/export/pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html, print_mode: branded ? "branded" : "light" }),
      });
      if (!resp.ok) {
        throw new Error(await resp.text());
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      status = "PDF exported!";
    } catch (e: any) {
      status = "PDF export failed: " + e.message;
    }
  }

  function exportHtml() {
    let filename = prompt("Enter a filename for the HTML document:", "document.html");
    if (!filename) return; // User cancelled
    if (!filename.toLowerCase().endsWith('.html')) filename += '.html';
    
    let html = "";
    if (iframeElement?.contentDocument?.documentElement) {
      html = `<!DOCTYPE html>\n${iframeElement.contentDocument.documentElement.outerHTML}`;
    } else if (slides.length > 0) {
      html = slides[currentSlideIndex].html;
    } else {
      html = iframeSrcDoc;
    }
    
    if (!html) {
      status = "No HTML content available to export";
      return;
    }
    
    const blob = new Blob([html], { type: 'text/html' });
    const link = document.createElement('a');
    link.download = filename;
    link.href = URL.createObjectURL(blob);
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function startNewConversation() {
    try {
      status = "Clearing conversation context...";
      const resp = await fetch("/conversation/clear", { method: "POST" });
      if (resp.ok) {
        chatMessages = [{ id: nextId(), role: "agent", text: "Ready! New conversation started. Pick a format + style, describe what you want." }];
        liveHtmlPages = [];
        iframeSrcDoc = "";
        status = "Conversation cleared! Context token count reset.";
        setTimeout(() => {
          status = "Ready";
        }, 1500);
      } else {
        status = "Failed to clear conversation";
      }
    } catch (e) {
      console.error(e);
      status = "Error clearing conversation";
    }
  }

  async function openPreferences() {
    try {
      const resp = await fetch("/preferences");
      const data = await resp.json();
      preferencesText = data.content || "";
      showPreferences = true;
    } catch (e: any) {
      preferencesText = "";
      showPreferences = true;
    }
  }

  async function savePreferences() {
    try {
      await fetch("/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: preferencesText })
      });
      showPreferences = false;
    } catch (e: any) {
      status = "Failed to save preferences";
    }
  }

  async function loadRecent() {
    try {
      const resp = await fetch("/saved");
      recentSlides = await resp.json();
      showRecent = true;
    } catch (e: any) {
      recentSlides = [];
      showRecent = true;
    }
  }

  async function deleteRecentSlide(filename: string) {
    if (!confirm(`Are you sure you want to delete this slide?`)) return;
    try {
      const resp = await fetch(`/saved/${filename}`, { method: 'DELETE' });
      if (resp.ok) {
        recentSlides = recentSlides.filter(s => s.filename !== filename);
      }
    } catch (e: any) {
      console.error(e);
    }
  }

  async function openRecentSlide(filename: string, title: string) {
    try {
      const resp = await fetch(`/saved/${filename}`);
      const html = await resp.text();
      iframeSrcDoc = html;
      slides = [{ html, title }];
      currentSlideIndex = 0;
      showRecent = false;
    } catch (e: any) {
      status = "Failed to open slide";
    }
  }

  $effect(() => {
    if (isEditMode && iframeElement?.contentDocument?.body) {
      iframeElement.contentDocument.body.contentEditable = 'true';
      iframeElement.contentDocument.body.style.outline = '2px solid #ff6600';
      iframeElement.contentDocument.body.style.outlineOffset = '-2px';
    }
  });



  function toggleEditMode() {
    isEditMode = !isEditMode;
    if (iframeElement?.contentDocument?.body) {
      iframeElement.contentDocument.body.contentEditable = isEditMode ? 'true' : 'false';
      if (isEditMode) {
        iframeElement.contentDocument.body.style.outline = '2px solid #ff6600';
        iframeElement.contentDocument.body.style.outlineOffset = '-2px';
      } else {
        iframeElement.contentDocument.body.style.outline = 'none';
      }
    }
  }

  function captureEdits() {
    if (!iframeElement?.contentDocument) return;
    const editedHtml = '<!DOCTYPE html>\n' + iframeElement.contentDocument.documentElement.outerHTML;
    if (slides[currentSlideIndex]) {
      slides[currentSlideIndex].html = editedHtml;
      slides = [...slides];
    }
    isEditMode = false;
    if (iframeElement.contentDocument.body) {
      iframeElement.contentDocument.body.contentEditable = 'false';
      iframeElement.contentDocument.body.style.outline = 'none';
    }
  }

  function applyEditsEverywhere() {
    if (!iframeElement?.contentDocument) return;
    const editedHtml = '<!DOCTYPE html>\n' + iframeElement.contentDocument.documentElement.outerHTML;
    captureEdits();
    promptText = `I manually edited slide ${currentSlideIndex + 1}. Here is my edited version:\n\n<EDITED_SLIDE>\n${editedHtml}\n</EDITED_SLIDE>\n\nLook at the edits I made to this slide and apply the same style/layout changes to ALL other slides in the presentation. Maintain the same visual consistency.`;
    status = "Edit captured — review prompt and hit send to apply everywhere";
  }

  function getAssembledPrompt() {
    const roleObj = availableRoles.find(r => r.id === selectedRole) || { prompt: "You are an expert graphic designer, curriculum developer, and professional presentations editor. You specialize in designing high-quality, beautiful, and semantic HTML layouts for slides, posters, reports, and interactive worksheets. Your designs are modern, clean, print-friendly, and visually outstanding." };
    
    let formatText = "";
    if (apiFormat === "slides") {
      formatText = "Create a multi-slide HTML presentation. Use <section> tags for each slide with page-break-after CSS. Include a title slide, content slides, and a closing slide as appropriate.";
    } else if (apiFormat === "poster") {
      formatText = "Create a single-page HTML poster. Everything visible on one screen/page. Eye-catching, visual, information-dense.";
    } else if (apiFormat === "worksheet") {
      formatText = "Create an HTML worksheet with exercises, fill-in-the-blank, matching, or short answer sections. Include numbered exercises with clear instructions. Use HTML form elements (input, checkbox) for interactive fields but NO <script> tags — any interactivity must be CSS-only.";
    } else if (apiFormat === "report") {
      formatText = "Create an HTML document/report. Structured with headings, paragraphs, lists, and tables as needed. Professional document layout suitable for printing.";
    } else if (apiFormat === "rr") {
      formatText = "Create an interactive HTML learning resource. You must identify specific content items (e.g. exercise questions, example sentences, vocabulary lists, practice prompts) that should be dynamic and refreshable. For each refreshable item, adhere to this strict HTML structural layout: (1) Wrap the entire item module in a parent container with the class 'card' or 'exercise-card'. (2) Inside that card, wrap the specific content block to be replaced in an inner container with class='question-item' or an id attribute ending in '-container' (e.g., id='sentence-1-container'). (3) Place a button with class='regenerate-btn' (or an id starting with 'regenerate') inside the card, containing a detailed data-prompt attribute specifying exactly how to regenerate that specific block of content. Do NOT inject script tags, inline onclick handlers, or styles that target parent layouts. Keep the HTML clean, semantic, and layout-agnostic so that the host portal can bind click listeners dynamically.";
    }

    let base = `${roleObj.prompt}\n\nCreate a ${apiFormat} (HTML format).\n\n${formatText}`;
    
    if (preferencesText) {
      base += `\n\n--- USER PREFERENCES (follow these closely) ---\n${preferencesText}`;
    }
    
    if (selectedStyle && selectedStyle !== "auto") {
      const style = availableStyles.find(s => s.id === selectedStyle);
      if (style) {
        base += `\n\nStyle: ${style.prompt_hint || style.name || selectedStyle}`;
        if (style.css) {
          base += `\n\nCRITICAL COLOR PALETTE INSTRUCTIONS:\nYou must explicitly use these exact hex colors in your inline CSS styling:\n`;
          for (const [k, v] of Object.entries(style.css)) {
            base += `- ${k}: ${v}\n`;
          }
        }
      }
    }
    
    base += `\n\n--- PRINT-FRIENDLY OUTPUT RULES ---\nYour HTML will be printed and exported to PDF. Follow these rules:\n- Use page-break-inside: avoid on cards, sections, and self-contained content blocks.\n- Avoid fixed pixel heights on containers that should grow with content.\n- Prefer relative units (em, %, vh) over large fixed pixel dimensions.\n- Ensure text remains readable if backgrounds are removed (sufficient contrast).\n`;
    
    if (pageCount) {
      base += `\nCRITICAL: MUST create exactly ${pageCount} ${apiFormat === 'slides' ? 'slides' : 'sections'}.`;
    }
    
    let userMsg = promptText + (extractedMarkdown ? "\n\n" + extractedMarkdown : "");
    if (requestSystemPrompt) {
      userMsg = `${requestSystemPrompt}\n\n${userMsg}`;
    }
    
    base += `\n\nUSER REQUEST:\n${userMsg}`;
    return base;
  }


  function extractImages(thought: string) {
    const images = [];
    const regex = /!\[(.*?)\]\((.*?)\)/g;
    let match;
    while ((match = regex.exec(thought)) !== null) {
      images.push({ alt: match[1], url: match[2] });
    }
    return images;
  }

  function stripImages(thought: string) {
    return thought.replace(/!\[(.*?)\]\((.*?)\)/g, '').trim();
  }


  function renderLiveHtmlChunks() {
    const sortedPages = [...liveHtmlPages].sort((a, b) => {
      const len = Math.min(a.position.length, b.position.length);
      for (let i = 0; i < len; i++) {
        if (a.position[i] !== b.position[i]) {
          return a.position[i] - b.position[i];
        }
      }
      return a.position.length - b.position.length;
    });

    const combined = sortedPages.map(p => p.html).join('')
        .replace(/\\n/g, '\n').replace(/\\"/g, '"');
        
    try {
        const doc = iframeElement?.contentDocument;
        if (doc) {
            const prevScroll = doc.documentElement?.scrollTop || doc.body?.scrollTop || 0;
            doc.open();
            doc.write(combined);
            doc.close();
            if (doc.documentElement) doc.documentElement.scrollTop = prevScroll;
            if (doc.body) doc.body.scrollTop = prevScroll;
        } else {
            iframeSrcDoc = combined;
        }
    } catch(e) {
        iframeSrcDoc = combined;
    }
    status = `Streaming... (${liveHtmlPages.length} pages)`;
  }

  function addMessage(text: string, role: string) {
    chatMessages = [...chatMessages, { id: nextId(), role, text }];
  }

  function stopRequest() {
    if (currentController) {
      currentController.abort();
      status = 'Stopping...';
    }
  }

  async function generate() {
    if (!promptText.trim() && !extractedMarkdown) return;
    isGenerating = true;

    if (isBatchMode) {
      status = "Batch Scheduling... (Semaphore limited)";
      const prompts = promptText.split(/\n\n+/).filter(p => p.trim());
      try {
        const res = await fetch("/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            prompts, 
            format: apiFormat,
            style: apiStyle,
            role: selectedRole,
            page_count: pageCount || undefined
          })
        });
        const data = await res.json();
        status = `Batch completed! ${data.results.length} processed.`;
      } catch (e) {
        status = "Batch failed.";
      }
      isGenerating = false;
      return;
    }

    const textToSend = promptText;
    promptText = "";
    status = "Generating...";
    addMessage(`[${apiFormat} / ${apiStyle}] ${textToSend}`, 'user');

    let costSavedForThisRun = false;
    const finalPrompt = textToSend || (files ? `Uploaded: ${files[0].name}` : "Vibe generation");

    // Estimate input cost dynamically
    const combinedInputText = textToSend + (extractedMarkdown ? "\n\n" + extractedMarkdown : "");
    const estimatedInputTokens = (combinedInputText.split(/\s+/).filter(Boolean).length) * 1.5 + (files ? files.length * 3000 : 0);
    const inputCostRmb = (estimatedInputTokens / 1000000.0) * 0.8;
    const initialInputCost = inputCostRmb * 2.5 * 0.14;
    cost = initialInputCost;
    let totalOutputChars = 0;

    currentController = new AbortController();
    liveHtmlPages = [];
    thinkingBuffer = '';
    thoughts = [];
    toolCalls = [];
    currentToolBuffer = '';
    currentToolName = '';
    isThinking = true;

    try {
      const response = await fetch('/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: textToSend + (extractedMarkdown ? "\n\n" + extractedMarkdown : ""),
          format: apiFormat,
          style: apiStyle,
          role: selectedRole,
          system_prompt: requestSystemPrompt || undefined,
          page_count: pageCount,
          api_key: customApiKey || undefined,
          base_url: customBaseUrl || undefined,
        }),
        signal: currentController.signal
      });

      if (!response.ok) throw new Error("Server error: " + response.status);

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data:')) {
              const dataStr = line.substring(5).trim();
              if (!dataStr || dataStr === '[DONE]') continue;

              try {
                const data = JSON.parse(dataStr);

                // Accumulate output characters for live cost ticker
                let chunkChars = 0;
                const textContent = data.text || data.content || '';
                if (textContent) chunkChars += textContent.length;
                if (data.html && data.type !== 'final_html') chunkChars += data.html.length;
                
                if (chunkChars > 0) {
                  totalOutputChars += chunkChars;
                  const liveOutputTokens = totalOutputChars / 2.5;
                  const outputCostRmb = (liveOutputTokens / 1000000.0) * 2.0;
                  const liveOutputCost = outputCostRmb * 2.5 * 0.14;
                  cost = initialInputCost + liveOutputCost;
                }

                if (data.type === 'thinking') {
                  thinkingBuffer += textContent;

                  // Batch thoughts by paragraph (double newline) or at 150+ chars on a single newline
                  const paragraphBreak = thinkingBuffer.indexOf('\n\n');
                  const singleBreak = thinkingBuffer.lastIndexOf('\n');
                  if (paragraphBreak !== -1) {
                    const batch = thinkingBuffer.substring(0, paragraphBreak).trim();
                    if (batch) thoughts = [...thoughts, batch];
                    thinkingBuffer = thinkingBuffer.substring(paragraphBreak + 2);
                  } else if (thinkingBuffer.length > 150 && singleBreak !== -1) {
                    const batch = thinkingBuffer.substring(0, singleBreak).trim();
                    if (batch) thoughts = [...thoughts, batch];
                    thinkingBuffer = thinkingBuffer.substring(singleBreak + 1);
                  }
                }

                                if (data.type === 'tool') {
                  if (data.tool_name) {
                     // Flush previous
                     if (currentToolName && currentToolBuffer) {
                         toolCalls = [...toolCalls, { name: currentToolName, input: currentToolBuffer }];
                     }
                     currentToolName = data.tool_name;
                     currentToolBuffer = data.input || '';
                  } else if (data.input) {
                     currentToolBuffer += data.input;
                  }

                  // In some stream representations it comes in as raw tool blocks, just handle generic JSON representations
                  try {
                      if (data.text) {
                         let parsed = JSON.parse(data.text);
                         if (parsed.tool_name) {
                             toolCalls = [...toolCalls, { name: parsed.tool_name, input: parsed.input || '' }];
                         }
                      }
                  } catch (e) {}
                }

                if (data.type === 'answer' || data.type === 'slide_page' || data.type === 'final_html' || data.type === 'error') {
                   // Flush pending tool
                   if (currentToolName && currentToolBuffer) {
                       toolCalls = [...toolCalls, { name: currentToolName, input: currentToolBuffer }];
                       currentToolName = '';
                       currentToolBuffer = '';
                   }
                }

                if (data.type === 'answer') {
                  if (thinkingBuffer.trim()) {
                    thoughts = [...thoughts, thinkingBuffer.trim()];
                    thinkingBuffer = '';
                  }
                  isThinking = false;

                  const lastMsg = chatMessages[chatMessages.length - 1];
                  const answerText = data.text || data.content || '';
                  if (lastMsg && lastMsg.role === 'agent') {
                    lastMsg.text += answerText;
                    chatMessages = [...chatMessages];
                  } else {
                    addMessage(answerText, 'agent');
                  }
                }

                if (data.type === 'slide_page') {
                  if (thinkingBuffer.trim()) {
                    thoughts = [...thoughts, thinkingBuffer.trim()];
                    thinkingBuffer = '';
                  }
                  if (data.tool) {
                    toolCalls = [...toolCalls, { name: data.tool, input: `Render slide page at position ${data.position || ''}` }];
                  }
                  const pos = data.position || [0];
                  const existingIdx = liveHtmlPages.findIndex(p => JSON.stringify(p.position) === JSON.stringify(pos));
                  if (existingIdx !== -1) {
                    liveHtmlPages[existingIdx].html = data.html || '';
                  } else {
                    liveHtmlPages = [...liveHtmlPages, { position: pos, html: data.html || '' }];
                  }
                  renderLiveHtmlChunks();
                }

                if (data.type === 'slide_remove') {
                  console.log("Removing slides at positions:", data.positions);
                  if (data.tool) {
                    toolCalls = [...toolCalls, { name: data.tool, input: `Remove slides at positions ${data.positions || ''}` }];
                  }
                  const posToRemove = data.positions || (data.position ? [data.position] : []);
                  liveHtmlPages = liveHtmlPages.filter(p => {
                    return !posToRemove.some((rem: any) => JSON.stringify(rem) === JSON.stringify(p.position));
                  });
                  renderLiveHtmlChunks();
                }

                if (data.type === 'slide_replace') {
                  if (thinkingBuffer.trim()) {
                    thoughts = [...thoughts, thinkingBuffer.trim()];
                    thinkingBuffer = '';
                  }
                  if (data.tool) {
                    toolCalls = [...toolCalls, { name: data.tool, input: `Replace slide at position ${data.position || ''}` }];
                  }
                  const pos = data.position || [0];
                  const existingIdx = liveHtmlPages.findIndex(p => JSON.stringify(p.position) === JSON.stringify(pos));
                  if (existingIdx !== -1) {
                    liveHtmlPages[existingIdx].html = data.html || '';
                  } else {
                    liveHtmlPages = [...liveHtmlPages, { position: pos, html: data.html || '' }];
                  }
                  renderLiveHtmlChunks();
                }

                if (data.type === 'slide_navigate') {
                  if (data.position && data.position.length > 0) {
                    currentSlideIndex = Math.max(0, data.position[0] - 1);
                  }
                  if (data.tool) {
                    toolCalls = [...toolCalls, { name: data.tool, input: `Navigate to position ${data.position || ''}` }];
                  }
                }

                if (data.type === 'final_html') {
                  if (thinkingBuffer.trim()) {
                    thoughts = [...thoughts, thinkingBuffer.trim()];
                    thinkingBuffer = '';
                  }

                  isThinking = false;

                  const html = data.html;
                  iframeSrcDoc = html;
                  slides = [...slides, { html, title: textToSend }];
                  currentSlideIndex = slides.length - 1;
                  addMessage('Done! Your slides are ready to view.', 'agent');
                  status = 'Done!';

                  isGenerating = false;
                  currentController = null;
                  return;
                }

                if (data.type === 'error') {
                  if (thinkingBuffer.trim()) {
                    thoughts = [...thoughts, thinkingBuffer.trim()];
                    thinkingBuffer = '';
                  }

isThinking = false;
                  addMessage('Error: ' + data.text, 'agent');
                  status = 'Error';
                }
              } catch (e) {}
            }
          }
        }
      }
      status = 'Done';
    } catch (err: any) {
      if (err.name === 'AbortError') {
        status = 'Stopped';
isThinking = false;
      } else {
        status = 'Error: ' + err.message;
        addMessage('Connection error — is the server running?', 'agent');
      }
    } finally {
      isGenerating = false;
      currentController = null;
      if (!costSavedForThisRun && cost > 0) {
        saveGenerationCost(finalPrompt, cost);
        costSavedForThisRun = true;
      }
    }
  }
</script>

<main class="min-h-screen bg-ge-bg text-ge-text flex flex-col md:flex-row h-screen overflow-hidden">

  <div class="w-full md:w-[560px] p-4 flex flex-col gap-3 bg-ge-card border-r border-ge-border shadow-2xl z-10 flex-shrink-0 relative overflow-hidden">
    <div class="flex-shrink-0 flex items-center justify-between border-b border-ge-border/30 pb-3 mb-1">
      <div class="flex flex-col gap-0.5">
        <div class="flex items-end gap-2.5">
          <h1 class="text-2xl font-bold tracking-tight text-ge-accent font-raleway select-none leading-none">
            Zlides
          </h1>
          <span class="text-[10px] font-mono text-ge-text-muted/70 italic tracking-wider mb-0.5 select-none">Drop vibes. Get Zlides.</span>
        </div>
        <div class="flex items-center gap-3 mt-3">
          <button on:click={startNewConversation} class="p-2 rounded-lg bg-ge-card border border-ge-border text-ge-text-muted hover:text-ge-accent hover:border-ge-accent shadow-sm transition-all flex items-center justify-center" title="Reset Conversation">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
          </button>
          <button on:click={loadRecent} class="p-2 rounded-lg bg-ge-card border border-ge-border text-ge-text-muted hover:text-ge-accent hover:border-ge-accent shadow-sm transition-all" title="Recent Files">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>
          </button>
          <button on:click={openPreferences} class="p-2 rounded-lg bg-ge-card border border-ge-border text-ge-text-muted hover:text-ge-text hover:border-ge-text shadow-sm transition-all" title="Preferences">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>
          </button>
          <button on:click={() => showApiSettings = true} class="p-2 rounded-lg bg-ge-card border border-ge-border text-ge-text-muted hover:text-ge-text hover:border-ge-text shadow-sm transition-all" title="API Settings">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
        </div>
      </div>

      <!-- Price Estimator Card with history toggle -->
      <button 
        on:click|stopPropagation={() => showCostHistory = !showCostHistory}
        class="bg-ge-bg/70 hover:bg-ge-bg/95 border border-ge-border/40 rounded px-2.5 py-1 flex flex-col items-end min-w-[90px] shadow-inner select-none transition-all group relative cursor-pointer text-right outline-none focus:outline-none"
        title="Click to view full cost history"
      >
        <span class="text-[7px] font-bold uppercase tracking-widest font-mono text-ge-text-muted leading-none">Total / Run</span>
        <div class="flex items-baseline gap-1 mt-0.5 leading-none">
          <span class="text-xs font-bold font-mono text-ge-success">${accumulatedCost.toFixed(4)}</span>
          <span class="text-[9px] font-mono text-ge-text-muted">(${cost.toFixed(4)})</span>
        </div>
      </button>
    </div>

    <!-- UI Controls -->
    <div class="flex flex-col gap-2 flex-shrink-0 text-xs">
      <div class="grid grid-cols-2 gap-3">
        <!-- Type -->
        <div class="flex flex-col gap-1">
          <div class="flex items-center bg-ge-bg border border-ge-border rounded px-1 py-1 focus-within:border-ge-accent relative cursor-pointer" title="Page size/shape aspect ratio">
            <select bind:value={selectedLayout} class="bg-transparent border-none text-ge-text outline-none focus:outline-none focus:ring-0 cursor-pointer w-full text-[10px] p-0.5 font-semibold uppercase tracking-wider text-center">
              <option value="" disabled hidden>SHAPE</option>
              {#each layoutShapeOptions as opt}
                <option value={opt.id} class="bg-ge-card text-ge-text">{opt.name}</option>
              {/each}
            </select>
          </div>
        </div>

        <!-- Layout -->
        <div class="flex flex-col gap-1">
          <div class="flex items-center bg-ge-bg border border-ge-border rounded px-1 py-1 focus-within:border-ge-accent relative cursor-pointer" title="Content layout structure within the page">
            <select bind:value={selectedContentLayout} class="bg-transparent border-none text-ge-text outline-none focus:outline-none focus:ring-0 cursor-pointer w-full text-[10px] p-0.5 font-semibold uppercase tracking-wider text-center">
              <option value="" disabled hidden>LAYOUT</option>
              {#each contentLayoutOptions as opt}
                <option value={opt.id} class="bg-ge-card text-ge-text">{opt.name}</option>
              {/each}
            </select>
          </div>
        </div>

        <!-- Style Selector -->
        <div class="flex flex-col gap-1">
          <div class="flex items-center bg-ge-bg border border-ge-border rounded px-1 py-1 focus-within:border-ge-accent relative cursor-pointer" title="Visual Style Theme">
            <select bind:value={selectedStyle} class="bg-transparent border-none text-ge-text outline-none focus:outline-none focus:ring-0 cursor-pointer w-full text-[10px] p-0.5 font-semibold uppercase tracking-wider text-center">
              <option value="" disabled hidden>STYLE</option>
              {#each styleOptions as opt}
                <option value={opt.id} class="bg-ge-card text-ge-text">{opt.name}</option>
              {/each}
            </select>
          </div>
        </div>

        <!-- Personality / Role Selector -->
        <div class="flex flex-col gap-1">
          <div class="flex items-center bg-ge-bg border border-ge-border rounded px-1 py-1 focus-within:border-ge-accent relative cursor-pointer" title="AI Graphic Designer Persona">
            <select bind:value={selectedRole} class="bg-transparent border-none text-ge-text outline-none focus:outline-none focus:ring-0 cursor-pointer w-full text-[10px] p-0.5 font-semibold uppercase tracking-wider text-center">
              <option value="" disabled hidden>PERSONA</option>
              {#each roleOptions as opt}
                <option value={opt.id} class="bg-ge-card text-ge-text">{opt.name}</option>
              {/each}
            </select>
          </div>
        </div>
      </div>
    </div>

    <!-- Chat + Input: one continuous surface -->
    <div class="flex-grow min-h-0 flex flex-col rounded-lg border border-ge-border/40 relative text-sm overflow-hidden bg-ge-bg/30">
      <div class="flex-grow min-h-0">
        <SvelteVirtualChat
          bind:this={chatViewport}
          messages={chatMessages}
          getMessageId={(msg) => msg.id}
          estimatedMessageHeight={80}
          containerClass="h-full bg-transparent"
          viewportClass="h-full px-3 py-2 space-y-3.5"
        >
          {#snippet renderMessage(msg)}
            {#if msg.role !== 'thinking'}
              <div class="p-2.5 rounded-lg max-w-[85%] {msg.role === 'user' ? 'bg-ge-card text-ge-text ml-auto border border-ge-border/60 shadow-sm whitespace-pre-wrap' : 'bg-ge-bg/55 text-ge-text mr-auto border border-ge-border/30'}">
                {#if msg.role !== 'user'}
                  <div class="text-[9px] font-mono font-bold mb-1 text-ge-accent uppercase tracking-wider select-none">Z.AI Agent</div>
                  <div class="text-xs prose prose-invert prose-xs max-w-none text-ge-text leading-relaxed">
                    <SvelteMarkdown source={msg.text} />
                  </div>
                {:else}
                  <div class="text-ge-text text-xs">{msg.text}</div>
                {/if}
              </div>
            {/if}
          {/snippet}

          {#snippet footer()}
            {#if thoughts.length > 0 || isThinking}
              <div class="p-2 rounded w-full min-w-0 overflow-hidden bg-transparent text-ge-text-muted mr-auto">
                <ChainOfThought.Root open={true} defaultOpen={true}>
                  <ChainOfThought.Header />
                  <ChainOfThought.Content>
                    {#each thoughts as thought, i}
                      <ChainOfThought.Step
                        label={stripImages(thought) || "Looking at image..."}
                        status={i === thoughts.length - 1 && isThinking ? "active" : "complete"}
                      >
                        {#each extractImages(thought) as img}
                          <ChainOfThought.Image caption={img.alt}>
                            <img src={img.url} alt={img.alt} class="w-full h-auto rounded" />
                          </ChainOfThought.Image>
                        {/each}
                      </ChainOfThought.Step>
                    {/each}

                    {#if toolCalls.length > 0}
                      <ChainOfThought.SearchResults class="mt-2">
                        {#each toolCalls as call}
                          <ChainOfThought.SearchResult>{call.name}: {call.input.length > 20 ? call.input.substring(0,20)+'...' : call.input}</ChainOfThought.SearchResult>
                        {/each}
                      </ChainOfThought.SearchResults>
                    {/if}
                    {#if isThinking && thoughts.length === 0}
                      <ChainOfThought.Step label="Initializing thought process..." status="active" />
                    {/if}
                    {#if isGenerating && !isThinking}
                      <div class="flex items-center gap-2 text-ge-text-muted text-xs py-2">
                        <span class="animate-spin h-3 w-3 border-2 border-ge-accent border-t-transparent rounded-full"></span>
                        <span>Generating slides...</span>
                      </div>
                    {/if}
                  </ChainOfThought.Content>
                </ChainOfThought.Root>
              </div>
            {/if}
          {/snippet}
        </SvelteVirtualChat>
      </div>

      <div class="flex flex-col bg-ge-bg/30 border-t border-ge-border/30 p-2.5 relative min-h-[140px] flex-shrink-0">
        <!-- Advanced Collapsible Toggle -->
        <div class="flex justify-between items-center mb-1 text-[9px] select-none text-ge-text-muted font-bold tracking-wider font-mono">
          <button 
            on:click={() => showAdvancedPromptOptions = !showAdvancedPromptOptions} 
            class="hover:text-ge-text transition-colors flex items-center gap-1 cursor-pointer uppercase"
          >
            <svg class="transition-transform duration-200" class:rotate-90={showAdvancedPromptOptions} xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m9 18 6-6-6-6"/></svg>
            <span>One-Shot System Prompt</span>
          </button>
          
          {#if showAdvancedPromptOptions}
            <button 
              on:click={() => showPromptPreviewModal = true} 
              class="hover:text-ge-accent transition-colors flex items-center gap-1 cursor-pointer uppercase"
            >
              <span>[Preview Assembled Prompt]</span>
            </button>
          {/if}
        </div>

        {#if showAdvancedPromptOptions}
          <div class="mb-2.5 border-b border-ge-border/20 pb-2">
            <textarea
              bind:value={requestSystemPrompt}
              placeholder="Inject custom system rules for THIS run only (e.g. 'Use 3-column layouts. Keep paragraphs extremely short.')"
              class="w-full h-12 bg-ge-bg/60 border border-ge-border/40 rounded p-1.5 outline-none focus:border-ge-accent text-[11px] font-mono text-ge-text resize-none placeholder:text-ge-text-muted/40"
            ></textarea>
          </div>
        {/if}

        <textarea
          bind:value={promptText}
          on:keydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generate(); } }}
          placeholder="Describe your vibe... (e.g. 'Turn this uploaded PDF into slides.')"
          class="w-full flex-grow bg-transparent border-none outline-none resize-none p-1 pb-10 text-ge-text placeholder:text-ge-text-muted/50 text-sm"
        ></textarea>

        <!-- Floating action buttons at the bottom of the input container -->
        <div class="absolute bottom-2 left-2 right-2 flex justify-between items-center pointer-events-none">
           <div class="flex items-center gap-1.5 pointer-events-auto">
             <label class="cursor-pointer p-1.5 rounded bg-ge-card hover:bg-ge-border text-ge-text hover:text-ge-accent border border-ge-border transition-colors disabled:opacity-50 flex items-center justify-center h-7 w-7" title="Ingest Document or Style Image" class:opacity-50={isUploading}>
               {#if isUploading}
                 <span class="animate-spin h-3.5 w-3.5 border-2 border-ge-accent border-t-transparent rounded-full"></span>
               {:else}
                 <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
               {/if}
               <input type="file" class="hidden" on:change={handleFileSelect} accept=".pdf,.png,.jpg,.jpeg,.doc,.docx,.apkg,.zip,.txt,.md,.csv" disabled={isUploading} />
             </label>

             <select bind:value={uploadMode} class="bg-ge-card border border-ge-border rounded px-1.5 py-0.5 text-[10px] text-ge-text-muted outline-none focus:border-ge-accent cursor-pointer h-7 select-none">
               <option value="none" class="bg-ge-card text-ge-text">No Selection</option>
               <option value="content" class="bg-ge-card text-ge-text">Remake Content</option>
               <option value="style" class="bg-ge-card text-ge-text">Harvest Style</option>
               <option value="reference" class="bg-ge-card text-ge-text">Reference</option>
             </select>

             <div class="flex items-center gap-1 bg-ge-card border border-ge-border rounded px-1.5 h-7">
               <span class="text-[10px] text-ge-text-muted font-bold select-none uppercase tracking-wider font-mono">Pages:</span>
               <input type="number" bind:value={pageCount} min="1" max="20" placeholder="Auto" class="bg-transparent border-none text-ge-text outline-none focus:outline-none focus:ring-0 w-12 text-[11px] font-semibold text-center placeholder:text-ge-text-muted/65 p-0" title="Number of Pages">
             </div>

             <label class="flex items-center gap-1.5 bg-ge-card border border-ge-border rounded px-2 h-7 cursor-pointer hover:bg-ge-border/50 transition-colors">
               <input type="checkbox" bind:checked={forceBatchMode} class="w-3 h-3 accent-ge-accent bg-transparent border-ge-border cursor-pointer">
               <span class="text-[10px] text-ge-text-muted font-bold select-none uppercase tracking-wider font-mono">Batch</span>
             </label>
           </div>

            <div class="flex items-center justify-end gap-2 pointer-events-auto shrink-0 min-w-0">
              {#if files}
                <span class="text-[11px] bg-ge-card border border-ge-border px-2 py-0.5 rounded text-ge-accent truncate max-w-[120px] min-w-[30px] shrink block" title={files[0].name}>{files[0].name}</span>
              {/if}
              {#if isGenerating}
                <button on:click={stopRequest} class="bg-ge-danger text-ge-bg font-bold px-3 py-1 rounded text-xs hover:opacity-90 transition-all flex items-center gap-1 h-7 animate-pulse">
                  <span class="h-1.5 w-1.5 bg-ge-bg rounded-sm"></span> Stop
                </button>
              {:else}
                <button
                  on:click={generate}
                  disabled={!promptText.trim() && !extractedMarkdown}
                  class="bg-ge-accent text-ge-bg rounded flex items-center justify-center h-7 w-7 hover:opacity-90 transition-all disabled:opacity-50 border border-ge-border/20 shadow-sm"
                  title="Send Command"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                </button>
              {/if}
            </div>
        </div>
      </div>
    </div>

      {#if showStyleEditor}
        <div class="absolute inset-0 bg-ge-card flex flex-col p-4 z-20 overflow-y-auto border-r border-ge-border">
          <div class="flex items-center justify-between border-b border-ge-border pb-2 mb-3">
            <h2 class="text-sm font-bold text-ge-accent font-raleway">Style Settings</h2>
            <button on:click={() => showStyleEditor = false} class="text-ge-text-muted hover:text-ge-accent text-xs font-bold">Close</button>
          </div>

          <div class="flex flex-col gap-3 text-xs flex-grow">
            <div class="flex flex-col gap-1">
              <label class="text-[10px] font-mono uppercase tracking-wider text-ge-text-muted font-bold">Style ID</label>
              <input type="text" bind:value={editingStyleId} disabled class="bg-ge-bg border border-ge-border rounded p-1.5 outline-none text-ge-text opacity-60 font-mono text-[10px]" />
            </div>

            <div class="flex flex-col gap-1">
              <label class="text-[10px] font-mono uppercase tracking-wider text-ge-text-muted font-bold">Style Name</label>
              <input type="text" bind:value={editingStyleName} placeholder="e.g. GitEnglish Hub" class="bg-ge-bg border border-ge-border rounded p-1.5 outline-none text-ge-text focus:border-ge-accent" />
            </div>

            <div class="flex flex-col gap-1">
              <label class="text-[10px] font-mono uppercase tracking-wider text-ge-text-muted font-bold">AI Prompt Hint</label>
              <textarea bind:value={editingStylePromptHint} rows="4" placeholder="Instructions for the AI slide agent on colors, layouts..." class="bg-ge-bg border border-ge-border rounded p-1.5 outline-none text-ge-text resize-y focus:border-ge-accent placeholder:text-ge-text-muted/40 font-mono text-[11px]"></textarea>
            </div>

            <div class="grid grid-cols-2 gap-2 mt-1">
              <div class="flex flex-col gap-1">
                <label class="text-[10px] font-mono uppercase tracking-wider text-ge-text-muted font-bold">Background</label>
                <div class="flex items-center gap-1.5">
                  <input type="color" bind:value={editingStyleBg} class="h-6 w-6 rounded border border-ge-border bg-transparent cursor-pointer p-0" />
                  <input type="text" bind:value={editingStyleBg} class="bg-ge-bg border border-ge-border rounded p-1 outline-none text-ge-text text-center w-full font-mono text-[10px]" />
                </div>
              </div>

              <div class="flex flex-col gap-1">
                <label class="text-[10px] font-mono uppercase tracking-wider text-ge-text-muted font-bold">Card Background</label>
                <div class="flex items-center gap-1.5">
                  <input type="color" bind:value={editingStyleCard} class="h-6 w-6 rounded border border-ge-border bg-transparent cursor-pointer p-0" />
                  <input type="text" bind:value={editingStyleCard} class="bg-ge-bg border border-ge-border rounded p-1 outline-none text-ge-text text-center w-full font-mono text-[10px]" />
                </div>
              </div>

              <div class="flex flex-col gap-1">
                <label class="text-[10px] font-mono uppercase tracking-wider text-ge-text-muted font-bold">Text Color</label>
                <div class="flex items-center gap-1.5">
                  <input type="color" bind:value={editingStyleText} class="h-6 w-6 rounded border border-ge-border bg-transparent cursor-pointer p-0" />
                  <input type="text" bind:value={editingStyleText} class="bg-ge-bg border border-ge-border rounded p-1 outline-none text-ge-text text-center w-full font-mono text-[10px]" />
                </div>
              </div>

              <div class="flex flex-col gap-1">
                <label class="text-[10px] font-mono uppercase tracking-wider text-ge-text-muted font-bold">Accent Color</label>
                <div class="flex items-center gap-1.5">
                  <input type="color" bind:value={editingStyleAccent} class="h-6 w-6 rounded border border-ge-border bg-transparent cursor-pointer p-0" />
                  <input type="text" bind:value={editingStyleAccent} class="bg-ge-bg border border-ge-border rounded p-1 outline-none text-ge-text text-center w-full font-mono text-[10px]" />
                </div>
              </div>
            </div>

            <div class="mt-2 flex flex-col gap-2">
              <button on:click={() => showAdvancedColors = !showAdvancedColors} class="text-[9px] uppercase font-bold text-ge-accent flex items-center gap-1 self-start select-none transition-colors hover:text-ge-accent-hover bg-transparent border-none cursor-pointer p-0" type="button">
                {#if showAdvancedColors}
                  <span>▼ Hide Advanced Colors</span>
                {:else}
                  <span>▶ Show Advanced Colors</span>
                {/if}
              </button>

              {#if showAdvancedColors}
                <div class="grid grid-cols-2 gap-2 pt-2 border-t border-ge-border/30">
                  <div class="flex flex-col gap-1">
                    <label class="text-[9px] font-mono uppercase tracking-wider text-ge-text-muted font-bold">Secondary Text</label>
                    <div class="flex items-center gap-1">
                      <input type="color" bind:value={editingStyleTextSecondary} class="h-5 w-5 rounded border border-ge-border bg-transparent cursor-pointer p-0" />
                      <input type="text" bind:value={editingStyleTextSecondary} class="bg-ge-bg border border-ge-border rounded p-0.5 outline-none text-ge-text text-center w-full font-mono text-[9px]" />
                    </div>
                  </div>

                  <div class="flex flex-col gap-1">
                    <label class="text-[9px] font-mono uppercase tracking-wider text-ge-text-muted font-bold">Border Color</label>
                    <div class="flex items-center gap-1">
                      <input type="color" bind:value={editingStyleBorder} class="h-5 w-5 rounded border border-ge-border bg-transparent cursor-pointer p-0" />
                      <input type="text" bind:value={editingStyleBorder} class="bg-ge-bg border border-ge-border rounded p-0.5 outline-none text-ge-text text-center w-full font-mono text-[9px]" />
                    </div>
                  </div>

                  <div class="flex flex-col gap-1">
                    <label class="text-[9px] font-mono uppercase tracking-wider text-ge-text-muted font-bold">Accent Hover</label>
                    <div class="flex items-center gap-1">
                      <input type="color" bind:value={editingStyleAccentHover} class="h-5 w-5 rounded border border-ge-border bg-transparent cursor-pointer p-0" />
                      <input type="text" bind:value={editingStyleAccentHover} class="bg-ge-bg border border-ge-border rounded p-0.5 outline-none text-ge-text text-center w-full font-mono text-[9px]" />
                    </div>
                  </div>

                  <div class="flex flex-col gap-1">
                    <label class="text-[9px] font-mono uppercase tracking-wider text-ge-text-muted font-bold">Success Color</label>
                    <div class="flex items-center gap-1">
                      <input type="color" bind:value={editingStyleSuccess} class="h-5 w-5 rounded border border-ge-border bg-transparent cursor-pointer p-0" />
                      <input type="text" bind:value={editingStyleSuccess} class="bg-ge-bg border border-ge-border rounded p-0.5 outline-none text-ge-text text-center w-full font-mono text-[9px]" />
                    </div>
                  </div>

                  <div class="flex flex-col gap-1 col-span-2">
                    <label class="text-[9px] font-mono uppercase tracking-wider text-ge-text-muted font-bold">Danger Color</label>
                    <div class="flex items-center gap-1">
                      <input type="color" bind:value={editingStyleDanger} class="h-5 w-5 rounded border border-ge-border bg-transparent cursor-pointer p-0" />
                      <input type="text" bind:value={editingStyleDanger} class="bg-ge-bg border border-ge-border rounded p-0.5 outline-none text-ge-text text-center w-full font-mono text-[9px]" />
                    </div>
                  </div>
                </div>
              {/if}
            </div>

            <div class="flex gap-2 mt-auto pt-4 border-t border-ge-border">
              {#if editingStyleId !== 'auto'}
                <button on:click={deleteStyle} class="bg-ge-danger/10 hover:bg-ge-danger text-ge-danger hover:text-ge-bg font-bold py-2 px-3 rounded text-xs transition-all">
                  Delete
                </button>
              {/if}
              <button on:click={saveStyle} class="flex-grow bg-ge-accent text-ge-bg font-bold py-2 px-4 rounded text-xs hover:opacity-90 transition-all">
                Save Style
              </button>
            </div>
          </div>
        </div>
      {/if}

      {#if showApiSettings}
        <div class="absolute inset-0 bg-ge-card flex flex-col p-4 z-30 overflow-y-auto border-r border-ge-border">
          <div class="flex items-center justify-between border-b border-ge-border pb-2 mb-3">
            <h2 class="text-sm font-bold text-ge-accent font-raleway">API Settings</h2>
            <button on:click={() => showApiSettings = false} class="text-ge-text-muted hover:text-ge-accent text-xs font-bold">Close</button>
          </div>

          <div class="flex flex-col gap-4 text-xs flex-grow">
            <div class="flex flex-col gap-1">
              <label class="text-[10px] font-mono uppercase tracking-wider text-ge-text-muted font-bold">Z.AI API Key</label>
              <input type="password" bind:value={customApiKey} placeholder="Leave blank to use server default" class="bg-ge-bg border border-ge-border rounded p-2 outline-none text-ge-text focus:border-ge-accent" />
              <p class="text-[10px] text-ge-text-muted mt-1">Provide your own Z.AI key to use Zlides on this machine.</p>
            </div>

            <div class="flex flex-col gap-1">
              <label class="text-[10px] font-mono uppercase tracking-wider text-ge-text-muted font-bold">Base URL</label>
              <input type="text" bind:value={customBaseUrl} class="bg-ge-bg border border-ge-border rounded p-2 outline-none text-ge-text focus:border-ge-accent font-mono text-[11px]" />
            </div>

            <div class="flex gap-2 mt-auto pt-4 border-t border-ge-border">
              <button on:click={() => { localStorage.setItem('zlides_api_key', customApiKey); localStorage.setItem('zlides_base_url', customBaseUrl); showApiSettings = false; status = "API settings saved!"; }} class="flex-grow bg-ge-accent text-ge-bg font-bold py-2 px-4 rounded text-xs hover:opacity-90 transition-all">
                Save Settings
              </button>
            </div>
          </div>
        </div>
      {/if}

      {#if showPreferences}
        <div class="absolute inset-0 bg-ge-card flex flex-col p-4 z-30 overflow-y-auto border-r border-ge-border">
          <div class="flex items-center justify-between border-b border-ge-border pb-2 mb-3">
            <h2 class="text-sm font-bold text-ge-accent font-raleway">Preferences</h2>
            <button on:click={() => showPreferences = false} class="text-ge-text-muted hover:text-ge-accent text-xs font-bold">Close</button>
          </div>
          <p class="text-[10px] text-ge-text-muted mb-2">These preferences are injected into every generation. Write anything you want the agent to always follow — fonts, spacing, tone, structure, etc.</p>
          <textarea bind:value={preferencesText} rows="20" placeholder="# My Preferences&#10;&#10;- Always use generous padding (at least 40px)&#10;- Keep font sizes large and readable&#10;- Use card-based layouts&#10;- Short paragraphs, bullet points preferred&#10;- Add subtle hover effects on interactive elements" class="bg-ge-bg border border-ge-border rounded p-2 outline-none text-ge-text resize-y focus:border-ge-accent font-mono text-[11px] flex-grow"></textarea>
          <button on:click={savePreferences} class="mt-3 bg-ge-accent text-ge-bg font-bold py-2 px-4 rounded text-xs hover:opacity-90 transition-all">Save Preferences</button>
        </div>
      {/if}

      {#if showPromptPreviewModal}
        <div class="absolute inset-0 bg-ge-card flex flex-col p-4 z-40 overflow-y-auto border-r border-ge-border animate-in fade-in duration-200">
          <div class="flex items-center justify-between border-b border-ge-border pb-2 mb-3">
            <h2 class="text-sm font-bold text-ge-accent font-raleway">Assembled Prompt Preview</h2>
            <button on:click={() => showPromptPreviewModal = false} class="text-ge-text-muted hover:text-ge-accent text-xs font-bold cursor-pointer">Close</button>
          </div>
          <p class="text-[10px] text-ge-text-muted mb-2 font-mono">This is the exact full context string that will be sent to Z.AI for your request:</p>
          <pre class="bg-ge-bg border border-ge-border rounded p-2.5 outline-none text-ge-text font-mono text-[10px] flex-grow overflow-auto whitespace-pre-wrap select-all leading-relaxed">{getAssembledPrompt()}</pre>
          <button on:click={() => showPromptPreviewModal = false} class="mt-3 bg-ge-accent text-ge-bg font-bold py-2 px-4 rounded text-xs hover:opacity-90 transition-all cursor-pointer">Back to Workspace</button>
        </div>
      {/if}

      {#if showRecent}
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm p-4 font-sans animate-in fade-in duration-200">
          <div class="relative w-full max-w-[90vw] h-[90vh] flex flex-col items-center justify-center">
            
            <div class="absolute top-0 right-0 z-50 flex gap-2">
              <button on:click={() => showRecent = false} class="px-4 py-2 bg-ge-card border border-ge-border rounded-lg text-ge-text hover:text-ge-accent transition-colors font-bold shadow-lg">Close Gallery</button>
            </div>

            <div class="text-center mb-6">
              <h2 class="text-3xl font-bold text-ge-accent font-raleway tracking-tight drop-shadow-md">Past Slides Gallery</h2>
              <p class="text-ge-text-muted mt-1 text-sm">Scroll to review your previous generations</p>
            </div>

            {#if recentSlides.length === 0}
              <p class="text-ge-text-muted">No saved slides yet.</p>
            {:else}
              <Carousel.Root class="w-full max-w-[95vw]" opts={{ align: "center" }}>
                <Carousel.Content class="-ms-4 py-8">
                  {#each recentSlides.slice(0, 20) as slide}
                    <Carousel.Item class="ps-4 basis-[70%] md:basis-[50%] lg:basis-[35%]">
                      <div class="p-1 h-full">
                        <Card.Root class="bg-ge-card border-ge-border/70 shadow-2xl h-full flex flex-col">
                          <Card.Header class="pb-2 shrink-0">
                            <Card.Title class="text-ge-accent font-raleway truncate text-2xl">{slide.title}</Card.Title>
                            <Card.Description class="text-xs text-ge-text-muted flex items-center gap-2">
                              <span>{slide.date}</span> 
                              <span>·</span> 
                              <span>{(slide.size / 1024).toFixed(0)}KB</span>
                            </Card.Description>
                          </Card.Header>
                          <Card.Content class="flex-grow p-0 relative overflow-hidden bg-white/5 mx-6 mb-4 rounded border border-ge-border/30 h-[55vh]">
                            <iframe
                              src="/saved/{slide.filename}"
                              title={slide.title}
                              loading="lazy"
                              class="w-full h-full border-none"
                              sandbox="allow-scripts allow-same-origin"
                            ></iframe>
                            <!-- Intercept clicks so they can scroll -->
                            <div class="absolute inset-0 z-10" style="background: transparent;"></div>
                          </Card.Content>
                          <Card.Footer class="flex justify-center gap-3 pb-6 shrink-0">
                            <button 
                              on:click={() => { previewSlideFile = slide; showRecent = false; }}
                              class="px-5 py-2.5 bg-ge-card border border-ge-border hover:border-ge-accent text-ge-text hover:text-ge-accent font-bold rounded-lg shadow-md transition-all hover:scale-105 flex items-center gap-2"
                              title="Read the full document in a popup without losing your current work"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                              <span>Preview Fullscreen</span>
                            </button>
                            <button 
                              on:click={() => { previewSlideFile = slide; loadPreviewedToWorkspace(); showRecent = false; }}
                              class="px-5 py-2.5 bg-ge-success hover:bg-ge-success/90 text-ge-bg font-bold rounded-lg shadow-xl transition-all hover:scale-105 flex items-center gap-2"
                              title="Load this into your editor"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                              <span>Load</span>
                            </button>
                            <button 
                              on:click={() => deleteRecentSlide(slide.filename)}
                              class="px-4 py-2.5 bg-ge-card border border-red-500/30 hover:border-red-500 hover:bg-red-500/10 text-red-400 hover:text-red-500 font-bold rounded-lg shadow-md transition-all hover:scale-105 flex items-center justify-center"
                              title="Delete this saved slide permanently"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                            </button>
                          </Card.Footer>
                        </Card.Root>
                      </div>
                    </Carousel.Item>
                  {/each}
                </Carousel.Content>
                <Carousel.Previous class="text-ge-accent border-ge-border hover:bg-ge-bg hover:text-ge-text scale-150 -left-12" />
                <Carousel.Next class="text-ge-accent border-ge-border hover:bg-ge-bg hover:text-ge-text scale-150 -right-12" />
              </Carousel.Root>
            {/if}
          </div>
        </div>
      {/if}

      {#if showCostHistory}
        <div class="absolute inset-0 bg-ge-card flex flex-col p-4 z-30 overflow-y-auto border-r border-ge-border animate-in slide-in-from-left duration-200">
          <div class="flex items-center justify-between border-b border-ge-border pb-2 mb-3">
            <h2 class="text-sm font-bold text-ge-accent font-raleway">Cost Management</h2>
            <button on:click={() => showCostHistory = false} class="text-ge-text-muted hover:text-ge-accent text-xs font-bold">Close</button>
          </div>

          <div class="bg-ge-bg/40 border border-ge-border/50 rounded-lg p-3 mb-4 flex flex-col gap-2">
            <div class="flex justify-between items-baseline">
              <span class="text-xs text-ge-text-muted font-semibold">Accumulated Cost</span>
              <span class="text-lg font-bold font-mono text-ge-success">${accumulatedCost.toFixed(4)}</span>
            </div>
            {#if costResetDate}
              <div class="text-[9px] text-ge-text-muted">
                Tracking since: <span class="font-mono text-ge-text">{costResetDate}</span>
              </div>
            {/if}
            <button 
              on:click={resetAccumulatedCost}
              class="w-full mt-1.5 py-1.5 bg-ge-card border border-ge-border/80 hover:border-ge-accent hover:text-ge-accent text-ge-text-muted text-[11px] font-bold rounded transition-colors"
            >
              Reset Accumulated Cost
            </button>
          </div>

          <div class="flex items-center justify-between mb-2">
            <span class="text-[10px] font-mono uppercase tracking-wider text-ge-text-muted font-bold">Run History</span>
            <span class="text-[9px] text-ge-text-muted">{costHistory.length} generations</span>
          </div>

          {#if costHistory.length === 0}
            <p class="text-ge-text-muted text-xs italic">No cost entries recorded yet.</p>
          {:else}
            <div class="flex flex-col gap-2 overflow-y-auto pr-1">
              {#each costHistory as entry (entry.id)}
                <div class="bg-ge-bg/30 border border-ge-border/30 rounded p-2 text-xs flex flex-col gap-1">
                  <div class="flex justify-between items-baseline gap-2">
                    <span class="text-[10px] font-mono text-ge-text-muted truncate flex-grow" title={entry.prompt}>{entry.prompt}</span>
                    <span class="font-mono font-bold text-ge-success shrink-0">${entry.cost.toFixed(4)}</span>
                  </div>
                  <div class="text-[8px] text-ge-text-muted font-mono">{entry.date}</div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>

  <div class="flex-grow bg-ge-bg relative flex flex-col">

    <div class="flex-grow p-1 md:p-2 flex items-center justify-center overflow-hidden relative">
       <!-- Preview Container -->
       <div class="w-full h-full bg-transparent rounded shadow-2xl border border-ge-border/70 overflow-hidden relative group">
        <iframe
          bind:this={iframeElement}
          title="Slide Preview"
          srcdoc={iframeSrcDoc}
          class="w-full h-full bg-transparent"
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        ></iframe>

        {#if slides.length > 0}
          <!-- Left slide navigation arrow -->
          <button
            class="absolute left-4 top-1/2 -translate-y-1/2 z-20 p-2.5 rounded-full border border-ge-border bg-ge-bg/90 text-ge-text hover:bg-ge-accent hover:border-ge-accent hover:text-ge-bg hover:scale-105 transition-all shadow-lg cursor-pointer disabled:opacity-20 disabled:pointer-events-none"
            disabled={currentSlideIndex <= 0}
            on:click={() => { if (currentSlideIndex > 0) { currentSlideIndex--; iframeSrcDoc = slides[currentSlideIndex].html; } }}
            title="Previous Slide"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </button>

          <!-- Right slide navigation arrow -->
          <button
            class="absolute right-4 top-1/2 -translate-y-1/2 z-20 p-2.5 rounded-full border border-ge-border bg-ge-bg/90 text-ge-text hover:bg-ge-accent hover:border-ge-accent hover:text-ge-bg hover:scale-105 transition-all shadow-lg cursor-pointer disabled:opacity-20 disabled:pointer-events-none"
            disabled={currentSlideIndex >= slides.length - 1}
            on:click={() => { if (currentSlideIndex < slides.length - 1) { currentSlideIndex++; iframeSrcDoc = slides[currentSlideIndex].html; } }}
            title="Next Slide"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
          </button>

          <!-- Bottom page indicator pill -->
          <div class="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 px-3 py-1 rounded-full border border-ge-border/80 bg-ge-bg/85 text-ge-text-muted font-mono text-xs select-none shadow-md">
            {currentSlideIndex + 1} / {slides.length}
          </div>

          <!-- Top-right Edit & Export overlay controls -->
          <div class="absolute top-4 right-4 z-20 flex gap-2 items-center pointer-events-auto">
            {#if isEditMode}
              <button class="text-xs px-2.5 py-1.5 bg-ge-success text-ge-bg font-semibold rounded hover:opacity-90 shadow-md transition-colors" on:click={captureEdits} title="Save edits to this slide">Save Edits</button>
              <button class="text-xs px-2.5 py-1.5 bg-ge-accent text-ge-bg font-semibold rounded hover:opacity-90 shadow-md transition-colors" on:click={applyEditsEverywhere} title="Send edited slide to agent to replicate across all slides">Apply Everywhere</button>
            {/if}
            <button class="text-xs px-3 py-1.5 bg-ge-bg/90 border border-ge-border rounded hover:bg-ge-card text-ge-text shadow-md transition-colors" on:click={toggleEditMode} title="Toggle inline editing">{isEditMode ? 'Exit Edit' : 'Edit'}</button>
            
            <!-- Export Dropdown -->
            <div class="relative">
              <button on:click|stopPropagation={() => showExportDropdown = !showExportDropdown} class="text-xs px-3 py-1.5 bg-ge-accent text-ge-bg font-bold rounded hover:opacity-90 shadow-md transition-colors flex items-center gap-1.5 cursor-pointer">
                <span>Export</span>
                <svg class="transition-transform duration-200" class:rotate-180={showExportDropdown} xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
              </button>
              {#if showExportDropdown}
                <div class="absolute right-0 mt-1 w-48 bg-ge-card border border-ge-border rounded-md shadow-xl z-30 py-1 font-sans text-xs">
                  <button on:click={() => { exportPdf(false); showExportDropdown = false; }} class="w-full text-left px-3 py-2 text-ge-text hover:bg-ge-bg hover:text-ge-accent transition-colors block cursor-pointer">
                    Printer Friendly PDF
                  </button>
                  <button on:click={() => { exportPdf(true); showExportDropdown = false; }} class="w-full text-left px-3 py-2 text-ge-text hover:bg-ge-bg hover:text-ge-accent transition-colors block cursor-pointer">
                    Branded PDF (Dark)
                  </button>
                  <button on:click={() => { exportHtml(); showExportDropdown = false; }} class="w-full text-left px-3 py-2 text-ge-text hover:bg-ge-bg hover:text-ge-accent transition-colors block cursor-pointer">
                    HTML Document
                  </button>
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>

  <!-- Past Slides Preview Gallery Overlay -->
  {#if previewSlideFile}
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm p-4 font-sans animate-in fade-in duration-200">
      <div class="bg-ge-card border border-ge-border rounded-xl shadow-2xl flex flex-col w-full max-w-5xl h-[85vh] overflow-hidden">
        <!-- Header -->
        <div class="flex items-center justify-between px-4 py-3 border-b border-ge-border/50 shrink-0">
          <div class="min-w-0 flex-grow mr-4">
            <h3 class="text-sm font-bold text-ge-accent font-raleway truncate leading-tight">{previewSlideFile.title}</h3>
            <p class="text-[10px] text-ge-text-muted mt-0.5">
              Saved on: <span class="font-mono">{previewSlideFile.date}</span> · Size: <span class="font-mono">{(previewSlideFile.size / 1024).toFixed(0)}KB</span>
            </p>
          </div>
          <div class="flex items-center gap-2">
            <button 
              on:click={loadPreviewedToWorkspace}
              class="px-3.5 py-1.5 bg-ge-success hover:bg-ge-success/90 text-ge-bg font-bold rounded-lg text-xs shadow-md transition-all flex items-center gap-1 cursor-pointer"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
              <span>Load in Editor</span>
            </button>
            <button 
              on:click={() => previewSlideFile = null}
              class="p-1.5 hover:bg-ge-bg rounded-lg text-ge-text-muted hover:text-ge-text transition-colors cursor-pointer"
              title="Close Preview"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          </div>
        </div>

        <!-- Body: Preview Iframe + Gallery Controls -->
        <div class="flex-grow min-h-0 relative flex bg-ge-bg/20">
          <!-- Previous Button -->
          <button 
            on:click|stopPropagation={() => cyclePreview(-1)}
            class="absolute left-4 top-1/2 -translate-y-1/2 z-10 p-3 bg-ge-card/85 hover:bg-ge-card border border-ge-border text-ge-text hover:text-ge-accent rounded-full shadow-lg transition-all hover:scale-105 select-none cursor-pointer"
            title="Previous File"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </button>

          <!-- Iframe Container -->
          <div class="w-full h-full p-6 flex items-center justify-center">
            <div class="w-full h-full bg-black/40 border border-ge-border/50 rounded-lg overflow-hidden shadow-inner relative">
              <iframe 
                src="/saved/{previewSlideFile.filename}"
                title="Slide Preview"
                class="w-full h-full border-none"
              ></iframe>
            </div>
          </div>

          <!-- Next Button -->
          <button 
            on:click|stopPropagation={() => cyclePreview(1)}
            class="absolute right-4 top-1/2 -translate-y-1/2 z-10 p-3 bg-ge-card/85 hover:bg-ge-card border border-ge-border text-ge-text hover:text-ge-accent rounded-full shadow-lg transition-all hover:scale-105 select-none cursor-pointer"
            title="Next File"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
          </button>
        </div>

        <!-- Footer / Keyboard Navigation Help -->
        <div class="px-4 py-2 bg-ge-card/50 border-t border-ge-border/50 shrink-0 text-center text-[10px] text-ge-text-muted select-none">
          Click the arrows on either side of the screen to cycle through all saved presentations.
        </div>
      </div>
    </div>
  {/if}

</main>

<svelte:window on:click={() => showExportDropdown = false} />
