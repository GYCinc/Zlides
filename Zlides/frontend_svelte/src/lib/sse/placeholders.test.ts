import { describe, test, expect } from "bun:test";
import { CANONICAL_PLACEHOLDERS, ensurePlaceholders } from "./placeholders";

function minimalDoc(inner = ""): string {
  return `<!DOCTYPE html><html><head><style>:root{--bg:#0f1112;--surface:#16181a;--line:#2e3236}</style></head><body><main>${inner}</main></body></html>`;
}

describe("placeholders", () => {
  test("CANONICAL_PLACEHOLDERS enumerates all 8 callable categories", () => {
    const ids = CANONICAL_PLACEHOLDERS.filter((p) => p.type === "section").map((p) => p.id);
    for (const required of ["vocabulary", "phrasal-verbs", "collocations", "grammar", "idioms-and-phrases", "focus-points", "in-class-practice", "self-study"]) {
      expect(ids.includes(required)).toBe(true);
    }
  });

  test("idempotent on already-tagged document", () => {
    const once = ensurePlaceholders(minimalDoc());
    const twice = ensurePlaceholders(once);
    expect(twice).toBe(once);
  });

  test("idempotent on document with existing section without regenerate tag", () => {
    const doc = minimalDoc('<section id="vocabulary" data-category="vocabulary"><div class="dynamic-slot"><button class="regenerate-btn" data-prompt="x">Go</button></div></section>');
    const once = ensurePlaceholders(doc);
    const twice = ensurePlaceholders(once);
    expect(twice).toBe(once);
    expect(once.includes('data-regenerate="true"')).toBe(true);
  });

  test("tags existing sections with data-regenerate", () => {
    const doc = minimalDoc('<section id="grammar" data-category="grammar"></section>');
    const out = ensurePlaceholders(doc);
    expect(out.includes('id="grammar"')).toBe(true);
    expect(out.includes('data-regenerate="true"')).toBe(true);
    expect(out.match(/data-regenerate="true"/g)!.length >= 1).toBe(true);
  });

  test("injects missing sections styled with gitenglish tokens", () => {
    const doc = minimalDoc("");
    const out = ensurePlaceholders(doc);
    for (const ph of CANONICAL_PLACEHOLDERS.filter((p) => p.type === "section")) {
      expect(out.includes(`id="${ph.id}"`)).toBe(true);
      expect(out.includes(`data-category="${ph.id}"`)).toBe(true);
    }
    expect(out.includes("#0f1112") || out.includes("#16181a") || out.includes("--surface")).toBe(true);
    expect(out.includes("#447F9F") || out.includes("#3B8484")).toBe(true);
  });

  for (const ph of CANONICAL_PLACEHOLDERS) {
    test(`each type present after ensure: ${ph.type}:${ph.id}`, () => {
      const out = ensurePlaceholders(minimalDoc());
      const found = ph.markers.some((m) => out.includes(m));
      expect(found).toBe(true);
    });
  }

  test("tags existing blank and option with data-regenerate", () => {
    const doc = minimalDoc('<input class="blank" data-answer="hello" placeholder="..." /><button class="option" data-correct="true" data-rationale="why">A</button>');
    const out = ensurePlaceholders(doc);
    const blankTag = out.match(/<input[^>]*blank[^>]*>/)?.[0] ?? "";
    expect(blankTag.includes('data-regenerate="true"')).toBe(true);
    const optionTag = out.match(/<button[^>]*option[^>]*>/)?.[0] ?? "";
    expect(optionTag.includes('data-regenerate="true"')).toBe(true);
  });

  test("tags existing regenerate-btn and dynamic-slot", () => {
    const doc = minimalDoc('<div class="dynamic-slot"></div><button class="regenerate-btn" data-prompt="Generate something">Regenerate</button>');
    const out = ensurePlaceholders(doc);
    expect(out.includes("dynamic-slot") && out.includes('data-regenerate="true"')).toBe(true);
    const slotTag = out.match(/<div[^>]*dynamic-slot[^>]*>/)?.[0] ?? "";
    expect(slotTag.includes('data-regenerate="true"')).toBe(true);
    const btnTag = out.match(/<button[^>]*regenerate-btn[^>]*>/)?.[0] ?? "";
    expect(btnTag.includes('data-regenerate="true"')).toBe(true);
  });

  test("injects styled placeholder when empty string", () => {
    const out = ensurePlaceholders("");
    expect(out.includes("vocabulary")).toBe(true);
    expect(out.includes('data-regenerate="true"')).toBe(true);
  });

  test("does not duplicate data-regenerate on second pass", () => {
    const doc = minimalDoc('<section id="collocations" data-category="collocations"></section>');
    const once = ensurePlaceholders(doc);
    const countOnce = (once.match(/data-regenerate="true"/g) || []).length;
    const twice = ensurePlaceholders(once);
    const countTwice = (twice.match(/data-regenerate="true"/g) || []).length;
    expect(countTwice).toBe(countOnce);
  });
});
