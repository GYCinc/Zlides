# Zlides — Canonical Specification (rev 4)

> Compiled Aug 2026. This document is the source of truth. If code and this spec disagree, **this spec wins**.

---

## ⛔ HARD CONSTRAINT #0 — NO PDF PIPELINE. AT ALL.

- **Zero PDF anything.** No taepdf, no WASM PDF compiler, no AcroForm/fillable-form export, no `pdf.download`, no print CSS (`@media print`), no page-break logic, no A4 pt-dimension injection.
- **Exports are pure HTML only.** A finished artifact is a self-contained HTML file.
- **No PNG export either.** Pure standalone HTML output.
- All taepdf dependencies, scripts, buttons, tests, branches, docs: **deleted**, not archived.

---

## ⭐ THE ENTIRE POINT OF THIS PROGRAM

**Give it ANYTHING → get a worksheet out.**

Any source material goes in — transcript, article, whiteboard notes, video transcript, Lesson Asset Card (LAC). The slide agent generates the structured worksheet natively.

---

## 1. Pure Client-Side SSE Architecture (Zero Python Middleware)

Zlides operates entirely as a high-performance **client-side GUI** communicating directly with the Z.AI Agent API (`https://api.z.ai/api/v1/agents`):
- **Direct SSE Stream Processing:** The browser streams Server-Sent Events straight from the API, live-rendering thinking in the Reasoning drawer and tool outputs into the preview `<iframe>`.
- **In-Memory File Ingestion:** Attached source files are read directly in the client via `file.text()` — no backend upload endpoints.
- **Client-Side Worksheet Vault:** Generated worksheets are saved into browser storage with instant search, reload, and one-click `.html` download.
- **Port 2828:** Served on port 2828 via `./launch.sh`.

---

## 2. Canonical Prompt Sequence (Non-Negotiable)

The client prompt builder strictly executes the 5-stage contract:

$$\mathbf{Format} \longrightarrow \mathbf{Structure} \longrightarrow \mathbf{Content} \longrightarrow \mathbf{Style} \longrightarrow \mathbf{Constraints}$$

| Layer | Purpose | Content |
|---|---|---|
| **1. Format** | Spatial envelope & viewport canvas | Document (A4 vertical) vs. Slides (16:9) vs. Responsive Webpage |
| **2. Structure** | Composition blueprint & section hierarchy | Modular categories, `<article class="card">`, `.dynamic-slot`, in-box `<button class="regenerate-btn">`, page count |
| **3. Content** | Delimited source material & prompt | Fenced `=== ATTACHED SOURCE REFERENCE MATERIAL ===` + `=== USER INSTRUCTIONS ===` |
| **4. Style** | Visual aesthetic **modifier** (never foundation) | Scoped CSS variables, Palette A tokens (`#0f1112`, `#ff6b35`, domain hues), typography (Fraunces / Raleway / Inter) |
| **5. Constraints** | Hard boundaries & pedagogical invariants | Negative directives: Zero PDF/PNG, ban "drill", mandatory Latinate verbs beside phrasal verbs, no COCA ranks, $\ge 13\text{px}$ text scale |

---

## 3. Tier-1 Formats

1. **Document (A4 Vertical)** — structured vertical flow for worksheets.
2. **Slides (16:9 Deck)** — presentation slide deck format.
3. **HTML Web Page** — fluid continuous layout.

---

## 4. Master Pedagogical Rules & Invariants

- **Ban the word "drill"**: Never use "drill" anywhere. Use "Practice", "Scenario", "Precision Check", or "Challenge".
- **Always Latinate Phrasal Verbs**: Every phrasal verb MUST show its Latinate single-word equivalent beside it (e.g., *slow down* $\to$ *Latinate: Decelerate*).
- **NO COCA Rank**: Do not include COCA frequency ranks on worksheets.
- **Word-Category Coloring**: Every individual target word carries its category accent color.
- **Inline Grammar Visibility**: Grammar section rules rendered inline and fully visible on Document format.
- **Card Indicator Rail**: 3px wide left indicator bar with vertical accent gradient.

---

## 5. Launch — Port 2828

- Launched via `./launch.sh` on **port 2828**.
- Cleans up stale processes, injects API keys from `.secrets.env`, and opens browser automatically.

---

## 6. Codebase Hygiene

- Pure client architecture: no intermediate Python proxy servers.
- Keep GitEnglish style pack and core contracts.
- Verification means the owner-visible output has been observed working for its stated purpose.
