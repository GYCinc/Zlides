# SSE Pipeline Repair — Structured Stream Consumption

- **Date:** 2026-08-31
- **Status:** Draft
- **Owner:** hayron
- **Scope:** `Zlides/frontend_svelte/src/App.svelte` + new parser module. Client-side only.

## 1. One Sentence

Replace the regex blob-fusion SSE reader in App.svelte with a phase/tool_name-aware parser module that yields typed per-page slide events, surfaces every error class in the UI, and retains conversation_id for continuation and export.

## 2. Overview

The slide agent (`slides_glm_agent`) already emits structured, per-page SSE events — `phase:"tool"` + `tool_name:"insert_page"` + `position` + full-page HTML — but App.svelte discards that structure and re-fuses chunks into one blob with regex heuristics. This spec replaces the SSE consumption path with a framework-free typed parser module, splits pages by `position`, surfaces every error class, and persists `conversation_id` for continuation and real export.

## 3. Motivation

### Current State

App.svelte (935 lines) POSTs directly to `https://api.z.ai/api/v1/agents` with `agent_id:"slides_glm_agent"`, `stream:true` (App.svelte:339-359), then reads the stream with a hand-rolled line splitter (App.svelte:370-453). Four verified breakages:

- **B1 — Per-page structure destroyed.** Every `type:"object"` output is unconditionally pushed into `liveHtmlChunks` (App.svelte:416-417) with no `tool_name` or `position` inspection; after the loop, ALL pages are fused into one blob: `let finalHtml = liveHtmlChunks.length > 0 ? liveHtmlChunks.join("\n") : answerAccumulator` (App.svelte:456) and `slides = [{ html: finalHtml, ... }]` (App.svelte:464). The stepper — Prev/Next buttons and `Page {currentSlideIndex + 1} of {Math.max(1, slides.length)}` (App.svelte:773-798, counter at :785) — can never advance because `slides.length` is structurally always 1. Multi-page decks render as one scrollable iframe.
- **B2 — In-stream errors swallowed.** The parser throws on `chunk.status === "failed"` (App.svelte:387-391), but that throw happens inside the per-line `try` whose `catch` is `// Ignore single malformed SSE line` (App.svelte:448-450) — so error-phase events (code `1301` content-safety, agent-level failures) vanish silently and the UI shows "Ready! Saved as …" on an empty result. A second empty `catch {}` at App.svelte:413 swallows nested-JSON parse failures. HTTP-level errors (401/429) *do* reach the outer catch (App.svelte:471-484) but surface only as raw `API returned 401: Unauthorized` — no human mapping.
- **B3 — Regex-heuristic HTML extraction.** Page content is located by fenced-code-block regex and a hardcoded marker array scan (`['<!DOCTYPE','<html','<head','<style','<main','<section','<div','<body','<article']`) in `extractCleanHtml` (App.svelte:244-267) and `liveStreamHtml` (App.svelte:226-229), plus a manual unescape `s.replace(/\\n/g,"\n").replace(/\\"/g,'"')` (App.svelte:415) that double-unesces what `JSON.parse` already decoded (App.svelte:385) and mangles legitimate `\n` sequences inside HTML. No `tool_name` discrimination exists anywhere in the file (grep: zero matches) — violates the repo's no-heuristic-routing / explicit-data-contract rule.
- **B4 — `conversation_id` never captured.** The request body (App.svelte:346-357) omits it and no code reads the response stream for it (grep: zero matches). Consequences: no continuation beyond the ~15-page ceiling ("继续生成剩余页面"), no real export via `POST /api/v1/agents/conversation/` with `custom_variables:{include_html:true}` — export is a client-side blob download of the current slide only (`slides[currentSlideIndex].html` → `downloadHtmlFile`, App.svelte:763-764).

### Problems (user perspective)

1. "I asked for a 12-page deck and got one infinitely scrolling page" — pagination is a lie; the stepper is dead UI.
2. "Generation returned 'Ready!' with a blank preview" — content-safety (1301) and agent failures are invisible.
3. "Nothing tells me which page failed or why the stream died" — mid-stream drops keep the stale status string forever.
4. "I can't continue a long deck or fix page 3" — no continuation, no edit-turn surface, no server export.
5. "Preview flickers and reflows during streaming" — every chunk triggers full-blob regex extraction + iframe rebuild.

### Desired State

