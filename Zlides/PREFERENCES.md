# Universal Generation Preferences
Loaded on EVERY call. Hard rules only — not content, not style choices.

## Geometry
- Documents: physical units only — `width: 210mm; min-height: 297mm` (A4), `215.9mm × 279.4mm` (Letter). NEVER px for a document.
- Slides: px only (`1280 × 720`). Web: fluid, no fixed viewport, no pagination.
- `width: 100%; max-width: 100%`. Never a container wider than the printable or viewport bound.

## Typography
- No text below 13px. Body copy 15–16px. Controls and inputs 14px minimum.
- Never `JetBrains Mono`, `Manrope`, `Fira Code`, `Courier`, or developer monospace fonts as a reading or display font.
- No `background-clip: text` — gradient text clips render as blank or invisible text.

## Print
- `break-inside: avoid` ONLY on individual leaf items. Section wrappers: `break-inside: auto`.
- Print theme blocks must be complete — override body background AND container fills AND text contrast together.
- No `@page` rules, no print-only CSS.

## Output
- No CDN stylesheets or scripts. All CSS inline in one `<style>` element.
- Vocabulary: never the word "drill". Use "Practice", "Scenario", "Precision Check", "Challenge".
