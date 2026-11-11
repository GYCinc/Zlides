import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { rescueDocumentFromAnswer, decodeHtmlPayload } from "./rescue";

// REAL artifact: the escaped-answer worksheet that shipped corrupted on
// 2026-09-18 (slide_20260918043526_Spices__Cempasuchil_and_the_Ma).
const REAL_ESCAPED = readFileSync(import.meta.dir + "/fixtures/escaped-answer-sample.txt", "utf8");

describe("decodeHtmlPayload", () => {
  test("decodes literal \\n, \\r, \\t, \\\", \\\\, \\/, and unicode escapes", () => {
    const raw = '<!DOCTYPE html>\\n<html lang=\\"en\\">\\n<head>\\n<meta charset=\\"UTF-8\\">\\n</head>\\n<body>\\t<div class=\\"card\\">\\u0048ello \\/ World</div>\\n</body>\\n</html>';
    const out = decodeHtmlPayload(raw);
    expect(out).not.toContain("\\n");
    expect(out).not.toContain('\\"');
    expect(out).not.toContain("\\t");
    expect(out).toContain('<html lang="en">');
    expect(out).toContain('<meta charset="UTF-8">');
    expect(out).toContain('\t<div class="card">Hello / World</div>');
    expect(out.split("\n").length).toBe(8);
  });

  test("leaves unescaped string untouched", () => {
    const raw = '<!DOCTYPE html>\n<html lang="en"><body>Hello</body></html>';
    expect(decodeHtmlPayload(raw)).toBe(raw);
  });

  test("handles mixed state with real and escaped characters", () => {
    const raw = '<!DOCTYPE html>\n<html lang=\\"en\\">\n<body>\\n<div class=\\"card\\">Hi</div>\n</body></html>';
    const out = decodeHtmlPayload(raw);
    expect(out).not.toContain('\\"');
    expect(out).not.toContain('\\n');
    expect(out).toContain('<html lang="en">');
    expect(out).toContain('<div class="card">Hi</div>');
  });
});

describe("answer-phase HTML rescue decoding", () => {
  test("real artifact: JSON-string-encoded document decodes to clean HTML", () => {
    const out = rescueDocumentFromAnswer(REAL_ESCAPED);
    if (out === null) throw new Error("decoder returned null for real artifact");
    // Structural health: real markup with real quotes and real newlines.
    expect(out.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(out.includes('<html lang="en">')).toBe(true);
    expect(out.includes("<body")).toBe(true);
    expect(out.split("\n").length).toBeGreaterThan(20);
    // The escaped-transport form is gone (attribute quotes unescaped).
    expect(out.includes('lang=\\"en\\"')).toBe(false);
    expect(out.trimEnd().endsWith("</html>")).toBe(true);
  });

  test("plain answer document passes through structurally intact", () => {
    const doc = '<!DOCTYPE html>\n<html lang="en"><body><main>x</main></body></html>';
    const out = rescueDocumentFromAnswer("Sure! Here it is:\n" + doc + "\nHope this helps.");
    expect(out).toBe(doc);
  });

  test("markdown-fenced document unwraps", () => {
    const doc = '<!DOCTYPE html>\n<html lang="en"><body><main>x</main></body></html>';
    const fence = '```html\n' + doc + '\n```';
    const out = rescueDocumentFromAnswer(fence);
    expect(out).toBe(doc);
  });

  test("JSON envelope {html} unwraps", () => {
    const doc = '<!DOCTYPE html>\n<html lang="en"><body><main>x</main></body></html>';
    const out = rescueDocumentFromAnswer(JSON.stringify({ html: doc }));
    expect(out).toBe(doc);
  });

  test("JSON-string-encoded document decodes", () => {
    const doc = '<!DOCTYPE html>\n<html lang="en"><body><main>x</main></body></html>';
    const out = rescueDocumentFromAnswer(JSON.stringify(doc));
    expect(out).toBe(doc);
  });

  test("prose without document structure returns null", () => {
    expect(rescueDocumentFromAnswer("The thought of the presentation makes me want to throw up.")).toBe(null);
    expect(rescueDocumentFromAnswer("")).toBe(null);
    expect(rescueDocumentFromAnswer("<p>fragment only, no document</p>")).toBe(null);
  });
});