A new module `src/lib/sse/parser.ts` owns all wire-format knowledge. Public API sketch:

```ts
export type SseEvent =
  | { kind: 'thinking';        text: string }
  | { kind: 'page';            position: number; html: string; tool: string }   // insert_page (+ any HTML-bearing tool)
  | { kind: 'tool_misc';       tool: string; summary: string }                  // search, access_page, remove_slides, …
  | { kind: 'answer';          text: string }
  | { kind: 'stream_error';    code: string | null; message: string }           // error phase / status:"failed"
  | { kind: 'usage';           totalTokens: number }
  | { kind: 'done' };

export class SseParser {
  /** Feed one raw SSE "data:" payload (or full chunk); returns 0..n typed events. */
  push(dataStr: string): SseEvent[];
  /** conversation_id observed on any response event, else null. */
  readonly conversationId: string | null;
}

/** Byte-level SSE framing: "data: …" lines, [DONE], keep-alive comments, CRLF. */
export function feedSseFrame(buffer: string): { lines: string[]; rest: string };
```

App.svelte keeps only: fetch → `feedSseFrame` → `parser.push` → `switch (ev.kind)` → update `$state` (`pages`, `thinking`, `status`, `conversationId`). It stops owning any regex over slide HTML.

## 4. Research Findings

Source: `glm_ppt_agent_analysis.md` §3 (Architecture & API Contract), §5 (Tool Surface), §12 (Failure Modes), §14 (Takeaways). All community-reverse-engineered; treat wire specifics as "verify live in W1".

**SSE wire format.** Each event carries an incrementing `index` and exactly one of four `phase` values (analysis §3.3): `thinking` (fragmentary reasoning text), `tool` (emits `tool_name`, `input`, `output` — for `insert_page`, `output` is a **full HTML document** and tool output includes a **`position`** field, 1-based), `answer` (completion summary), `error` (e.g. code **1301** = content-safety trigger). Two **undocumented** tools exist — `access_page`, `modify_page` (analysis §5) — and flow through the *same* `phase:"tool"` channel with arbitrary `tool_name` values ⇒ **parsers must be tool-name-agnostic**; hardcoding the three documented names is an explicitly listed anti-pattern (§14.11). `conversation_id` is the multi-turn linchpin: re-send it to continue ("继续生成剩余页面"), resume interrupted streams, and fork sessions; it persists "hours, not days" and may expire overnight (analysis §4, §12).

**Error taxonomy** (analysis §12): `1301` content-safety trigger; `>50 min` generation timeout (client ceiling ~3,000,000 ms); expired `conversation_id` (mid-session expiry errors — implement detection + restart fallback); empty/blank output (retry with sharper prompt); page cliff beyond ~15 pages (turn cap 10-12 + continuation).

**Limits:** ~15 pages practical per conversation, quality degrades beyond; 50-minute timeout ceiling; canonical geometry `{position: 1, width: 1280, height: 720}`; export via `POST /api/v1/agents/conversation/` + `custom_variables:{"include_html":true}` → `file_url` to self-contained HTML with inline CSS (analysis §3.4, §14.3).

**Wire event → current → required handling:**

| Wire event | Current handling (App.svelte) | Required handling |
|---|---|---|
| `phase:"thinking"` text | Appended to `thinkingAccumulator`, shown in chat (App.svelte:425-429) | Same, routed via typed event |
| `phase:"tool"` `insert_page` | `obj.output` string-mangled (`out.html \|\| out.content`, :405), double-unesced (:415), pushed to shared chunk array (:416) — **`position` ignored** | Yield `{kind:'page', position, html}`; store verbatim, no regex |
| `phase:"tool"` other/unknown | Same bucket as insert_page — fused into blob (B1) | Yield `{kind:'tool_misc'}`; logged to chat; never touches pages |
| `phase:"answer"` text | Fed into `liveStreamHtml()` regex preview (:435) — wrong channel | Yield `{kind:'answer'}`; completion status only |
| `phase:"error"` / `status:"failed"` | Thrown :390 → swallowed by per-line catch :448-450 | Yield `{kind:'stream_error', code, message}` → surfaced ≥14px white-on-dark |
| `chunk.usage` | Token/cost computed (:442-447) | Same via `{kind:'usage'}` |
| `conversation_id` | **Never read** (B4) | Captured by parser; persisted to localStorage |
| HTTP 401/429/5xx | Outer catch, terse `Error: API returned …` (:471-484) | Mapped to human message + actionable hint |
| Keep-alive lines / `[DONE]` | Non-`data:` and `[DONE]` skipped (:380-382) | Same, formalized in `feedSseFrame` |

