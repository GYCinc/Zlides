# Print-Friendly Output Design

**Date:** 2026-07-11
**Status:** Approved
**Scope:** Core infrastructure fix — benefits all formats (slides, poster, worksheet, report, rr)

## Problem

Generated HTML is never printer-friendly. All three failure modes occur:
1. Dark backgrounds print (wasting ink, unreadable)
2. Content gets cut off at page boundaries
3. Layout breaks in PDF export (columns collapse, elements overlap)

### Root Causes (from investigation)

| # | Cause | Location |
|---|-------|----------|
| A | System prompt gives zero print-friendly instructions | `slide_server.py` `build_system_prompt()` |
| B | `print_css` in style packs targets hardcoded class names (`.ge-card`, `.dark-card`) that the AI may not use | `style_bank/*.json` |
| C | Print CSS injection replaces ALL `</style>` tags, causing duplication on multi-slide docs | `slide_server.py:1079` |
| D | `/api/print` endpoint skips `print_css` injection entirely | `slide_server.py:1103-1267` |
| E | `extracted_1783507526.json` style pack has no `print_css` field | `style_bank/extracted_1783507526.json` |

## Solution

Universal, class-agnostic print CSS injected server-side into all generated HTML, plus injection bug fixes, system prompt enhancement, and a print mode toggle in the export UI.

### Design Decisions

- **Approach:** Universal CSS override (not server-side HTML transform, not prompt-only)
- **Print modes:** Two modes — "Print-friendly" (light) and "As-designed" (branded). User picks at export time.
- **Default mode:** Print-friendly (light) is the default for browser printing (Ctrl+P). PDF export offers both choices.
- **Scope:** Core infrastructure — all formats benefit automatically.

## Component Changes

### 1. Universal Print CSS Constant (`slide_server.py`)

A new module-level constant containing two `@media print` blocks:

**Light mode (print-friendly):**
```css
@media print {
  @page { size: A4; margin: 1.5cm; }
  * {
    background: white !important;
    color: #1a1a1a !important;
    box-shadow: none !important;
    text-shadow: none !important;
    border-color: #ccc !important;
  }
  section, .slide, [class*="card"], [class*="slide"] {
    page-break-inside: avoid;
  }
}
```

**Branded mode (as-designed, pagination only):**
```css
@media print {
  @page { size: A4; margin: 1.5cm; }
  section, .slide, [class*="card"], [class*="slide"] {
    page-break-inside: avoid;
  }
}
```

This CSS is class-agnostic — it uses `*` and attribute selectors (`[class*="card"]`) so it works regardless of what class names the AI invents.

### 2. Injection Logic Fixes (`slide_server.py`)

**Bug fix — duplicate injection (line ~1079):**
- Current: `slide_html.replace("</style>", print_css)` replaces all occurrences
- Fixed: Inject before `</head>` first. If no `</head>`, use `replace("</style>", print_css, 1)` — count=1, inject once only.

**Bug fix — `/api/print` missing injection:**
- Add universal print CSS injection to the `/api/print` endpoint's HTML assembly, same as `/command`.

**Injection order in `/command`:**
1. Style pack's own `print_css` (if present) — specific overrides
2. Universal print CSS — safety net
3. Inject both before `</head>` (or first `</style>` as fallback)

### 3. System Prompt Enhancement (`slide_server.py` `build_system_prompt()`)

Add print-awareness instructions to the system prompt:

> "Your HTML will be printed. Follow these rules:
> - Use `page-break-inside: avoid` on cards, sections, and self-contained content blocks.
> - Avoid fixed pixel heights on containers that should grow with content.
> - Prefer relative units (em, %, vh) over large fixed pixel dimensions.
> - Ensure text remains readable if backgrounds are removed."

This is a supplementary improvement — the universal CSS is the real safety net, but AI-generated print-aware HTML produces better results than CSS overrides alone.

### 4. PDF Export Mode Toggle (`index.html` + `frontend/app.js`)

**`index.html`:** Replace the single PDF button with two options:
- "PDF" (print-friendly, light mode) — default
- "PDF (Branded)" (keeps dark/branded colors)

Implementation: Either split into two buttons, or a small dropdown. Splitting into two buttons is simpler and matches the existing toolbar pattern (PNG | HTML | Fullscreen | PDF | PDF Branded).

**`frontend/app.js`:** `exportPdf()` function updated to accept a `print_mode` parameter and send it to `/export/pdf` as part of the options payload.

**`slide_server.py` `/export/pdf` endpoint:** Accept `print_mode` in options (`"light"` or `"branded"`). Default: `"light"`.

- **Light mode:** HTML already contains light-mode print CSS from generation. No changes needed — pass directly to Playwright.
- **Branded mode:** The HTML already contains the light-mode print CSS (injected during generation). The endpoint must strip the light-mode `@media print` block and replace it with the branded-mode block (pagination rules only, no color overrides). This is done via string replacement using the known CSS constant.

### 5. Browser Printing (Ctrl+P)

The generated HTML always includes the light-mode `@media print` block baked in. This means Ctrl+P from any browser automatically produces print-friendly output. No UI interaction needed.

If branded printing is desired, the user uses the PDF export button instead.

## What Does NOT Change

- On-screen preview — zero changes, keeps full branded look
- Style pack JSON files — no modifications needed
- Style pack loading system — untouched
- PNG/HTML export — untouched
- Generation flow / SSE streaming — untouched
- Frontend live preview — untouched

## Files Changed

| File | Changes |
|------|---------|
| `slide_server.py` | Universal print CSS constant. Fix injection (count=1, `</head>` first). Inject in `/api/print`. Add print mode support to `/export/pdf`. Add print instructions to `build_system_prompt()`. |
| `frontend/app.js` | Update `exportPdf()` to send `print_mode` option. |
| `index.html` | Add "PDF (Branded)" button alongside existing PDF button. |

## Testing

- Unit test: Verify universal print CSS is present in generated HTML from `/command`
- Unit test: Verify `/api/print` output includes print CSS
- Unit test: Verify no duplicate injection on multi-slide HTML
- Unit test: Verify `/export/pdf` with `print_mode: "light"` injects light CSS
- Unit test: Verify `/export/pdf` with `print_mode: "branded"` injects branded CSS
- Manual test: Generate a slide, Ctrl+P, confirm white background and no cut-offs
- Manual test: Generate a slide, export PDF both modes, confirm both produce clean output
