# Zlides — Scope Contract

Binding for every agent and every session working in this folder. The app works.
Do not make it stop working.

## Rule 0 — Known-good state
Dev server on **:2727** (`bash launch.sh` from `Zlides/`), `bun test` green, `bun run build` clean.
If a change makes the app fail to render, that change is reverted — not "improved around".

## Allowed without asking — exactly these three
1. **Sidebar and stage presentation** — markup, layout, spacing, the logo, the composer.
2. **The option lists of the four dropdowns** (Layout · Format · Style · Skills).
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
