# GLM PPT Slide Agent — Consolidated Analysis for Zlides22

**Subject:** Zhipu AI / Z.ai GLM PPT "slide agent" (`agent_id: "slides_glm_agent"`), served from `https://open.bigmodel.cn/api/v1/agents`.
**Sources:** 4 markdown docs + 3 PNG diagrams from `/home/hayron/HugePenisAndSexBalls/Kimi_Agent_Zai Slide Agent Hacks/`, analyzed in 5 cells:
- (guide) → `glm_ppt_slide_agent_guide.md` (849 lines, unofficial reverse-engineering guide, dated June 2026)
- (code_skills) → `glm_ppt_agent_code_skills.md` (394 lines, code execution / skills analysis)
- (advanced_qa) → `glm_ppt_agent_advanced_qa.md` (523 lines, SDK / workflows / editing / PDF parsing Q&A)
- (deep_dive) → `glm_ppt_agent_final_deep_dive.md` (458 lines, uploads / headless / animations / uniqueness capstone)
- (diagrams) → vision analysis of `glm_ppt_agent_architecture.png`, `glm_ppt_capability_map.png`, `glm_ppt_workflow.png`

**Attribution tags** below map claims to their source cell. Never assume any claim is officially documented unless stated.

---

## 1. Executive Summary

- The GLM PPT slide agent is a **full agentic system** (web search + HTML generation + multi-turn editing + export in one conversational interface), officially identified by the fixed `agent_id` string `"slides_glm_agent"`, served via SSE streaming **exclusively** — `stream: true` is mandatory; there is no non-streaming mode. (guide)
- Core thesis: **"Model-Native Agentic Architecture"** — "not a wrapper around a base LLM — it's a **model-native capability** where the GLM-4.5/4.7 backbone has been trained to understand presentation structure, visual layout, and slide-specific tool use"; tools are "hardwired into the model's reasoning process, not bolted on via external function calls." (deep_dive)
- Output is **raw self-contained single-file HTML with inline CSS and JavaScript** (images base64 or agent-CDN-hosted) — no PPTX, no proprietary format, no vendor lock-in. Consequence: content-adaptive layout causes **inconsistent page heights** across slides; fix via prompt cue + CSS `!important` override + headless re-render. (guide)
- The tool surface is a **fixed, closed set of 5 tools**: `search`, `insert_page`, `remove_slides` (documented) plus hidden `access_page` (翻页 navigation) and `modify_page` (surgical edit) — reverse-engineered from the frontend repo `MetaGLM/glm-ppt-front`. The agent endpoint "ignores `tools` parameter entirely." (guide, code_skills)
- **No code execution on the agent endpoint.** Python/Code Interpreter lives only on the chat completions API (`/api/paas/v4/chat/completions`) and Z.ai web UI "All Tools" mode. The prescribed architecture is a **two-stage pipeline**: compute outside (sandboxed matplotlib → base64 PNG) → inject into slide prompt → post-process HTML. (code_skills)
- **No direct file uploads.** The agent API has "no `file` parameter"; binaries must be converted to text first via ecosystem services: File Parser (`/api/paas/v4/files/parser/create`, 3 tiers), `glm-ocr` (≤50MB/100 pages), or vision models (`glm-4v-plus`, `glm-4.5v`, dubious `glm-4.6v`). (deep_dive, advanced_qa)
- State model: `conversation_id` is the single persistence key (multi-turn editing, resume, continuation); sessions persist "hours, not days" / "may expire overnight"; editing is **text-driven regeneration** ("修改第3页", "在第5页后插入新页", "删除第2,4页") — no WYSIWYG, no annotations (build an HTML overlay instead). (guide, advanced_qa, deep_dive)
- Practical limits: **~15 pages per generation session** (quality cliff), **50-minute timeout** (frontend uses 3,000,000 ms), error `1301` = content-safety trigger. Cost envelope: 10-slide deck ≈ 5,000–25,000 tokens ≈ **¥0.01–0.05 (~$0.01/deck)**; agent tasks consume 2–3× tokens vs chat. (guide, deep_dive, diagrams)
- Export is a **separate call**: `POST https://open.bigmodel.cn/api/v1/agents/conversation/` with `custom_variables` — documented `include_pdf` and undocumented `include_html` ("the secret sauce"); both `true` returns multiple `file_url`s. A hidden `POST /v1/agents/async-result` endpoint (speculative) implies async processing modes. (guide, deep_dive)
- Animations/games (Flappy Bird clone, Three.js first-person maze, physics sims, particle effects, drag&drop Kanban, neon glow) are attributed to GLM-4.5's "Artifacts" system — but whether that JS actually ships through the *agent* endpoint is asserted, not demonstrated. **All effects must be requested in the initial prompt** — follow-up effect requests "rarely work because the HTML structure is established during the first generation pass." (deep_dive, guide)
- All 4 docs have **dangling footnotes** (`[^3^]`…`[^132^]`, no definition register anywhere), model-naming drift (`glm-4.5/4.7/5`, `GLM-Experimental`), and sample-code bugs (`chart_base64[:100]` truncation, undefined `parse_slide_response()`, infinite polling loop, 12px font). Verify everything against the live API before building. (all cells)
- Verdict for Zlides22: treat the agent as a **text-in/HTML-out stateful rendering layer** with an external pre-processing (ingestion/compute) and post-processing (injection/export) shell; skip the SDK; build workflow/branching/annotation layers client-side.

---

## 2. What the Slide Agent Is

**Positioning.** The agent is "the **presentation rendering layer** of a comprehensive AI ecosystem" (deep_dive). It is a *"model-native PPT/Poster agent"* — the slide capability is native to the GLM-4.5 backbone (reasoning + coding + tool-use fused in one model), not a wrapper (guide). It combines web search, HTML generation, multi-turn editing, and export in one conversational interface (guide). The capability map's hub labels it: `slides_glm_agent` / `Model-Native PPT/Poster Agent` / `HTML + Inline CSS + JS Output` (diagrams).

