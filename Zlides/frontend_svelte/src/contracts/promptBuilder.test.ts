import { describe, expect, test } from "bun:test";
import { assemblePrompt } from "./promptBuilder";

// ── Three-Zone Payload Law (SPEC §2.1) ──
// TOP (archetype trigger, then template) → MIDDLE (fenced content) → BOTTOM (style last).
// Engine reality: slides_glm_agent has NO format parameter — the archetype trigger in
// lines 1–2 is the only lever, and structure locks in the first generation pass.

const TYPE_CONTINUOUS = [
  "Format: Continuous vertical visual document (HTML single-scroll report).",
  "Layout Engine: Responsive auto-height container. No slides, no fixed viewports, no pagination.",
  "Native mode cue: 长图 / long image — extended vertical scroll, content-adaptive section heights.",
  "Output contract: one self-contained standalone HTML document (inline CSS/JS) — return only the HTML.",
].join("\n");

const FORMAT_BLUEPRINT = [
  "TEMPLATE BLUEPRINT (Structural Composition & Component Hierarchy — No Style Rules):",
  "1. DOCUMENT FLOW: <main> → <header> → modular <section data-section> containers, auto-height.",
].join("\n");

const STYLE_TOKENS = [
  "[VISUAL & COMPONENT SPECIFICATIONS]",
  "- Theme: Dark engineering spec (charcoal surface, electric blue accent).",
].join("\n");

const USER_TEXT = "Generate a report on event-driven vs RPC communication.";

describe("three-zone payload law", () => {
  test("archetype trigger occupies lines 1–2", () => {
    const p = assemblePrompt({
      typeText: TYPE_CONTINUOUS,
      formatText: FORMAT_BLUEPRINT,
      userText: USER_TEXT,
      styleText: STYLE_TOKENS,
    });
    const lines = p.split("\n");
    expect(lines[0]).toBe("Format: Continuous vertical visual document (HTML single-scroll report).");
    expect(lines[1]).toBe("Layout Engine: Responsive auto-height container. No slides, no fixed viewports, no pagination.");
  });

  test("zone order: type → template → fenced content → style", () => {
    const p = assemblePrompt({
      typeText: TYPE_CONTINUOUS,
      formatText: FORMAT_BLUEPRINT,
      userText: USER_TEXT,
      styleText: STYLE_TOKENS,
      attachedMarkdown: "# Raw notes\n- gRPC p99 ~4ms",
      attachedFileName: "notes.md",
    });
    const typeIdx = p.indexOf("Format: Continuous vertical");
    const fmtIdx = p.indexOf("TEMPLATE BLUEPRINT");
    const fenceIdx = p.indexOf("=== ATTACHED SOURCE REFERENCE MATERIAL (notes.md) ===");
    const userIdx = p.indexOf("=== USER INSTRUCTIONS ===");
    const styleIdx = p.indexOf("[VISUAL & COMPONENT SPECIFICATIONS]");
    expect(typeIdx).toBe(0);
    expect(typeIdx).toBeLessThan(fmtIdx);
    expect(fmtIdx).toBeLessThan(fenceIdx);
    expect(fenceIdx).toBeLessThan(userIdx);
    expect(userIdx).toBeLessThan(styleIdx);
  });

  test("style is the final instruction pass (nothing after it)", () => {
    const p = assemblePrompt({
      typeText: TYPE_CONTINUOUS,
      formatText: FORMAT_BLUEPRINT,
      userText: USER_TEXT,
      styleText: STYLE_TOKENS,
    });
    expect(p.trimEnd().endsWith(STYLE_TOKENS)).toBe(true);
  });

  test("fenced attachment keeps delimited-source contract intact", () => {
    const p = assemblePrompt({
      typeText: TYPE_CONTINUOUS,
      formatText: "",
      userText: USER_TEXT,
      styleText: STYLE_TOKENS,
      attachedMarkdown: "# Raw notes",
      attachedFileName: "notes.md",
    });
    expect(p).toContain("=== ATTACHED SOURCE REFERENCE MATERIAL (notes.md) ===\n\`\`\`markdown\n# Raw notes\n\`\`\`");
  });

  test("empty spaces are omitted, never padded", () => {
    const p = assemblePrompt({
      typeText: TYPE_CONTINUOUS,
      formatText: "",
      userText: USER_TEXT,
      styleText: STYLE_TOKENS,
    });
    expect(p).toBe([TYPE_CONTINUOUS, `=== USER INSTRUCTIONS ===\n${USER_TEXT}`, STYLE_TOKENS].join("\n\n"));
  });

  test("whitespace-only template omitted cleanly", () => {
    const p = assemblePrompt({
      typeText: TYPE_CONTINUOUS,
      formatText: "   ",
      userText: USER_TEXT,
      styleText: STYLE_TOKENS,
    });
    expect(p).not.toContain("TEMPLATE BLUEPRINT");
    expect(p.split("\n\n").length).toBe(3);
  });
});
