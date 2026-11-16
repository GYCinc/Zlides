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

## Standing UI spec — the owner's words, settled. Do not re-derive, do not ask.
1. **Sidebar, beside the logo, in this order: Layout · Format · Style.** Three slots, always
   there. Nothing else shares that row. Format may be `None`; Style may be `Auto (None)`.
2. Under them: the original **Worksheet | Video Guide** tab strip (Video Guide =
   Video Immersion Guide) and **one** Skills button. One place only — never both.
3. **Composer row: two small icons only** — a paperclip (attach) and an arrow (generate),
   32px. Stop replaces generate while running. No text buttons, no bottom action bar.
4. **Top bar: Export · Vault · API Key. Nothing else.** No engine dropdown, no Preview
   dropdown, no Contracts, no Skills, no "Page X of Y", no cost.
5. **Page navigation = one chevron on each edge of the page.** No page counter module.
6. **Cost** lives at the bottom of the sidebar, out of the way.
7. **Labels come from his files** (`type/`, `format/`, `style/` `name` fields). No invented
   copy, no invented sublabels, no invented terms anywhere in the UI.
8. **Nothing is added unless he asks for it.** If he says "remove X", X is deleted — not
   relocated, not re-labelled, not kept "for completeness".
9. When he says stop, stop. When he repeats an instruction, that is a hard stop signal
   plus a pending edit — execute it, don't re-derive it, don't ask again.

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