**The "Model-Native Agentic Architecture" thesis (deep_dive, quoting the source):**
- "not a wrapper around a base LLM — it's a **model-native capability** where the GLM-4.5/4.7 backbone has been trained to understand presentation structure, visual layout, and slide-specific tool use"
- Tools are "**hardwired into the model's reasoning process**, not bolted on via external function calls."
- Consequences you cannot engineer around:
  - **No model selection via API** — `slides_glm_agent` is pre-configured ("agent-managed"), powered internally by the **GLM-Experimental** series per Zhipu announcements; no `model` parameter exists (guide). Indirect control: Z.ai chat UI allows picking GLM-4.5/4.6/4.7/5; community reports GLM-4.7/GLM-5.1 yield superior designs. Self-hosting via **vLLM/SGLang** from open weights is possible but "you lose the agentic capabilities" (guide §4.3; deep_dive flags the deep-dive's own competitor-table "Self-hosted: Yes (model weights)" as overstating).
  - **No system prompt exposure, no custom tools, no template saving** — any "skill system" must be client-side (code_skills).
  - **No cross-session learning** — "No — the agent does not learn from interactions"; it "does not remember across different API keys"; the only sanctioned personalization path is fine-tuning via `/api/paas/v4/fine-tuning` (deep_dive).

**Design decisions with stated rationale (deep_dive):**
1. Raw HTML output → ownership, injection freedom, "no vendor lock-in, no subscription required to view."
2. SSE-only + stateful `conversation_id` → multi-turn refinement and continuation beyond the ~15-page ceiling.
3. No direct file upload on the agent endpoint → binaries delegated to ecosystem services; agent stays text-in/HTML-out.
4. Initial-prompt-only animation requests → consequence of single-pass HTML generation.
5. One API key across the ecosystem — "File Parser, GLM-OCR, GLM-Image, Knowledge Base, and Fine-tuning all connect to the same API key."

**Positioning vs competitors (guide's own table):** vs Gamma / Beautiful.ai / Open-Slide — HTML self-contained output (Open-Slide: React/HTML), documented API access, agent-managed model, templates only via HTML post-processing, interactivity via JS injection, **~$0.01–0.05 per deck**, **native Chinese content as first-class citizen** ("trained on Chinese content natively" — deep_dive), no self-hosting. Closest rival: "the **Z.ai web interface with GLM-4.5 + All Tools mode** — but that's the SAME ecosystem" (deep_dive). A separate product, Z.ai "AI Slides" web UI, uses "the same `GLM-Experimental` model as the slide agent" but targets end users: "Limited (templates)", export "PDF + PPTX", "Free (currently)" (deep_dive).

---

## 3. Architecture & API Contract

*(Folds in Diagram 1 / D1: "GLM PPT Slide Agent — API Architecture & Hidden Parameters")*

### 3.1 Endpoints

| Endpoint | Method | Role |
|---|---|---|
| `https://open.bigmodel.cn/api/v1/agents` | POST | Slide agent (SSE only) |
| `https://open.bigmodel.cn/api/v1/agents/conversation/` | POST | Export (guide §2.3, trailing slash) — and/or history (see §13 contradiction) |
| `https://open.bigmodel.cn/api/v1/agents/conversation` | POST | History/"Time Machine" — "works **exclusively with `slides_glm_agent`**" (advanced_qa) |
| `POST /v1/agents/async-result` | POST | Hidden, undocumented — async result retrieval; "purpose unclear", speculative (guide, deep_dive) |
| `https://open.bigmodel.cn/api/paas/v4/chat/completions` | POST | Chat completions (Stage 1 compute, vision, function calling) (code_skills, deep_dive) |
| `https://open.bigmodel.cn/api/paas/v4/files/parser/create` | POST | File Parser (async, tiered) (advanced_qa, deep_dive) |
| `GET /api/paas/v4/files/parser/result/{task_id}/download_link` | GET | File Parser polling (advanced_qa) |
| `/api/paas/v4/fine-tuning` | — | Fine-tuning (deep_dive) |

D1 renders the contract as a spec-sheet stack (diagrams): top panel `POST https://open.bigmodel.cn/api/v1/agents` with `Agent ID: slides_glm_agent | Stream: true (required)` in red/pink (= critical); left panel **Required Parameters** (`agent_id: "slides_glm_agent"`, `messages: [{role, content}]`, `stream: true (SSE only)`); right panel **Hidden Custom Variables** (`include_pdf: true/false`, `include_html: true/false`, annotated `(Export endpoint only)`); middle panel **Response Phases (SSE Stream Events)** — four phase cards `thinking` (Internal reasoning), `tool` (Tool calls (search/insert)), `answer` (Final response), `error` (Error codes); lower panel **Available Tools (Reverse-Engineered)** — the 5 tools; bottom bar `Export: POST /api/v1/agents/conversation/ → Returns file_url (PDF/HTML)`.

### 3.2 Request parameters (agent endpoint)

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `agent_id` | String | Yes | Fixed value `"slides_glm_agent"` (guide) |
| `messages` | List<Object> | Yes | OpenAI-compatible `role`/`content`; content items typed: `{"type":"text","text":"..."}` — **text-only content blocks** (guide, deep_dive) |
| `conversation_id` | String | No | Multi-turn session key (guide) |
| `stream` | Boolean | Yes | Must be `true` — SSE only (guide) |

No `model` parameter. No `tools` parameter effect — "ignores `tools` parameter entirely. It's a pre-configured agent with a fixed tool set" (code_skills). No system prompt (code_skills).

### 3.3 SSE event phases

Each SSE event carries an incrementing `index` and a `phase` field (guide). Exactly four phases (diagrams D1):
1. `phase: "thinking"` — "Internal reasoning", fragmentary reasoning text streamed to the client (guide).
2. `phase: "tool"` — tool execution; emits `tool_name`, `input`, `output`. The `output` for `insert_page` is a **full HTML document**; tool output includes a **`position` field** identifying which slide number is manipulated — the basis of precise/surgical edits (guide).
3. `phase: "answer"` — completion message/summary (guide).
4. `phase: "error"` — e.g. code **`1301`** = content-safety trigger (guide).

Parsing implication: undocumented tools flow through the **same `phase: "tool"` channel**; `tool_name` may be any identifier ⇒ parsers must be **tool-name-agnostic**, not hardcoded to the three documented names (guide).

### 3.4 Export & custom_variables

- Officially documented custom variable: **`include_pdf`** (Boolean). Undocumented: **`include_html`** (Boolean), discovered via API schema — returns a `file_url` to a downloadable `.html` with "all CSS inline, no external dependencies"; the guide calls it "the secret sauce" for template customization, placeholder injection, and interactivity (guide).
- Tip: set **both** `include_pdf: true` and `include_html: true` in one request to get multiple `file_url`s back (guide).
- The history variant returns "The complete message history of the conversation, including all tool calls (`insert_page`, `remove_slides`, etc.), their inputs, and their HTML outputs. This lets you reconstruct the entire presentation's evolution" (advanced_qa).
- History request body example (advanced_qa): `{"include_pdf": true, "pages": [{"position": 1, "width": 1280, "height": 720}]}` → **canonical geometry `{position: 1, width: 1280, height: 720}`**; positions are **1-based**.
- Hidden `POST /v1/agents/async-result` — "surfaced in frontend code; purpose 'unclear', but implies **asynchronous processing modes** for long-running operations (useful for decoupling from a persistent SSE connection)". Deep dive adds proposed uses: "Fire-and-forget slide generation in serverless environments", "Polling-based result retrieval for mobile clients", "Background job queues where the worker may disconnect". No schema exists in any doc. (guide, deep_dive)

### 3.5 SDK situation

- Two SDK flavors: legacy `pip install zhipuai` (Domestic China, `open.bigmodel.cn`) vs modern `pip install zai-sdk` (International, `api.z.ai`) — both "thin wrappers around `httpx`" (advanced_qa).
- "The SDK has NO method for agent_id-based calls" — the only SDK route is the private `client._http_client.post("/api/v1/agents", ...)` (advanced_qa).
- `client.chat.completions.create()` "knows nothing about `agent_id`, `conversation_id`, or the SSE stream phases (`thinking`, `tool`, `answer`)" (advanced_qa).
- "for a stateful SSE stream that holds a connection open for minutes, connection pooling is irrelevant. You're holding one connection anyway." (advanced_qa)
- Verdict: "**Skip the SDK** for the slide agent. Use raw HTTP with `requests` or `httpx`." SDK "pays for itself" only if you're also doing chat/embeddings/images on the same key (advanced_qa).

---

## 4. Workflow Lifecycle

*(Folds in Diagram 3 / D3: "GLM PPT Agent — Multi-Turn Conversation Workflow" — two rows of 4 numbered stage cards.)*

Row 1 — generation flow (diagrams):
1. **Initial Request** — "Send prompt with `agent_id & messages`" → POST `/v1/agents`, SSE mandatory (guide).
2. **AI Thinking** — `phase: "thinking"`, "internal reasoning".
3. **Web Search** — `phase: "tool"`, `tool_name: "search"` (1,000–5,000 tokens when triggered — guide).
4. **Generate Slides** — `phase: "tool"`, `tool_name: "insert_page"` per slide, each emitting slide HTML + `position` (3,000–15,000 tokens typical — guide). A badge under stage 3: `conversation_id persists across all turns` (diagrams).

Row 2 — editing/iteration flow (diagrams):
5. **User Edit** — "Continue conversation with new instructions" (same `conversation_id`).
6. **Modify/Add** — `phase: "tool"`, `insert_page / remove_slides` mutations.
7. **Regenerate** — "Request changes: style, content, layout" (agent regenerates affected slide(s) — advanced_qa).
8. **Export** — `POST /conversation/` with `include_pdf / include_html` → `file_url`s.

Branching/continuation mechanics:
- **Continuation beyond the ~15-page ceiling:** first batch 10–12 pages, then "继续生成剩余页面" / "继续" / "continue" with the same `conversation_id`; guide pseudocode splits a 25-page deck as pages 1–12 then 13–25 (guide).
- Interrupted streams can be **resumed by re-sending with the same `conversation_id`**; full history is re-sent each turn (token cost grows over a session) (guide).
- Sessions persist "hours, not days"; expired IDs require a fresh conversation; "Conversation state may expire overnight" (guide, deep_dive).
- **Branching is contested** — code_skills: "Conversation branching | **Yes** via `conversation_id` | Fork by reusing ID at different states"; advanced_qa: "Branching workflows | **No** | Fork `conversation_id` sessions"; deep_dive: "Branching ('Fork a conversation at any edit point to explore alternatives')" via history. Mechanism never shown in any doc. See §13.
- D3's "Pro Tips for Maximum Control" panel (diagrams): `Use "继续" or "continue" to extend content beyond initial generation`; `Specify slide count: "生成15页" — but ~15 is the practical limit`; `Style commands work: "科技感模板", "绿色简约风", "新拟物主义"`; `HTML effects: request "代码雨", "粒子特效", "hover动画" in prompts`; `Poster mode: request "竖版海报", "小红书封面", "A4尺寸" for different aspect ratios`.

D3 cross-view synthesis (diagrams): D3 is the *temporal* view; D1 the wire contract (each stage maps to a SSE phase); D2 the functional envelope. Key shared invariants across all three diagrams: (1) `slides_glm_agent` via `POST https://open.bigmodel.cn/api/v1/agents` with `stream: true` — non-negotiable; (2) `conversation_id` is the multi-turn linchpin; (3) output is self-contained HTML (+ inline CSS + JS) with PDF/HTML export as a separate endpoint step; (4) everything is headless/HTTP, ~$0.01/deck, 50-min timeout ceiling, ~15 slides practical limit.

---

## 5. Tool Surface

Officially documented tools: **`search`**, **`insert_page`**, **`remove_slides`**. The frontend demo reveals **two more** (guide; identical table in code_skills and D1 "Available Tools (Reverse-Engineered)"):

| Tool | Status | Function | Trigger |
|---|---|---|---|
| `search` | Documented | Web search for content gathering | Automatic when external info is needed |
| `insert_page` | Documented | Create a new slide; `output` = HTML, `position` = slide number | Automatic during generation |
| `remove_slides` | Documented | Delete slides by position array | "删除第X页" / "remove page X" |
| `access_page` | **Undocumented** | Navigate between slides (翻页) | "上一页" / "下一页" / "go to page X"; frontend mentions "向上翻页"/"向下翻页" |
| `modify_page` | **Undocumented** | Surgical edit of an existing slide | "修改第X页" / "change page X to..." |

- "Explicitly absent: no `code_interpreter` tool, no `python_exec` tool, and no mechanism for running arbitrary code within the slide agent context." (code_skills)
- Tool-call timing: `search` fires when the model needs external content; `insert_page` fires per slide during generation; `remove_slides`/`modify_page`/`access_page` fire on user follow-up instructions in the same conversation (guide).
- **Hidden history endpoint exclusive to this agent:** `POST https://open.bigmodel.cn/api/v1/agents/conversation` — "Zhipu AI provides a **dedicated conversation history endpoint** that works **exclusively with `slides_glm_agent`**"; returns complete tool-execution history enabling "Version control for slides", "Diff between versions" ("See exactly what changed between edits"), "Branching" ("Fork a conversation at any edit point to explore alternatives"), "Audit trails" (advanced_qa, deep_dive).
- Extensibility matrix (code_skills): Chat Completions API — custom tools **Yes** (`tools` array with JSON schema); `slides_glm_agent` — **No** ("Fixed tool set, no custom tool injection"); Z.ai Agent Platform — **Yes (partial)** ("Build custom agents with tool definitions").
- Open question: `access_page`/`modify_page` exact request schemas are unknown (flagged "Undocumented" in the sources themselves); `modify_page` is treated as an at-risk surface — advanced_qa's failure table says "Treat as at-risk surface; prefer `insert_page`/`remove_slides` where possible".

---

## 6. Capability Map

*(Folds in Diagram 2 / D2: "GLM PPT Agent — The Complete Capability Map" — hub-and-spoke.)*

**Center hub (diagrams):** `slides_glm_agent` / `Model-Native PPT/Poster Agent` / `HTML + Inline CSS + JS Output`.

**Native Capabilities (D2 left panel, green = native):**
- `Web Search` — Auto-triggered content gathering
- `HTML Generation` — Self-contained slide documents
- `Multi-turn Editing` — Conversation_id persistence
- `5 Built-in Tools` — insert_page, remove_slides...
- `Export (PDF/HTML)` — include_pdf + include_html
- `Poster Mode` — 16:9, 9:16, 1:1, A4, long image

**External Services (D2 right panel, red = sibling services; all on the same API key — deep_dive):**
- `File Parser` — PDF/DOCX layout extraction
- `GLM-OCR` — Image/document recognition
- `GLM-Image` (`glm-image`) — Text-to-image generation; "superior Chinese text rendering" (deep_dive)
- `Code Interpreter` — Python execution (**chat API only**)
- `Fine-tuning` — Custom model training (`/api/paas/v4/fine-tuning`)
- `Knowledge Base` — RAG document retrieval ("index materials", "Ground slide content in your specific curriculum" — deep_dive)

D2 edges: green arrow Native→hub; red line hub→External Services; gray dashed arrow from the two bottom panels up into the hub (animation + automation sets underpin the agent implicitly — diagrams).

**Animation & Interactive Capabilities (D2 bottom-left, purple; deep_dive taxonomy, 9 categories):**
- `('Flappy Bird Game', 'Full HTML5 game with physics')` — trigger "制作一个小游戏" (Flappy Bird clone)
- `('3D Maze Runner', 'Three.js first-person 3D')` — trigger "Three.js 3D 交互"
- `('Physics Simulations', 'N-body gravity, bouncing balls')` — trigger "物理模拟" / "physics simulation"
- `('SVG Animations', 'Animated diagrams, transitions')` — trigger "SVG 动画"
- `('Interactive Charts', 'Hover, click, real-time data')` — trigger "交互式图表"
- `('Particle Effects', 'Code rain, snow, explosions')` — trigger "粒子特效" / "particle effects"
- `('Drag & Drop UI', 'Sortable Kanban boards')` — trigger "拖拽功能"
- `('Neon Effects', 'CSS glow, neon aesthetics')` — trigger "霓虹效果" / "neon glow"
- (deep_dive adds) `p5.js Animations` — trigger "p5js 交互动画"

Stated mechanism: GLM-4.5's "**Artifacts**" system — "outputs a complete, runnable piece of code (HTML, SVG, Python)" that can be "Previewed inline in the chat interface / Downloaded as a standalone file / Embedded into presentations / Modified through follow-up prompts"; described as "the mechanism behind the games and animations" (deep_dive). ⚠️ Synthesis caution (deep_dive itself): Artifacts is evidenced as a GLM-4.5 **chat** capability (Chinese tech press); whether `insert_page` output through the *agent* endpoint ships such JS is asserted, not demonstrated. Also: code_skills says the web UI's "All Tools" orchestration "cannot be replicated via the slide agent API" — it "uses a different internal orchestration layer."

**Headless & Automation Ready (D2 bottom-right, cyan):**
- `('Pure HTTP API', 'No browser, no GUI needed')`
- `('SSE Streaming', 'Event-driven async responses')`
- `('50-min Timeout', 'Long-running batch jobs')`
- `('Conversation State', 'Resume/interrupt recovery')`
- `('CI/CD Integration', 'GitHub Actions, Jenkins')`
- `('Batch Processing', 'Loop over content sources')`
- `('Docker-friendly', 'Containerized deployment')`
- `('Cost: ~$0.01/deck', 'Hundreds per dollar')`

Deep dive (§6): "It's **100% headless** by design. It's a pure HTTP API with SSE streaming — no browser, no GUI, no WebSocket, no interactive session required."

---

## 7. Code Execution & the "Skills" Reality

**Central claim (code_skills):** the slide agent **does NOT natively execute Python code or run custom skills**. It is a "renderer": a specialized presentation generator with a fixed, slide-specific tool suite. Code execution exists only on the **underlying GLM chat models** (GLM-4/4.5/4.7) via "All Tools" mode / Code Interpreter, accessible through the **chat completions API** or **Z.ai web UI** — never through the slide agent endpoint.

**"All Tools" mode** (GLM-4, launched January 2024, Zhipu AI — "All Tools能力"): model autonomously calls **Code Interpreter** (代码解释器) for Python, performs web search via **WebGLM**, generates images via **CogView3**, handles file processing (Excel, PDF, PPT), and executes data analysis/chart plotting. Launch demo: 10 years of global GDP data → Python visualization with polynomial regression overlay in one prompt. Python only (matplotlib, numpy, Plotly, Seaborn mentioned). (code_skills)

**Capability × platform matrix (code_skills, verbatim rows):**

| Platform | Code Interpreter? | How to Access |
|---|---|---|
| Z.ai Chat UI (chat.z.ai) | **Yes** — toggle "All Tools" mode | Web interface |
| Chat Completions API | **Yes** — via `tools` parameter | Pass `tools` with function definitions |
| `slides_glm_agent` API | **No** | Not exposed through this endpoint |
| Z.ai SDK (`zai-sdk`) | **Partial** — only through chat API, not agent | `client.chat.completions.create(tools=[...])` |

**Sandboxing options (in the doc's order of recommendation):**
1. **E2B.dev** (`from e2b_code_interpreter import CodeInterpreter`) — "the cleaner approach for production"; "Safest code execution: E2B.dev or Docker sandbox."
2. **Docker** sandbox.
3. **Restricted subprocess / restricted `exec()` globals** — the doc's own DIY pattern. ⚠️ **Not a real security boundary**: the restricted-`__builtins__` `exec()` pattern is escapable (object traversal / `__import__` tricks); the doc itself concedes E2B/Docker is "safest." Never use with untrusted inputs. (code_skills)

**Two-stage pipeline (verbatim, code_skills):**
```
Stage 1: Chat API + Code Interpreter → Generate charts/data
                    ↓
Stage 2: Slide Agent API → Inject results into slides
```
- Stage 1 endpoint: `https://open.bigmodel.cn/api/paas/v4/chat/completions`, model `glm-4.7`, `temperature: 0.3`, `max_tokens: 4096`; prompt demands matplotlib with "clean, professional style", "base64-encoded PNG", "Return ONLY the base64 string, no explanation", "blues/greens", "readable at 800x600 resolution". Code extraction via `re.search(r'```python\n(.*?)\n```', code_output, re.DOTALL)`.
- Stage 2 endpoint: `https://open.bigmodel.cn/api/v1/agents`, `agent_id: "slides_glm_agent"`, `stream: True`; base64 PNG injected into the prompt text as `data:image/png;base64,...` — "The primary bridge between compute stage and slide stage."
- Four-step "Bottom Line" workflow (verbatim): 1. **Do the work outside**; 2. **Package results** (base64 images, computed values, generated text); 3. **Feed into the agent** as enriched prompts; 4. **Post-process output** (inject interactivity, annotations, exercise placeholders).
- Chart file readback in E2B: `code_interpreter.files.read("/home/user/chart.png")`. ⚠️ E2B SDK version drift: `notebook.exec_cell` / `files.read` match older SDKs; current APIs differ — pin the SDK version.

**"Skills" reality:** no native skill framework — the fixed 5-tool suite is "the closest thing to a 'skill library'". Skill/workflow feature matrix (code_skills, verbatim rows): System prompts — **No** on slide agent ("Not exposed through agent API"); Template saving — **No** ("Must implement externally"); Conversation branching — **Yes** via `conversation_id` ("Fork by reusing ID at different states"); Prompt libraries — **Manual only** ("Store and reuse prompt text client-side"). Bottom line: "Can I build a skill system? | **Partially** | External orchestration required; agent has no native skill framework."

⚠️ Sample-code bugs in this doc (do not copy verbatim): Stage 2 prompt injects only `chart_base64[:100]` — a **truncated/invalid image payload** the agent cannot embed; `parse_slide_response(response)` is referenced but never defined; the doc never shows a complete working end-to-end chart-in-slide example. Real implementation must pass the full base64 string (or a hosted URL) and empirically verify what the agent accepts. (code_skills)

---

## 8. File & Document Ingestion

**No direct upload.** The agent endpoint "**does not accept direct file uploads** — there's no `file` parameter in the agent API". "Direct to slide agent" — "**Not supported**". (deep_dive) Code_skills concurs: "No file-upload mechanism shown in this doc." The agent is strictly text-in/HTML-out; binaries are converted to text by ecosystem services first (deep_dive's data flow: `[Your Content Sources] → [File Parser / GLM-OCR / Vision API] → [Pre-processed Content + Your Prompts] → [slides_glm_agent API] → [Raw HTML Output] → [Your Post-processor] → [Final Interactive Slides]`).

**Vision-model bridge (deep_dive):** multimodal chat completions with `glm-4v-plus`, `glm-4.5v`, `glm-4.6v` (⚠️ `glm-4.6v` is "dubious/unverified" per deep_dive's own audit). Routes (deep_dive, verbatim table):
- **Base64 inline** — chat API `image_url`, "JPG, PNG, WEBP", "~5MB per image, token-heavy"; payload `"image_url": {"url": f"data:image/jpeg;base64,{img_base64}"}`.
- **External URL** — chat API `image_url`; "URL must be publicly accessible".
- Images never reach the slide agent: the vision model returns `response.json()["choices"][0]["message"]["content"]` — a textual description interpolated into the slide prompt. Vision prompt (verbatim): "Describe this image in detail. Include key visual elements, colors, layout, and any text present."
- Codified as `SlideContentPipeline`: `ingest_pdf` → File Parser `tier="prime"` → `parsed["markdown"]`; `ingest_image` → `self.vision_model.describe(image_path)`; `ingest_excel` → `tier="prime"` → `self._summarize_tables(parsed["layout"])`.

**File Parser** (`POST https://open.bigmodel.cn/api/paas/v4/files/parser/create`) — "completely separate from the slide agent but uses the same API key". Parses "PDFs, Word docs, PowerPoints, Excel files, and images — returning structured content with **layout information**" (advanced_qa).

Three parsing tiers (all numbers verbatim, advanced_qa):

| Tier | Formats | Max Size | Output | Price | Best For |
|---|---|---|---|---|---|
| **Prime** | PDF/DOC/DOCX/XLS/XLSX/PPT/PPTX/PNG/JPG/CSV/TXT/MD/HTML + 15 image formats | PDF/DOC ≤100MB, XLS ≤10MB, Images ≤20MB | Images + Markdown + Layout JSON | ¥0.12/page | "Complex layouts: academic papers, textbooks, mixed columns, formulas" |
| **Expert** | PDF only | ≤100MB | Images + Markdown | ¥0.012/page (60% off) | "Research papers, financial reports, patents — PDF-optimized" |
| **Lite** | PDF/DOC/DOCX/XLS/XLSX/PPT/PPTX/PNG/JPG/CSV/TXT/MD | ≤50MB | Plain text only | **Free** (until **2025-10-08**) | "Quick text extraction, batch preprocessing" |

⚠️ Lite's free pricing expired **2025-10-08** (already past as of Aug 2026) — budget for paid tier (advanced_qa).

Prime output artifacts (3, advanced_qa): (1) **Markdown file** — "Structured text with headers, tables, lists preserved"; (2) **Layout JSON** — `layout_details[]` entries with `index`, `type` (`text_block`/`table`/`image`), `bbox` (e.g. `[120, 80, 600, 200]`), `content`; tables carry `rows`/`columns`; images carry `caption`. ⚠️ **Bbox coordinate semantics ([x,y,w,h] vs [x1,y1,x2,y2]) are never specified.**; (3) **Visual renderings** — "Screenshot images of each parsed page". Deep dive adds Prime returns "layout JSON with bounding boxes for every element in a PDF", enabling extraction of figures/diagrams from textbooks and "Preserve the visual hierarchy of source documents".

**Async pipeline mechanics** (advanced_qa, from `PDFToSlidesPipeline`): create task via multipart `files={"file": f}` + `data={"tool_type": tier, "file_type": "PDF"}` → `task_id`; poll `GET /api/paas/v4/files/parser/result/{task_id}/download_link` in a `while True` loop with `time.sleep(2)` until `status == "completed"`. ⚠️ **No timeout / max-retry / failure-branch — a latent infinite-loop bug if the task never completes or errors.** Download via `markdown_url`, `layout_json_url`, `images_url`.

**glm-ocr alternative** (model-based route, advanced_qa + deep_dive): `model="glm-ocr"` via chat API with `{"type": "file", "file_url": "https://your-pdf-url.pdf"}`, `extra_body={"return_crop_images": True, "need_layout_visualization": True}`; "supports PDFs up to **50MB and 100 pages**"; returns "markdown text and **layout visualization images** showing detected text blocks, tables, and image regions".

**Routing matrix (advanced_qa, verbatim):**

| Use Case | Service | Why |
|---|---|---|
| "Complex academic papers with formulas, multi-column" | **File Parser Prime** | "Handles complex layouts, returns structured JSON" |
| "Simple text extraction from PDFs" | **File Parser Lite** | "Free, fast, good enough" |
| "Image-based documents (scanned PDFs)" | **GLM-OCR model** | "Visual model, better at understanding image-based content" |
| "Batch processing many files" | **File Parser Expert** | "Cheapest per page, PDF-optimized" |

**Context-length mitigation:** `content_summary = parsed["markdown"][:8000]  # Truncate for token limits` — the **8,000-character truncation** is the only token-limit defense in both advanced_qa and deep_dive; no chunking/map-reduce strategy offered anywhere.

PDF→slides prompt template (advanced_qa, verbatim):
```
基于以下文档内容，制作一份教学课件PPT：

文档内容：
{content_summary}

要求：
- 提取核心概念和关键知识点
- 保留重要的图表描述（文档共{parsed['page_count']}页）
- 为每页添加思考题
- 风格：教育风，适合课堂投影
```
Pattern: content block + explicit requirements list + page-count fact injection + style directive + per-page thinking questions (advanced_qa). Deep dive's variant: `基于以下内容，创建关于"{topic}"的教学课件：\n\n{content[:8000]}  # Truncate to fit context\n\n要求：提取核心知识点，添加练习题，教育风格。`

---

## 9. Editing & State Model

**State key:** `conversation_id` persists across turns; full history is re-sent each turn (token cost grows over a session); interrupted streams resume by re-sending with the same ID; sessions persist "hours, not days"; "Conversation state may expire overnight"; expired IDs require a fresh conversation (guide, deep_dive).

**Text-only editing primitives (advanced_qa, verbatim triggers):**

| Operation | Trigger (verbatim, bilingual) | Tool |
|---|---|---|
| Modify a slide | "修改第3页" / "change page 3" | `modify_page` **(undocumented)** |
| Add a slide | "在第5页后插入新页" | `insert_page` |
| Delete slides | "删除第2,4页" | `remove_slides` |

"These are **text-driven edits** — you describe what you want changed, and the agent regenerates the affected slide(s). There is **no direct manipulation** (no dragging boxes, no WYSIWYG editor, no click-to-edit)." Editing = **regeneration** of affected slides; positions are 1-based; both Chinese and English edit phrasings work (advanced_qa).

**No annotations:** "The slide agent has **no built-in annotation, comment, or批注 (annotation) feature**." Output is "purely presentational HTML" (advanced_qa).

**DIY annotation layer (advanced_qa recipe):** `.annotation-layer` with `position: absolute`, `pointer-events: none`, `z-index: 9999` full-slide overlay; `.annotation-marker` 24px circle, `background: #e94560`, `pointer-events: auto` (re-enabled on markers only); `.annotation-popup` white card, 300px `max-width`, toggled via `.active` class; JS API `addAnnotation(slideIndex, x, y, text, author)` + `exportAnnotations()` → JSON persistence. ⚠️ The marker CSS uses `font-size: 12px` — micro-text violating Zlides22's AGENTS.md typography invariants (≥14px controls, ≥15px body); must be rescaled if adapted.

**Recommended hybrid workflow (advanced_qa, 5 steps):** 1. **Generate** via the agent (get HTML) → 2. **Serve** the HTML in an iframe with your annotation layer injected → 3. **Capture** annotations via the overlay → 4. **Persist** annotations separately from slide content → 5. **Regenerate** via the agent with the original `conversation_id` + modification request. "This separation (slides vs. annotations) is actually **better architecture** than native annotations — it lets you update slides without losing annotations, and vice versa."

**Single-pass rendering:** "you must request them in the initial prompt" (deep_dive [^45^]), because "the HTML structure is established during the first generation pass" — generation is effectively **single-pass per page**; later turns mutate existing structure (`modify_page`) rather than re-render. Consequence: HTML effects (particles, typewriter, hover zoom, etc.) requested in follow-ups "rarely work" (guide). Style/content/layout changes still work as regeneration requests (D3 stage 7).

**Negative state findings (deep_dive, verbatim):** "**No — the agent does not learn from interactions.**"; "It does not remember across different API keys"; "It does not learn from your feedback"; "It does not adapt its style based on your preferences over time"; "It does not 'get better'". Customization ladder: prompt engineering (Low) / post-processing (Medium) / "Model fine-tuning" (High) — "This is the only way to make the model genuinely 'learn' your style, terminology, and layout preferences."

**Variable page heights:** raw HTML has content-adaptive layout ⇒ inconsistent page heights across slides (guide treats as by-design). Fixes: (a) prompt cue "所有页面采用统一高度"; (b) CSS `!important` overrides (`.slide { width: 1280px !important; height: 720px !important; overflow: hidden !important; }`); (c) Puppeteer/Playwright fixed-viewport screenshots (guide).

---

## 10. Limits, Cost & Automation

- **Page limit:** practical **~15 pages per generation session**; beyond that quality degrades and slides may be cut off (guide, deep_dive [^45^]). Workaround: continuation ("继续生成剩余页面"), 10–12 pages per batch.
- **Timeout:** frontend code uses a **3,000,000 ms (50-minute) timeout**; "Agent can take 30-50 minutes" with GitHub Actions `timeout-minutes: 60` (guide, deep_dive).
- **Content safety:** error `1301` = safety violation; workarounds: avoid politically sensitive topics, indirect language, educational framing, or try Z.ai web UI ("sometimes different filtering rules than the API") (guide).
- **Error table (guide):** `1301` safety; Timeout >50 min ⇒ smaller requests; expired `conversation_id` ⇒ fresh start ("conversation_id expired → Start new conversation, regenerate from scratch" — advanced_qa's cross-ref); empty output ⇒ more specific prompt retry; truncated slides ⇒ fewer pages / lower density.
- **Cost envelope:** typical 10-slide deck ≈ **5,000–25,000 tokens** (~¥0.01–0.05; "hundreds of presentations for less than $1"; D2: "Cost: ~$0.01/deck — Hundreds per dollar"). Agent tasks consume **2–3× more tokens** than equivalent chat completions (thinking + tool overhead); pricing *may* carry a multiplier vs base rates (speculative — guide). Base rates (guide): GLM-4.5 ¥0.8/¥2.0 per 1M (in/out); GLM-4.5-Air ¥0.35/¥0.50; GLM-4.6 ¥1.0/¥2.0 (200K ctx); GLM-4.7 ¥0.5/¥1.0; GLM-4-Flash ¥0.1/¥0.1; context windows 128K except GLM-4.6's 200K.
- **Model restriction:** cannot select model via API; powered internally by **GLM-Experimental** series per Zhipu announcements (guide). Self-host params (vLLM): `temperature: 0.6`, `top_p: 1.0`, `max_tokens: 8192`, `enable_thinking: True` (guide).
- **Headless:** "100% headless by design… no browser, no GUI, no WebSocket" (deep_dive). D2: Docker-friendly, CI/CD (GitHub Actions, Jenkins), batch processing.
- **Compute placement (deep_dive, verbatim rows):** "**Serverless (Lambda)** | **Not recommended** | 50-min timeout exceeds Lambda max (15 min)"; "Queue-based (Celery/RQ) | **Ideal**".
- **Batch pattern (deep_dive):** `BatchSlideGenerator` — `asyncio.Semaphore(max_concurrent=3)`, `aiohttp.ClientSession`, `asyncio.gather(*tasks, return_exceptions=True)`; per-topic prompt template (verbatim): `作为{topic['audience']}老师，制作关于"{topic['title']}"的教学课件。输出{topic.get('pages', 10)}页，教育风格。`
- **CI/CD recipe (deep_dive):** `.github/workflows/generate-slides.yml`, cron `'0 2 * * 1'`, `workflow_dispatch` topic input, `GLM_API_KEY` secret, artifact upload from `output/`.
- **Canonical geometry (advanced_qa):** `{position: 1, width: 1280, height: 720}` — 1280×720 canonical slide canvas, positions 1-based.
- **Connection lifecycle:** multi-minute SSE holds are the norm; connection pooling irrelevant; client timeouts must accommodate multi-minute streams (advanced_qa).

---

## 11. Prompting Playbook

**Canonical prompt anatomy (guide):** `[Role] + [Topic] + [Audience] + [Requirements] + [Style] + [Format]`. Worked example (physics teacher deck, verbatim components): role "作为高中物理老师", topic "牛顿运动定律", audience "高一学生", requirements "概念讲解、公式推导、3个生活案例、课堂练习题", style "清新教育风，蓝绿色系，包含简单的物理示意图", format "输出12页，每页都要有标题和要点".

**Style keywords with reliability ratings (guide):** "科技感"/"tech style" (high), "简约风"/"minimalist" (high), "商务风"/"business" (high), "新拟物主义"/"neumorphism" (medium), "绿色教育风"/"green education" (high), "赛博朋克"/"cyberpunk" (medium), "复古风"/"vintage" (medium). D3 adds "科技感模板", "绿色简约风", "新拟物主义" (diagrams).

**Format cues (guide, prompt-cued — no API parameter):**

| Format | Trigger | Dimensions |
|---|---|---|
| Standard PPT | default | variable width, ~16:9 |
| Wide PPT | "16:9" / "宽屏" | 16:9 |
| Portrait Poster | "竖版海报" / "portrait poster" | 9:16 or 3:4 |
| Square | "正方形" / "1:1" | 1:1 |
| Xiaohongshu | "小红书" / "Xiaohongshu cover" | 3:4, **1080x1440** |
| A4 Document | "A4" / "简历" / "resume" | A4 |
| Long Image | "长图" / "long image" | extended vertical scroll |

Multi-format strategy: generate base deck → follow-up "把这份内容改成竖版海报格式" in the same `conversation_id` → export both with `include_html: true` (guide). D2 "Poster Mode" summarizes: 16:9, 9:16, 1:1, A4, long image.

**HTML effect injection triggers (guide):** the self-contained HTML includes inline CSS **and JavaScript**; triggers: "添加粒子背景特效"/"particle background"; "代码雨效果"/"Matrix code rain"; "雪花飘落效果"/"snow falling effect"; "鼠标悬停放大效果"/"hover zoom effects"; "打字机效果"/"typewriter effect"; "添加进度条动画"/"animated progress bars". **Critical rule: effects must be requested in the initial prompt** — follow-up effect requests "rarely work because the HTML structure is established during the first generation pass." D3 adds "代码雨", "粒子特效", "hover动画" (diagrams).

**Golden rules (verbatim list, guide):** 1) always `include_html: true`; 2) use Chinese prompts (agent optimized for Chinese); 3) specify everything upfront (style/page count/audience/format in first message); 4) reuse `conversation_id`; 5) post-process the HTML.

**"Template Seed" technique (guide):** seed visual design via explicit style references (Apple keynote minimalism: 大量留白 / 超大字体标题 / 单元素聚焦 / 黑白色调为主) plus literal hex codes ("品牌色：主色 #1a1a2e，辅色 #e94560，背景 #f5f5f5").

**"Outline-First" approach (guide, 4-turn pattern):** Turn 1 request outline ("帮我列一个…PPT大纲，需要10页…"); Turn 2 refine specific pages ("第3页太简单了…第5页换成…"); Turn 3 apply style ("整体风格改为深蓝色科技感，每页添加页码和章节指示器"); Turn 4 export ("导出PDF和HTML格式"). Claimed higher quality than one-shot.

**Upfront-animation example (deep_dive, verbatim):** `制作一个关于太阳系的教学课件，要求：- 包含一个可交互的3D地球模型（Three.js）- 行星轨道用动画展示 - 点击行星显示详细信息 - 整体风格：科技感，深色背景`.

**Edit triggers** (advanced_qa): positional, numbered, direct imperatives — "修改第3页" / "change page 3"; "在第5页后插入新页"; "删除第2,4页". Continuation: "继续生成剩余页面" / "继续" / "continue" (guide, diagrams).

**Post-processing contract (guide):** HTML structure is `<!DOCTYPE html>`, viewport meta, inline `<style>`; slides as `<div class="slide" data-slide-index="1">` containing `h1.slide-title` and `div.slide-content` (class names illustrative). Three strategies with code: (1) BeautifulSoup pipeline — prepend `:root { --primary-color: ... }` CSS variables; append placeholder divs with `data-regenerate="true"`; (2) CSS override system — appended `<style id="custom-override">` forcing `.slide { width: 1280px !important; height: 720px !important; overflow: hidden !important; }` plus brand-color overrides; (3) JS interactivity injection — click handlers calling `regenerateExercise(type)` → `fetch('/api/regenerate-exercise', ...)` back to your own backend or the GLM API.

---

## 12. Failure Modes & Mitigations

| Failure mode | Symptom | Mitigation | Source |
|---|---|---|---|
| Content-safety trigger | Error `1301` | Avoid sensitive topics; indirect language; educational framing; try Z.ai web UI ("sometimes different filtering rules than the API") | (guide) |
| Generation timeout | >50 min hangs | Smaller requests; progress-aware SSE handling; queue jobs; client timeout ~3,000,000 ms | (guide, deep_dive) |
| Expired `conversation_id` | Expiration error mid-session | Fresh conversation; regenerate from scratch; implement expiry detection + restart fallback | (guide, advanced_qa, deep_dive) |
| Empty output | Blank/garbage response | Retry with more specific prompt | (guide) |
| Truncated slides / page cliff | Slides cut off past ~15 pages | Fewer pages/turn (10–12); continuation "继续生成剩余页面" with same `conversation_id` | (guide, deep_dive) |
| Page-limit quality degradation | Beyond ~15 pages, quality degrades | Same as above; 25-page deck = 1–12 then 13–25 | (guide) |
| Variable page heights | Inconsistent slide heights | Prompt "所有页面采用统一高度" + CSS `.slide{width:1280px!important;height:720px!important;overflow:hidden!important}` + Puppeteer/Playwright fixed-viewport render | (guide) |
| Effects requested too late | Follow-up effect requests fail | Bake all HTML effects (particles, typewriter, hover zoom…) into the **initial prompt** | (guide, deep_dive) |
| SDK has no agent support | Forced into private `client._http_client.post(...)` | "**Skip the SDK**… Use raw HTTP with `requests` or `httpx`" | (advanced_qa) |
| Wrong SDK ↔ platform pairing | Legacy `zhipuai`→`open.bigmodel.cn` vs modern `zai-sdk`→`api.z.ai` mismatch | Match flavor to platform, or skip SDK entirely | (advanced_qa) |
| SDK can't parse agent SSE | Knows "nothing about `agent_id`, `conversation_id`, or the SSE stream phases" | Custom SSE parsing on raw `stream=True`; handle any `tool_name` | (advanced_qa, guide) |
| No native workflow save/preview/branch | "the agent has no native workflow engine" | History API + external `SlideWorkflowManager`; replay edit log; fork `conversation_id` sessions | (advanced_qa) |
| Snapshot fidelity loss | `html_preview: obj.get("output", "")[:500]` | Store full HTML externally | (advanced_qa) |
| No direct-manipulation editing | "no dragging boxes, no WYSIWYG editor, no click-to-edit" | Text-driven triggers ("修改第3页", "在第5页后插入新页", "删除第2,4页") | (advanced_qa) |
| No annotation system | "no built-in annotation, comment, or批注 (annotation) feature" | Inject HTML overlay (`z-index:9999`); persist annotations as separate JSON | (advanced_qa) |
| `modify_page` instability | "(undocumented)" — could change/disappear | Treat as at-risk; prefer `insert_page`/`remove_slides` where possible | (advanced_qa) |
| Token limits on ingested docs | Context overflow | `parsed["markdown"][:8000]` truncation; design real chunking (docs offer none) | (advanced_qa, deep_dive) |
| Infinite parse-polling loop | `while True` + `time.sleep(2)` never exits on failure | Add timeout/backoff/error branches (sample code has none) | (advanced_qa) |
| Size-cap rejections | PDF/DOC ≤100MB, XLS ≤10MB, images ≤20MB (Prime); ≤50MB (Lite); glm-ocr ≤50MB & 100 pages | Route by tier/size; pick parser by use case | (advanced_qa) |
| Lite free-tier expiry | "Free (until 2025-10-08)" — already past | Budget for paid tier | (advanced_qa) |
| Lambda incompatibility | 50-min generation > Lambda 15-min max | Queue-based (Celery/RQ) — "Ideal" | (deep_dive) |
| Conversation expiry in scheduled jobs | "Conversation state may expire overnight" | Expiry detection + restart-from-scratch fallback | (deep_dive) |
| Truncated base64 in sample code | `chart_base64[:100]` = invalid image | Pass full data URI or hosted URL; verify accepted formats empirically | (code_skills) |
| DIY `exec()` sandbox escape | Restricted-`__builtins__` escapable via traversal/`__import__` | Use E2B.dev or Docker; never DIY pattern with untrusted input | (code_skills) |
| Wrong SDK for agent SSE parsing | `parse_slide_response()` undefined; SDK blind to phases | Fetch SSE parsing contract from guide; write tool-name-agnostic parser | (code_skills, guide) |

---

## 13. Contradictions & Data-Quality Audit

| Topic | Docs in tension | Verdict / confidence |
|---|---|---|
| **Export vs history endpoint duality** | (guide) §2.3 calls `POST https://open.bigmodel.cn/api/v1/agents/conversation/` (trailing slash) the "Export endpoint" carrying `custom_variables`; (deep_dive) §5.2 and (advanced_qa) Q2 treat `/v1/agents/conversation` (no trailing slash) as the history/"Time Machine" endpoint whose `custom_variables` trigger export. D1 bottom bar: `Export: POST /api/v1/agents/conversation/ → Returns file_url (PDF/HTML)`; D3 stage 8: `POST /conversation/` + `include_pdf / include_html`. | Most likely **one dual-purpose endpoint** (custom_variables toggle export vs plain history return), but paths are never disambiguated in the docs. Low confidence — verify against live API. |
| **Model naming drift** | (guide): agent powered by "**GLM-Experimental** series"; chat lineup "GLM-4.5/4.6/4.7/5" and "GLM-5.1" appear in tables/prose; (code_skills): `glm-4.7` (Stage 1) vs `glm-5` (function-calling example), prose "GLM-4/4.5/4.7"; (deep_dive): "GLM-4.5/4.7 backbone", reserves `GLM-Experimental` for the AI Slides web UI, and lists dubious `glm-4.6v` vision model. | **Never reconciled anywhere.** Treat all version names as community-sourced/approximate (guide's own caveat). Low confidence in any specific model ID; verify with live API. |
| **SDK verdicts** | (advanced_qa): "**Skip the SDK** for the slide agent… The SDK has NO method for agent_id-based calls." (code_skills): SDK is "Partial — only through chat API, not agent". | **Consistent verdict: skip the SDK for the agent endpoint**; raw HTTP with `requests`/`httpx`. High confidence (both docs agree on mechanism). |
| **Conversation branching "yes vs no"** | (code_skills) matrix: "Conversation branching \| **Yes** via `conversation_id` \| Fork by reusing ID at different states"; (advanced_qa) matrix: "Branching workflows \| **No** \| Fork `conversation_id` sessions"; (deep_dive): branching as a history-endpoint use case ("Fork a conversation at any edit point"). | All three converge on the same **workaround** (fork/reuse `conversation_id`), but disagree on whether to call it native. No mechanism is ever shown. Medium confidence in the workaround; low confidence in semantics. |
| **Self-hosting claim conflict** | (deep_dive) competitor table: "Self-hosted Option \| **Yes** (model weights)". (guide) §4.3: self-hosting via vLLM/SGLang is "a **fundamentally different approach** — you lose the agentic capabilities". | deep_dive's own audit concedes the table "overstates". Self-hosting the weights ≠ the agent. High confidence: self-host loses agent tooling. |
| **Artifacts-via-API unverified** | (deep_dive) §4 attributes games/3D/physics to GLM-4.5 "Artifacts" reachable via prompting; (code_skills) states web-UI "All Tools" orchestration "cannot be replicated via the slide agent API" and "uses a different internal orchestration layer". | Artifacts is evidenced only as a GLM-4.5 **chat** capability (second-hand Chinese tech-press citations [^34^][^127^][^129^][^132^]); whether such JS ships through the agent endpoint's `insert_page` is **asserted, not demonstrated**. Low confidence — needs live probe. |
| **Dangling footnotes in all 4 docs** | (guide) `[^3^]…[^63^]`; (code_skills) `[^3^]…[^116^]`; (advanced_qa) 10 dangling refs; (deep_dive) `[^3^]…[^132^]` — no footnote-definition register exists in any file; numbering is consistent, implying one shared source list that was never included. | **Citation targets are unrecoverable from the doc set alone.** Treat citation-backed claims (especially animation capabilities) as unverified until the register is found or claims are live-tested. |
| **Sample-code bugs** | (code_skills) §5.2: `chart_base64[:100]` — truncated/invalid image payload; §5.2: `parse_slide_response(response)` referenced, never defined ("same as in the main guide" — external dependency); (advanced_qa) §5: `while True` + `time.sleep(2)` polling with no timeout/error branch — latent infinite loop; (advanced_qa) annotation marker `font-size: 12px` violates Zlides22 typography invariants; also `html_preview` truncated to `[:500]`, undefined `_get_slide_html()`/`_assemble_html()` helpers. | All samples are **illustrative pseudo-code, not working contracts**. Re-derive and fix before adoption; verify what image payload the agent actually accepts. |
| **`async-result` confidence divergence** | (guide): "purpose 'unclear'… speculative — the guide itself says the exact use case is unclear." (deep_dive): asserts purpose ("appears designed for retrieving results from asynchronous operations") + three use cases. | Endpoint existence is corroborated (frontend code) in both; semantics speculative in both. Treat as unverified. |
| **`glm-4.6v` vision model** | (deep_dive) lists it alongside `glm-4v-plus`, `glm-4.5v`; deep_dive's own audit calls the name "dubious/unverified". | Low confidence; verify model existence before coding against it. |
| **Bbox semantics** | (advanced_qa) Layout JSON `bbox` e.g. `[120, 80, 600, 200]` — "[x,y,w,h] vs [x1,y1,x2,y2] are never specified". | Unresolved; test with a known-geometry PDF. |
| **International parity** | (advanced_qa) "all endpoints given are `open.bigmodel.cn`; no `api.z.ai` equivalents for `/api/v1/agents`, `/v1/agents/conversation`, or the parser." | Unknown whether the agent exists on the international platform. |
| **Guide staleness** | (guide) dated **June 2026**; pricing/limits carry that caveat; Lite free-until-2025-10-08 already expired (advanced_qa). | All prices/limits are time-sensitive; re-verify. |

---

## 14. Actionable Takeaways for Zlides22

1. **Integration shape:** treat the slide agent as a stateful SSE endpoint — `POST https://open.bigmodel.cn/api/v1/agents` with `agent_id: "slides_glm_agent"`, `messages: [{role, content}]` (text-only parts), `stream: true`. Write raw HTTP (`httpx`/`requests`); skip `zhipuai`/`zai-sdk` for this surface (advanced_qa, diagrams).
2. **Build a generic SSE parser:** handle exactly four phases — `thinking`, `tool` (with arbitrary `tool_name`), `answer`, `error` (code `1301` = safety). Harvest slides from `insert_page` tool events (`output` = HTML, `position` = slide index) rather than the final `answer` (guide).
3. **Always export with both flags:** `custom_variables: {"include_pdf": true, "include_html": true}` on `POST /api/v1/agents/conversation(/)` — the raw self-contained HTML is the primary integration surface; expect multiple `file_url`s (guide).
4. **Front-load the styling contract:** bake role/audience/style/page-count/format AND all HTML effects into the **initial prompt**; follow-up effect requests rarely work (single-pass rendering) (guide, deep_dive).
5. **Cap turn length at ~10–12 pages** and paginate long decks via `conversation_id` continuation ("继续生成剩余页面"); implement conversation-expiry detection + restart fallback ("may expire overnight") (guide, deep_dive).
6. **Adopt the two-stage compute pipeline:** Stage 1 = `/api/paas/v4/chat/completions` (model per live verification; docs drift between `glm-4.7`/`glm-5`) + E2B.dev/Docker sandbox → matplotlib → full base64 PNG (fix the `[:100]` bug); Stage 2 = agent call with enriched prompt; verify empirically what image payload the agent accepts (code_skills).
7. **Build ingestion as a separate pre-processing layer:** File Parser (Prime for complex layouts, Expert for batch PDF at ¥0.012/page, Lite now paid) / `glm-ocr` for scans (≤50MB, 100 pages) / vision models (`glm-4.5v`) for images — agent endpoint accepts no files; truncate parsed markdown to ~8000 chars and design real chunking (advanced_qa, deep_dive).
8. **Copy the canonical geometry:** `{position: 1, width: 1280, height: 720}`; harden client timeouts to ~50 min; use `asyncio.Semaphore(3)` + `asyncio.gather(..., return_exceptions=True)` for batches; prefer Celery/RQ over Lambda (deep_dive, advanced_qa).
9. **Neutralize variable page heights deterministically:** prompt cue "所有页面采用统一高度" + CSS override `.slide { width:1280px!important; height:720px!important; overflow:hidden!important }` + Puppeteer/Playwright fixed-viewport render for final artifacts (guide).
10. **Build workflow semantics client-side:** use `POST /api/v1/agents/conversation` history as a version-control substrate (snapshots, diffs, branch-by-fork, audit trails); store prompt templates client-side; persist annotations as separate JSON via an injected overlay (raise its 12px markers to ≥14px) (advanced_qa, deep_dive).
11. **Do NOT copy:** DIY restricted-`exec()` sandbox (not a security boundary — use E2B/Docker); SDK-flavor mixing without platform matching; hardcoded 3-tool SSE parsers; `chart_base64[:100]` injection; unbounded `while True` polling (code_skills, advanced_qa).
12. **Probe the hidden surface before relying on it:** `/v1/agents/async-result` (serverless/queue unlocks if real), `access_page`/`modify_page` schemas, `/api/v1/agents` schema on `api.z.ai`, and whether Artifacts-style JS actually ships through the agent endpoint (guide, deep_dive).

---

## 15. Open Questions (needs live-API verification)

1. **Export-vs-history semantics:** is `/api/v1/agents/conversation` (no trailing slash) the same handler as `/api/v1/agents/conversation/` (trailing slash)? Does `custom_variables` on it trigger export, and what does a bare call return? Exact request body shape beyond `agent_id`, `conversation_id`, `custom_variables` is unshown (guide, deep_dive).
2. **`POST /v1/agents/async-result`:** does it exist in production, what is its request/response schema, and which operations are async? (guide: "purpose unclear"; deep_dive: speculative use cases).
3. **Model identity:** what model actually backs `slides_glm_agent` today (`GLM-Experimental`? GLM-4.5/4.7? GLM-5?)? Does `glm-4.6v` exist? Is there any indirect model-quality lever besides the Z.ai chat UI? (guide, code_skills, deep_dive).
4. **International parity:** does any of `/api/v1/agents`, `/v1/agents/conversation`, or the File Parser exist on `api.z.ai` with `zai-sdk`? (advanced_qa).
5. **Image ingestion contract:** what image payload does the slide agent actually accept in prompts (full base64 data URI? size cap? hosted URL?), given the doc's only sample is truncated to `chart_base64[:100]`? (code_skills).
6. **Hidden tool schemas:** exact `input`/`output` shapes for `access_page` and `modify_page`; reliability of `modify_page` under load; whether undocumented tools appear reliably in `phase:"tool"` events (guide, advanced_qa).
7. **Conversation branching mechanism:** how does "Fork `conversation_id` sessions" actually work — can one ID be reused at an earlier state, or does forking require a fresh ID seeded with history? (code_skills vs advanced_qa tension).
8. **Artifacts-through-agent:** do Flappy-Bird-class HTML5 games / Three.js scenes actually render from agent-endpoint prompts, or only via GLM-4.5 chat "Artifacts"? Second-hand tech-press evidence only (deep_dive).
9. **Footnote source register:** recover the missing shared bibliography (all `[^n^]` refs across 4 docs) before trusting citation-backed claims (esp. animation capabilities, pricing multipliers) (all cells).
10. **Export fidelity & pricing:** PDF-vs-HTML export fidelity, rasterization/pagination/font behavior (unaddressed in all docs), whether the suspected agentic token "multiplier" is real, and post-2025-10-08 Lite pricing (guide, advanced_qa, deep_dive).
11. **History-API response shape:** asserted `choices[].message[].content[].type == "object"` → `tool_name`/`input`/`output` structure is asserted, never evidenced with a real sample; whether history-replayed HTML equals live output (advanced_qa).
12. **Layout JSON bbox semantics:** `[x,y,w,h]` vs `[x1,y1,x2,y2]` in File Parser Prime output (advanced_qa).
