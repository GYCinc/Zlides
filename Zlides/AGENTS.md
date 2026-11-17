# Zlides — Scope Contract

Binding for every agent and every session working in this folder. The app works.
Do not make it stop working.

## Rule 0 — Known-good state
Dev server on **:2727** (`bash launch.sh` from `Zlides/`), `bun test` green, `bun run build` clean.
If a change makes the app fail to render, that change is reverted — not "improved around".

## Allowed without asking — exactly these three
1. **Sidebar and stage presentation** — markup, layout, spacing, the logo, the composer.
2. **The option lists of the four dropdowns** (Layout · Content · Style · skill).
   The *injected text* behind them is owned by the contract files (see Forbidden).
3. **Documentation** — this file, `SPEC.md`, `PREFERENCES.md`.

## Forbidden without an explicit instruction — do not touch, in this order
1. `src/App.svelte` → `generate()` and the prompt assembly. The injection order is fixed:
   **Layout → Content → Style → PREFERENCES → active skill.** An active skill is last and
   overrides the slots above it; that is the whole point of a skill.
2. `src/lib/sse/parser.ts`, `src/lib/sse/placeholders.ts` — SSE parsing and page splitting.
3. `vite.config.ts` — `/save-slide`, `/saved`, export endpoints.
4. `src/contracts/lac.ts`, `lacSkill.ts`, `vig.ts`, `jsonRepair.ts` — LAC / VIG contracts.
5. `type/*.json`, `format/*.json`, `style/*.json`, `PREFERENCES.md` — the contract files.
   One rule, one place: geometry in `type`, structure in `format`, tokens in `style`,
   always-on rules in `PREFERENCES.md`.
6. **Never bring back `format/continuous-report.json`** — legacy. The only blueprint is
   `format/regenerating-worksheet.json`. Do not re-add it "for completeness".

## Standing UI spec — the owner's words, settled. Do not re-derive, do not ask.
1. **Top bar, left to right: Layout · Content · Style · skill select.** The second slot is
   called **Content**, never "Format" — agents read "format" as a third layout/style axis.
   Trigger labels show the value only (no category prefixes):
   `A4 Document` / `16:9 Slides` / `Fluid Webpage`;
   `None` / `Video Immersion Guide` / `Regenerating Worksheet` (+ saved content);
   `Auto` (first) / `gitEnglish` / `DESIGN.md` (+ saved styles);
   skill name or `Select skill`.
2. **Top bar, right: cost · PREFERENCES.md · Export · Vault · API Key.** Nothing else.
   The free space in the middle holds the status.
3. **The sidebar is one panel: the chat box (with the logo inside it) + the composer.**
   No greeting copy, no "Worksheet Engine" labels, no separate logo block.
4. **Composer: one visible writing line, two small icons on it** — paperclip (attach) left,
   arrow (send) right, an expand icon that opens the writing area large. Stop replaces the
   arrow while running. The writing box must be visibly framed (copy/paste/edit in place).
5. **Content and Style each have `Add new`** → a fill-in (name + text) pre-filled with the
   schema: style → the design.md schema he gave us, content → the blueprint. Saved entries
   appear in their dropdowns. This is the only "custom" path; there is no bare "Custom" item.
6. **PREFERENCES.md is its own thing**: taken with every call, reachable from the top bar.
   AGENTS.md has nothing to do with generation.
7. **Page navigation = one chevron on each edge of the page.** No page counter module.
8. **Labels come from his files** (`type/`, `format/`, `style/` `name` fields). No invented
   copy, no invented sublabels, no invented icons, no invented terms anywhere in the UI.
9. **Nothing is added unless he asks.** "Remove X" means delete — not relocate, not rename.
   Vertical space is never wasted. When he repeats an instruction, that is a hard stop
   signal plus a pending edit: execute it, verify by running the app, report measured facts.

## Method rules
- Edit source with the **edit tool**. Never Python or heredoc string surgery on a source
  file — it half-applies and reports success while the file is unchanged.
- **One change at a time.** After each: `bun test` → `bun run build` → headless screenshot
  → only then the next change.
- No new dependencies. No new files under `src/` unless asked.
- Never edit while a generation is running — HMR kills the stream mid-flight.
- **Commit after every verified change.** Any state must be one command from restorable.
- Report only what was verified by running it. "Build passes" is not "the app works".

## Recovery
- App shows a black screen → hard refresh (`Ctrl+Shift+R`). Still black → `bash launch.sh`.
- `git status` / `git diff` → see the last change. `git checkout -- <file>` → drop one file.
- `git revert <sha>` → undo a committed change.
