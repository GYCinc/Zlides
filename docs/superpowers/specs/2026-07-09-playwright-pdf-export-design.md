# Design: Server-Side PDF Export via Playwright

## Goal
Replace the browser-dependent `window.print()` PDF export in Zlides with a deterministic, server-side HTML-to-PDF pipeline using Playwright + headless Chromium.

## Background
- Zlides generates styled HTML presentations/worksheets/posters/reports.
- Current PDF export opens the HTML in a new tab and calls `window.print()`, which is inconsistent across browsers and OS print drivers (e.g. Safari print-to-PDF no longer available to the user).
- The agent already emits full HTML documents with inline styles and optional `print_css` from the style bank.

## Proposed Architecture

```
Frontend (Svelte or vanilla JS)
        │ POST /export/pdf { html, options }
        ▼
FastAPI (slide_server.py)
        │ launch Playwright + Chromium
        │ page.set_content(html)
        │ page.pdf(...)
        ▼
StreamingResponse (application/pdf)
```

## Backend Changes

- Add `playwright>=1.40.0` to `pyproject.toml` dependencies.
- Add helper `html_to_pdf(html: str, **options) -> bytes` in `slide_server.py`.
- Add `POST /export/pdf` endpoint:
  - Accepts JSON `{ "html": "...", "options": { ... } }`.
  - Optional options: `format` (e.g. "A4", "Letter"), `landscape` (bool), `margin` dict, `print_background` (bool, default true).
  - Returns PDF bytes as `StreamingResponse` with `Content-Disposition: attachment; filename="slide.pdf"`.
- Graceful error if Playwright/Chromium is not installed (clear HTTP 500 message).

## Frontend Changes

### Svelte (`frontend_svelte/src/App.svelte`)
- Replace `exportPdf()` implementation:
  - POST current slide HTML to `/export/pdf`.
  - Convert response blob to object URL.
  - Trigger download via hidden `<a>`.

### Vanilla (`frontend/app.js` + `index.html`)
- Add `exportPdf()` function in `frontend/app.js`.
- Change root `index.html` PDF button from `onclick="window.print()"` to `onclick="exportPdf()"`.

## Page Splitting & Visual Fidelity

Playwright renders HTML exactly like Chromium, so it respects:
- `@page { size: A4 landscape; margin: 0; }`
- `page-break-before`, `page-break-after`, `page-break-inside`
- `orphans`, `widows`
- Web fonts and images (base64 or same-origin/CORS)
- `print_background: true` ensures background colors/images render

## Deployment Notes

- After installing the Python package, run `playwright install chromium` to download the browser binary.
- Chromium binary is ~150–200 MB; first launch is slower, subsequent PDFs reuse the running browser context.
- For containerized deployment, install browser dependencies with `playwright install-deps chromium`.

## Error Handling

- Missing Playwright package → clear backend error at startup or request time.
- Chromium not installed → instruct user to run `playwright install chromium`.
- Invalid HTML → Playwright still produces a PDF; garbage-in-garbage-out is acceptable.

## Testing

- Add a pytest test that calls `/export/pdf` with a minimal HTML document.
- Assert response status is 200, content-type is `application/pdf`, and response body starts with `%PDF-`.
- If Playwright/Chromium is unavailable, skip the test with a clear message.

## Out of Scope

- Remote PDF microservice (Gotenberg, DocRaptor).
- Caching generated PDFs.
- Batch export of all slides at once.
- Advanced PDF options (headers/footers with page numbers) — can be added later via the `options` payload.
