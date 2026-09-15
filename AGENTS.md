# Antigravity Global Engineering Directives & Core Preferences

## 1. Zero Superficial Assumptions (Payload Audit First)
- Never claim a pipeline, feature, or generation works simply because an HTTP endpoint returned `200 OK`, a build succeeded, or code compiled cleanly.
- Always audit the exact end-to-end data payload: verify what prompt strings, system directives, file contents, and format contracts actually reached the model context.
- Test edge cases and actual output generation before declaring something "bulletproof" or "ready."

## 2. No Fragile Heuristic or Substring Routing
- Never use heuristic substring checks (e.g. `prompt.includes("style")` or `if "slides" in text`) to determine control flow, parameter types, or file classifications.
- Use explicit data contracts, discrete UI state flags, dedicated endpoint fields, and strict MIME/type mappings.

## 3. Delimited Source Material Contracts
- When ingesting reference documents, lesson notes, or user attachments, always fence and label the source material explicitly with clear markdown delimiters:
  ```markdown
  === ATTACHED SOURCE REFERENCE MATERIAL (<filename>) ===
  ```markdown
  <file content>
  ```

  === USER INSTRUCTIONS ===
  <user prompt>
  ```
- Never dump raw unformatted text into the model without clear sectional boundaries.

## 4. UI Typography, Legibility & Contrast Invariants
- Banish microscopic fonts: No `10px`, `11px`, or `12px` micro-text for primary content.
- Standard sizing hierarchy:
  - Inputs, select dropdowns, and button controls: `14px` minimum (`text-sm`).
  - Body prose, chat messages, and composer textarea: `15px–16px` (`text-base`).
  - Chain-of-Thought / Reasoning stream: `16px–18px` (`text-lg`) with comfortable line spacing (`leading-relaxed`).
- High contrast is mandatory:
  - Always use pure white (`#ffffff`) or high-luminance text on dark surfaces.
  - Never use low-contrast dark grays or shades that blend into the background.

## 5. Responsive Stage Fitting (No Arbitrary Minimum Clamps)
- Never hardcode arbitrary pixel barriers (like `max(740px, ...)`) on responsive preview stages or canvases.
- Canvases must dynamically scale down within available viewport constraints (`max-width: 100%`, `max-height: calc(100vh - ...)`).
- Stage wrappers must use `overflow: hidden` with zero-scrollbar rules so outer scrollbars never eat into the page canvas.

## 6. Core Operating Philosophy
- "Polishing, not changing. Patching, not rewriting. Listening, not assuming."