**Key finding:** the API already delivers everything the UI needs — page boundaries, page order, error codes, session identity — as structured fields; App.svelte discards that structure and reconstructs it heuristically.
**Implication:** the fix is not adding intelligence but *removing* a destructive layer: parse → typed events → `$state` map, one direction, zero content sniffing.

**Reference wire fixture** (shape synthesized from analysis §3.3 + current code's field reads; exact envelope verified live in W1 before freezing tests):

```
data: {"index":1,"phase":"thinking","delta":{"content":[{"type":"text","text":"Plan 5 slides…"}]},"conversation_id":"abc123"}
data: {"index":2,"phase":"tool","tool_name":"insert_page","output":"<!DOCTYPE html>…","position":3, …wrapped in choices[].messages[].content[type=object]}
data: {"index":9,"phase":"answer","delta":{"content":[{"type":"text","text":"Deck complete"}]}}
data: {"status":"failed","error":{"code":1301,"message":"content filtered"}}
data: {"usage":{"prompt_tokens":812,"completion_tokens":24001}}
data: [DONE]
```

Parser must accept both the flat envelope (error/usage/conversation_id at top level — the only shape current code already reads, :387, :442) and the `choices[].messages[]` wrapper (content events, :393-397).

## 5. Design Decisions

| ID | Decision | Class | Rationale / constraint |
|---|---|---|---|
| D-a | Dedicated framework-free parser module `src/lib/sse/parser.ts` (no Svelte imports, no DOM) | 3 (taste) | App.svelte already 935 lines; parser must be unit-testable under plain bun/tsx without mounting Svelte. Constraint, not preference. |
| D-b | Discriminated-union typing (`SseEvent`) keyed on **structured fields only** (`phase`, `tool_name`, `status`, `code`) | 1 (evidence) | Wire contract defines exactly 4 phases (analysis §3.3); repo rule bans heuristic substring/content routing. No `.includes("style")`, no marker arrays. |
| D-c | Pages state: `pages = $state<{position:number; html:string}[]>([])`, kept sorted by `position` (1-based), duplicates overwrite, gaps placeholder | 2 (coherence) | Matches canonical geometry `{position, width:1280, height:720}` (analysis §3.4); stepper indexes sorted array; `iframeSrcDoc` *derives* from `pages[currentSlideIndex]` instead of being a second source of truth. |
| D-d | `conversation_id` captured by parser → `$state` + `localStorage('zlides_conversation_id')` with capture timestamp | Owner call | Least-mechanism persistence honoring zero-backend constraint; hours-scale expiry (analysis §4) means timestamp lets continuation degrade gracefully. |
| D-e | Error taxonomy mapping (1301 / auth / network / timeout / expired-conversation / empty-output) → fixed human messages, ≥14px, white on dark | 1 + 3 | Both are documented failure classes (analysis §12); typography invariants ban micro/low-contrast text (AGENTS.md #4). |
| D-f | Export (W4) via `POST /api/v1/agents/conversation/` + `custom_variables:{include_html:true}`; client blob download kept as fallback | 1 | `include_html` returns self-contained HTML `file_url` (analysis §3.4, §14.3). SPEC.md #0 is PDF-specific; we send `include_html` only, never `include_pdf`. |
| D-g | **Rejected:** Python compute stage / SDK middleware — permanently out of scope | — | SPEC.md Hard Constraint #0 + "Zero Python Middleware" (§1); analysis §14.11 verdict "skip the SDK". |
| D-h | **Rejected:** content-sniffing fallback ("looks like HTML") for classifying tool outputs | — | Banned by no-heuristic-routing rule; hidden tools (§5) make content-based classification fragile by construction. |
| D-i | **Deferred:** two-stage chart pipeline (chat-completions Stage 1 + sandbox) | — | Explicitly rejected alternative per task context; revisit only if agent cannot render requested charts. |

**SPEC.md precedence notes:** (1) Port 2828 + pure-client architecture confirmed unchanged. (2) SPEC.md §2's 5-stage prompt contract untouched — this spec changes only *consumption* of the response stream. (3) Analysis doc's host is `open.bigmodel.cn`; live code uses `api.z.ai` (App.svelte:339) — code wins (it demonstrably streams); flagged in Open Questions.

## 6. Architecture

```
 browser (client-side only — SPEC.md §1, zero Python)
 ┌────────────────────────────────────────────────────────────────────────┐
 │  App.svelte                                                            │
 │    generate()                                                          │
 │      │  POST https://api.z.ai/api/v1/agents                            │
 │      │  { agent_id:"slides_glm_agent", messages,                       │
 │      │    conversation_id?, stream:true }        ─── W3: send persisted│
 │      ▼                                                                 │
 │    fetch SSE stream ──► feedSseFrame()  (byte framing, [DONE],         │
 │      │                          keep-alive comments)                   │
 │      ▼                                                                 │
 │  ┌───────────────────────────┐   src/lib/sse/parser.ts                 │
 │  │ SseParser.push()          │   framework-free, no DOM               │
 │  │  phase:"thinking" ────────┼──► {kind:'thinking'}  → reasoning drawer│
 │  │  phase:"tool"             │                                        │
 │  │   tool_name:"insert_page"─┼──► {kind:'page',position,html}         │
 │  │   any other tool_name ────┼──► {kind:'tool_misc'} → chat log only  │
 │  │  phase:"answer" ──────────┼──► {kind:'answer'}    → status         │
 │  │  phase:"error"/failed ────┼──► {kind:'stream_error'} → UI surface  │
 │  │  usage ───────────────────┼──► {kind:'usage'}     → token/cost     │
 │  │  conversation_id ─────────┼──► parser.conversationId (captured)    │
 │  └───────────────────────────┘                                        │
 │      ▼                                                                 │
 │    pages $state: [{position,html}] sorted ──► iframe stepper           │
 │      (Prev/Next, "Page X of Y" now functional — fixes B1)              │
 │      │                                                                 │
 │      ├─ export now:   blob download of pages[i].html  (fallback)       │
 │      └─ export W4:    POST /api/v1/agents/conversation/                │
 │                       custom_variables {include_html:true} → file_url  │
 └────────────────────────────────────────────────────────────────────────┘
```

Layer rule: **the parser is framework-free; App.svelte only consumes typed events.** No slide HTML ever passes through a regex in App.svelte. `iframeSrcDoc` becomes a derived view of `pages[currentSlideIndex]` (one source of truth).

App.svelte consumption sketch (the entire per-line body it replaces — old loop was :379-451):

```ts
for (const frame of feedSseFrame(buffer)) {
  for (const ev of sseParser.push(frame)) {
    switch (ev.kind) {
      case 'thinking':     thinking += ev.text; break;
      case 'page':         upsertPage(ev.position, ev.html); break;   // sorted $state
      case 'tool_misc':    logToolChat(ev.tool, ev.summary); break;
      case 'answer':       answerText += ev.text; break;
      case 'stream_error': failStatus(ev.code, ev.message); break;    // surfaced, never retried silently
      case 'usage':        setUsage(ev.totalTokens); break;
      case 'done':         finishStatus(); break;
    }
  }
}
```

No `catch` inside this loop: `push()` throws only on programmer error; malformed wire data is an *event*, not an exception (see Edge Cases).

## 7. Implementation Plan

Each wave: **Build → Prove → Remove.** All waves client-side; no file other than App.svelte, `src/lib/sse/*`, config hygiene.

**W1 — Parser module (pure)**
- [ ] `src/lib/sse/parser.ts`: `feedSseFrame()` byte framing + `SseParser` class emitting the 7 `SseEvent` kinds; tool-name-agnostic (unknown tools → `tool_misc`); capture `conversation_id` from any event field; no regex over HTML bodies.
- [ ] `src/lib/sse/parser.test.ts` + plain bun/tsx runner script: fixtures for thinking/tool(answer for insert_page with position)/error(1301)/usage/[DONE]/keep-alive/malformed-JSON line (skipped, not swallowed).
- [ ] Prove: `bun test src/lib/sse` (or tsx script) green; all 4 phases + framing cases covered.

**W2 — App.svelte rewire**
- [ ] Replace lines ~370-453 loop: fetch stays (:339-359), loop becomes `feedSseFrame` → `parser.push` → `switch (ev.kind)`.
- [ ] `pages` `$state` replaces `liveHtmlChunks`; `pages[position] = html`, sorted; delete B1 fusion (:456-465) → `slides` derived from `pages`.
- [ ] Stepper (:773-798) works as-is once `slides.length > 1`; add "Page N missing" placeholder iframe for position gaps.
- [ ] Error surface: `stream_error` events + mapped HTTP errors render in chat + status bar (≥14px white-on-dark); delete both empty catches (:413) and the swallowing catch (:448-450).
- [ ] Remove `liveStreamHtml()`/`extractCleanHtml()` regex paths (:220-276); streaming preview shows latest `insert_page` page directly.
- [ ] Prove: svelte-check + tsc clean; manual smoke on :2828 — a 5-page prompt yields 5 steppable pages.

**W3 — conversation_id + continuation**
- [ ] Capture `parser.conversationId` → `$state` + `localStorage('zlides_conversation_id')` + timestamp; send it on subsequent `generate()` calls (request body :346-357 gains `conversation_id`).
- [ ] "Continue" button ("继续生成剩余页面" for the >15-page cliff): sends continuation message with same id; appends new pages by position.
- [ ] Expiry fallback: if stream errors with expired/expired-session symptom, clear stored id, surface "session expired — starting fresh" (message class from D-e).
- [ ] Prove: two-turn conversation reuses id (visible in devtools request); >15-page deck continues to page 13+.

**W4 — Real export**
- [ ] `POST https://api.z.ai/api/v1/agents/conversation/` with `custom_variables:{include_html:true}` + `conversation_id`; fetch `file_url`; download it; keep client blob download as fallback when endpoint 404s/errors.
- [ ] Verify live the export-vs-history endpoint duality (Open Question Q1) before relying on shape.
- [ ] Prove: export produces a self-contained HTML file (inline CSS, opens offline).

**W5 — Prove (gate for all waves)**
- [ ] `svelte-check` and `tsc` clean.
- [ ] Manual smokes on localhost:2828: (a) multi-page prompt → stepper paginates; (b) safety-trigger prompt → 1301 visible in UI; (c) network kill mid-stream (devtools offline) → partial pages kept + explicit "connection lost" state; (d) export produces an HTML file; (e) key removed → auth message readable.

**W6 — Remove**
- [ ] Dead regex path: `liveStreamHtml` (:220-238), `extractCleanHtml` (:240-276), chunk-join finalize (:455-465) — deleted, not archived.
- [ ] `streamdown-svelte` (package.json:30) — verify zero imports first (`rg "streamdown" src/`), then uninstall.
- [ ] Ghost `pkill -9 -f "slide_server.py"` in launch.sh:35 — no Python exists (SPEC.md #0); line removed.
- [ ] Empty `catch {}` blocks in vite.config.ts (:44 title-read, :60 mtime fallback) — narrow to real error handling or remove.
- [ ] Prove: `rg -n "extractCleanHtml|liveHtmlChunks|slide_server" .` returns nothing in src/; boot log unchanged except removed warnings.

## 8. Edge Cases

| Case | Behavior |
|---|---|
| SSE drop mid-stream (network kill) | Keep already-received `pages[]`; `status` switches to explicit "Connection lost — N pages retained"; no silent "Ready!". Resume path = W3 continuation with same `conversation_id`. |
| Error `1301` (content safety) | `{kind:'stream_error', code:'1301'}` → fixed human message ("Content filtered by provider — rephrase or adjust source material"), never swallowed; generation marked failed, partial pages still viewable. |
| Auth failure (HTTP 401/403) | Outer catch maps to "API key invalid or missing — check Settings"; modal hint; no raw status-string dump. |
| Duplicate `position` in one stream | Later event overwrites earlier page at that index (agent regenerates page N mid-stream is legal). |
| Missing position / out-of-range | Page stored with its own position; stepper renders placeholder card "Page N not delivered" for gaps; no re-indexing of other pages. |
| >15 pages requested | Per analysis §12, expect page cliff: UI surfaces "long decks continue in batches" after ~12th page; continuation button (W3) is the path forward. |
| 50-min timeout | AbortController watchdog at ~3,000,000 ms (analysis §12); on fire → "Generation exceeded provider time limit", partial pages kept. |
| Expired `conversation_id` on continuation | Expiry-error detection (symptom verified live in W3) → clear localStorage entry, human message, offer fresh generation. |
| Empty `output` / zero pages | Never fabricate the :460 "No document returned." blob as a slide; instead stream_error-style status "Agent returned no pages" + answer text shown in chat. |
| Keep-alive comment lines (`: ping`) | Consumed by `feedSseFrame`, emit nothing; `buffer` never grows unbounded. |
| Malformed JSON on a data line | Frame is skipped and *counted*; ≥3 consecutive malformed frames → stream_error (distinguishes noise from protocol drift). A thrown `stream_error` (B2) is never treated as malformed. |

## 9. Open Questions

1. **Export/history endpoint duality** — `POST /agents/conversation/` (trailing slash, export via `custom_variables`) vs `/agents/conversation` (history) may be one dual-purpose endpoint or two; paths "never disambiguated in the docs" (analysis §13, low confidence). Verify live in W4 before relying on response shape; `file_url` presence is the acceptance signal.
2. **Vault 404s in built mode** — saved-slides list works under `launch.sh` dev proxy but 404s when served statically (vite.config.ts middleware is dev-only). Out of scope here; defer to a storage spec unless W2 smoke is blocked.
3. **English vs hybrid-Chinese prompts** — analysis's highest-signal triggers are verbatim Chinese ("科技感模板", "继续生成剩余页面", "所有页面采用统一高度") and the agent is Chinese-first. **Recommendation: hybrid** — keep English framing, embed the exact trigger strings (verbatim) for style/continuation/uniform-height directives; A/B test one deck each in W3.
4. **Edit-turn UI (`modify_page`)** — surgical edits ("修改第X页") are an at-risk undocumented surface (analysis §5, §12). Follow-up spec: edit-turn drawer sending "修改第X页：…" with same conversation_id, parser already yields its output as `page` events. Not built here.
5. **api.z.ai vs open.bigmodel.cn** — code targets `api.z.ai` (App.svelte:339) while all analysis endpoints are `open.bigmodel.cn`; the international agent endpoint is flagged "unknown parity" (analysis §13). Live code wins, but W4 export must probe `api.z.ai` path first, `.cn` fallback second.

## 10. Adjacent Work (explicitly out of scope, listed to avoid scope creep)

- Svelte 4→5 event directives (`on:click` etc., e.g. App.svelte:680-681, :712, :740) — mechanical migration, boot warnings only.
- a11y warnings App.svelte:891 — separate polish pass.
- Unused chain-of-thought components / dead JSON contract files in the repo — hygiene sweep after W6.
- `saveSlideToStorage` vault layer — only touched if export wave requires it.

## 11. Success Criteria

- [ ] Multi-page prompt produces N steppable pages; "Page X of Y" advances both directions (B1 dead).
- [ ] Every failure class (1301, auth, network kill, timeout, empty output, expired conversation) renders a human-readable message ≥14px white-on-dark; zero silent failures in the SSE path.
- [ ] `svelte-check` and `tsc` clean; boot log free of new warnings.
- [ ] Zero empty catches anywhere in the SSE path (App.svelte:413, :448-450 gone).
- [ ] No regex/heuristic content-sniffing in slide-HTML handling; parser routes on structured fields only.
- [ ] `conversation_id` persisted and sent on turn 2 (devtools-verified).
- [ ] Export downloads an openable self-contained HTML file (endpoint or blob fallback).
- [ ] Parser unit tests pass: 4 phases + framing + malformed-line + duplicate-position fixtures.

## 12. References

- `Zlides/frontend_svelte/src/App.svelte` — read :220-300, :330-500, :680-800; modified in W2/W3 (935 lines total).
- `src/lib/sse/parser.ts` + `parser.test.ts` — new, W1.
- `Zlides/SPEC.md` — rev 4 source of truth; Hard Constraint #0 (no PDF), §1 zero-Python client architecture, §5 port 2828.
- `Zlides22/AGENTS.md` — payload audit first, no heuristic routing, typography invariants (≥14px, white-on-dark), no arbitrary stage clamps.
- `glm_ppt_agent_analysis.md` — §3 API contract (phases, position, custom_variables), §5 tool surface (5 tools, history endpoint), §12 failure modes (1301, timeout, expiry, page cliff), §14 takeaways (tool-name-agnostic parser, skip SDK, include_html export).
- `launch.sh` — :35 ghost `pkill slide_server.py` (W6).
- `frontend_svelte/vite.config.ts` — :44/:60 empty catches (W6).
- `frontend_svelte/package.json` — :30 `streamdown-svelte` dependency (W6, verify-then-remove).
