import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { PageStore, SseParser, feedSseFrame, type PageEvent, type SseEvent } from "./parser";

type StreamErrorEvent = Extract<SseEvent, { kind: "stream_error" }>;

function asStreamError(ev: SseEvent): StreamErrorEvent {
  if (ev.kind !== "stream_error") throw new Error(`expected stream_error, got ${ev.kind}`);
  return ev;
}

function feed(parser: SseParser, raw: string): SseEvent[] {
  const events: SseEvent[] = [];
  const { lines, rest } = feedSseFrame(raw);
  const all = rest.length > 0 ? [...lines, rest] : lines;
  for (const line of all) {
    events.push(...parser.push(line));
  }
  events.push(...parser.flush());
  return events;
}

function pageEvents(events: SseEvent[]): PageEvent[] {
  return events.filter((e): e is PageEvent => e.kind === "page");
}

/** Spec-shape envelope: one full HTML document per insert_page event, scalar position. */
function insertPageLine(position: number, html: string, wrapper: "messages" | "message" = "messages"): string {
  const msg = {
    phase: "tool",
    tool_name: "insert_page",
    content: [{ type: "object", object: { output: html, position } }],
  };
  const chunk = wrapper === "messages" ? { choices: [{ messages: [msg] }] } : { choices: [{ message: msg }] };
  return `data: ${JSON.stringify(chunk)}`;
}

/** Live-verified shape (api.z.ai probe 2026-08-31): add_slide streams HTML via
 * output delta fragments, position is an ARRAY, title rides alongside. */
function addSlideFragmentLine(position: number[], chunk: string, title = "BANANA"): string {
  return `data: ${JSON.stringify({
    id: "2026090103384884e4d34f239b45db",
    agent_id: "slides_glm_agent",
    conversation_id: "1788205128-84f6b0daae654038bc9c2202cf55a71c",
    choices: [
      {
        index: 0,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "object", object: { tool_name: "add_slide", output: chunk, position, title } },
            ],
            phase: "tool",
          },
        ],
      },
    ],
  })}`;
}

/** Live-verified: create_slide / add_slide intent fragments carry input text only. */
function toolIntentLine(tool: string, input: string): string {
  return `data: ${JSON.stringify({
    id: "x",
    agent_id: "slides_glm_agent",
    conversation_id: "conv-live",
    choices: [
      {
        index: 0,
        messages: [
          {
            role: "assistant",
            content: [{ type: "object", object: { tool_name: tool, input } }],
            phase: "tool",
          },
        ],
      },
    ],
  })}`;
}

function answerLine(text: string): string {
  return `data: ${JSON.stringify({
    id: "x",
    conversation_id: "conv-live",
    choices: [{ index: 0, messages: [{ role: "assistant", content: { type: "text", text }, phase: "answer" }] }],
  })}`;
}

describe("feedSseFrame", () => {
  test("splits complete lines and holds the partial tail", () => {
    const { lines, rest } = feedSseFrame('data: {"a":1}\ndata: {"b":2}\ndata: {"c"');
    expect(lines).toEqual(['data: {"a":1}', 'data: {"b":2}']);
    expect(rest).toBe('data: {"c"');
  });

  test("handles CRLF line endings", () => {
    const { lines, rest } = feedSseFrame('data: {"a":1}\r\ndata: [DONE]\r\n');
    expect(lines).toEqual(['data: {"a":1}', "data: [DONE]"]);
    expect(rest).toBe("");
  });

  test("empty buffer yields nothing", () => {
    expect(feedSseFrame("")).toEqual({ lines: [], rest: "" });
  });

  test("completed partial line from a previous rest is parsed on next feed", () => {
    const first = feedSseFrame('data: {"phase":"ans');
    expect(first.rest).toBe('data: {"phase":"ans');
    const second = feedSseFrame(first.rest + 'wer","delta":{"content":[{"type":"text","text":"done"}]}}\n');
    expect(second.lines).toHaveLength(1);
    const parser = new SseParser();
    const events = parser.push(second.lines[0]!);
    expect(events).toEqual([{ kind: "answer", text: "done" }]);
  });
});

describe("happy path: thinking -> insert_page x3 -> answer", () => {
  test("emits ordered typed events and builds ordered pages", () => {
    const parser = new SseParser();
    const store = new PageStore();
    const events = feed(
      parser,
      [
        'data: {"index":1,"phase":"thinking","delta":{"content":[{"type":"text","text":"Plan 5 slides"}]},"conversation_id":"abc123"}',
        insertPageLine(1, "<!DOCTYPE html><html>1</html>"),
        insertPageLine(2, "<!DOCTYPE html><html>2</html>"),
        insertPageLine(3, "<!DOCTYPE html><html>3</html>"),
        'data: {"index":9,"phase":"answer","delta":{"content":[{"type":"text","text":"Deck complete"}]}}',
        'data: {"usage":{"prompt_tokens":812,"completion_tokens":24001}}',
        "data: [DONE]",
      ].join("\n"),
    );

    expect(events.map((e) => e.kind)).toEqual([
      "thinking",
      "page",
      "page",
      "page",
      "answer",
      "usage",
      "done",
    ]);
    expect(events[0]).toEqual({ kind: "thinking", text: "Plan 5 slides" });
    expect(events[4]).toEqual({ kind: "answer", text: "Deck complete" });
    expect(events[5]).toEqual({ kind: "usage", totalTokens: 24813 });

    for (const ev of events) store.applyEvent(ev);
    expect(store.pages).toEqual([
      { position: 1, html: "<!DOCTYPE html><html>1</html>" },
      { position: 2, html: "<!DOCTYPE html><html>2</html>" },
      { position: 3, html: "<!DOCTYPE html><html>3</html>" },
    ]);
    expect(parser.conversationId).toBe("abc123");
    expect(parser.warnings).toHaveLength(0);
  });

  test("accepts both flat envelope and choices[] wrapper (singular message variant)", () => {
    const parser = new SseParser();
    const events = feed(
      parser,
      [
        'data: {"phase":"thinking","delta":{"content":[{"type":"text","text":"t"}]}}',
        insertPageLine(1, "<html>1</html>", "message"),
      ].join("\n"),
    );
    expect(events.map((e) => e.kind)).toEqual(["thinking", "page"]);
    expect(pageEvents(events)[0]).toEqual({
      kind: "page",
      position: 1,
      html: "<html>1</html>",
      tool: "insert_page",
      title: null,
    });
  });
});

describe("LIVE REALITY: add_slide output delta assembly", () => {
  test("consecutive fragments for one slide concatenate into a single page", () => {
    const parser = new SseParser();
    const store = new PageStore();
    const events = feed(
      parser,
      [
        toolIntentLine("create_slide", "A"),
        toolIntentLine("add_slide", " clean"),
        addSlideFragmentLine([1], "<!DOCTYPE html>\n<html>"),
        toolIntentLine("create_slide", " BANANA"),
        addSlideFragmentLine([1], "\n<body>BANANA"),
        addSlideFragmentLine([1], "</body>\n</html>"),
        answerLine("Slide ready."),
      ].join("\n"),
    );

    expect(events.map((e) => e.kind)).toEqual(["page", "answer"]);
    const page = pageEvents(events)[0]!;
    expect(page.position).toBe(1);
    expect(page.tool).toBe("add_slide");
    expect(page.title).toBe("BANANA");
    expect(page.html).toBe("<!DOCTYPE html>\n<html>\n<body>BANANA</body>\n</html>");
    expect(parser.suppressedToolIntentFragments).toBe(3);

    for (const ev of events) store.applyEvent(ev);
    expect(store.pages).toEqual([
      { position: 1, html: "<!DOCTYPE html>\n<html>\n<body>BANANA</body>\n</html>", title: "BANANA" },
    ]);
  });

  test("position key change flushes the previous page: multi-page assembly", () => {
    const parser = new SseParser();
    const events = feed(
      parser,
      [
        addSlideFragmentLine([1], "<html>page-one"),
        addSlideFragmentLine([1], "-full</html>"),
        addSlideFragmentLine([2], "<html>page-two</html>"),
        answerLine("done"),
      ].join("\n"),
    );
    const pages = pageEvents(events);
    expect(pages.map((p) => p.position)).toEqual([1, 2]);
    expect(pages[0]!.html).toBe("<html>page-one-full</html>");
    expect(pages[1]!.html).toBe("<html>page-two</html>");
  });

  test("regeneration of a page later in the stream overwrites in the store", () => {
    const parser = new SseParser();
    const store = new PageStore();
    const events = feed(
      parser,
      [
        addSlideFragmentLine([2], "<html>old</html>"),
        answerLine("interim"),
        addSlideFragmentLine([2], "<html>new</html>"),
        answerLine("done"),
      ].join("\n"),
    );
    expect(pagesOf(events).map((p) => p.html)).toEqual(["<html>old</html>", "<html>new</html>"]);
    for (const ev of events) store.applyEvent(ev);
    expect(store.size).toBe(1);
    expect(store.pages).toEqual([{ position: 2, html: "<html>new</html>", title: "BANANA" }]);
    expect(store.warnings.some((w) => w.includes("position 2 overwritten"))).toBe(true);
  });

  test("flush() at stream close emits the final page (live stream has no [DONE])", () => {
    const parser = new SseParser();
    parser.push(addSlideFragmentLine([1], "<html>only</html>"));
    expect(parser.flush()).toEqual([
      { kind: "page", position: 1, html: "<html>only</html>", tool: "add_slide", title: "BANANA" },
    ]);
    expect(parser.flush()).toEqual([]);
  });
});

function pagesOf(events: SseEvent[]): PageEvent[] {
  return events.filter((e): e is PageEvent => e.kind === "page");
}

describe("status:\"failed\" mid-stream", () => {
  test("emits stream_error, keeps already-received pages", () => {
    const parser = new SseParser();
    const store = new PageStore();
    const events = feed(
      parser,
      [
        insertPageLine(1, "<html>1</html>"),
        'data: {"status":"failed","error":{"code":1301,"message":"content filtered"}}',
      ].join("\n"),
    );

    const err = asStreamError(events[1]!);
    expect(err.code).toBe("1301");
    expect(err.message).toBe("content filtered");
    for (const ev of events) store.applyEvent(ev);
    expect(store.size).toBe(1);
    expect(store.pages[0]!.position).toBe(1);
  });

  test("status failed without error object yields generic message", () => {
    const parser = new SseParser();
    const events = parser.push('data: {"status":"failed"}');
    expect(events).toHaveLength(1);
    const err = asStreamError(events[0]!);
    expect(err.code).toBe(null);
    expect(err.message).toContain("failure");
  });
});

describe("error phase 1301", () => {
  test("numeric code is coerced to string, message preserved", () => {
    const parser = new SseParser();
    const events = parser.push(
      'data: {"index":5,"phase":"error","error":{"code":1301,"message":"content safety triggered"}}',
    );
    expect(events).toEqual([
      { kind: "stream_error", code: "1301", message: "content safety triggered" },
    ]);
  });

  test("error phase carrying the message as text content is surfaced", () => {
    const parser = new SseParser();
    const events = parser.push(
      'data: {"phase":"error","error":{"code":1301},"delta":{"content":[{"type":"text","text":"content filtered"}]}}',
    );
    expect(events).toEqual([{ kind: "stream_error", code: "1301", message: "content filtered" }]);
  });
});

describe("drop mid-insert_page", () => {
  test("partial tail stays in rest; complete fragments assemble on flush; no crash", () => {
    const parser = new SseParser();
    const store = new PageStore();
    const good = insertPageLine(1, "<html>1</html>");
    const truncated = 'data: {"choices":[{"messages":[{"phase":"tool","tool_name":"insert_page","cont';

    const { lines, rest } = feedSseFrame(`${good}\n${truncated}`);
    expect(lines).toEqual([good]);
    expect(rest).toBe(truncated);

    const duringStream: SseEvent[] = [];
    for (const line of lines) duringStream.push(...parser.push(line));
    expect(duringStream).toEqual([]);

    const flushed = parser.flush();
    expect(flushed.map((e) => e.kind)).toEqual(["page"]);
    for (const ev of flushed) store.applyEvent(ev);

    expect(store.size).toBe(1);
    expect(store.pages[0]!.html).toBe("<html>1</html>");
    expect(duringStream.some((e) => e.kind === "done")).toBe(false);
    expect(parser.warnings).toHaveLength(0);
  });
});

describe("duplicate position", () => {
  test("later regeneration overwrites earlier page at same index and is flagged", () => {
    const parser = new SseParser();
    const store = new PageStore();
    const events = feed(
      parser,
      [
        insertPageLine(2, "<html>old</html>"),
        'data: {"phase":"thinking","delta":{"content":[{"type":"text","text":"regenerating"}]}}',
        insertPageLine(2, "<html>new</html>"),
      ].join("\n"),
    );
    expect(pageEvents(events)).toHaveLength(2);
    for (const ev of events) store.applyEvent(ev);
    expect(store.size).toBe(1);
    expect(store.pages).toEqual([{ position: 2, html: "<html>new</html>" }]);
    expect(store.warnings.some((w) => w.includes("position 2 overwritten"))).toBe(true);
  });
});

describe("missing position", () => {
  test("flagged and kept aside, does not crash or re-index other pages", () => {
    const parser = new SseParser();
    const store = new PageStore();
    const noPosition =
      'data: {"choices":[{"messages":[{"phase":"tool","tool_name":"insert_page","content":[{"type":"object","object":{"output":"<html>orphan</html>"}}]}]}]}';
    const events = feed(parser, [insertPageLine(1, "<html>1</html>"), noPosition].join("\n"));

    const orphan = pageEvents(events)[1]!;
    expect(orphan.position).toBe(null);
    expect(orphan.html).toBe("<html>orphan</html>");
    expect(parser.warnings.some((w) => w.includes("without position"))).toBe(true);

    for (const ev of events) store.applyEvent(ev);
    expect(store.pages).toEqual([{ position: 1, html: "<html>1</html>" }]);
    expect(store.unpositioned).toEqual([
      { html: "<html>orphan</html>", tool: "insert_page", title: null },
    ]);
  });
});

describe("keep-alive / comment / non-data lines", () => {
  test("emit nothing and never grow state", () => {
    const parser = new SseParser();
    const events = feed(parser, [": ping", "", "event: ping", "id: 42", "retry: 3000", "data:"].join("\n"));
    expect(events).toEqual([]);
    expect(parser.warnings).toHaveLength(0);
  });
});

describe("unknown tool_name", () => {
  test("output-bearing unknown tool flows through tool_misc, never touches pages", () => {
    const parser = new SseParser();
    const store = new PageStore();
    const events = parser.push(
      'data: {"choices":[{"messages":[{"phase":"tool","tool_name":"search","content":[{"type":"object","object":{"output":"web results here"}}]}]}]}',
    );
    expect(events).toEqual([{ kind: "tool_misc", tool: "search", summary: "web results here" }]);
    for (const ev of events) store.applyEvent(ev);
    expect(store.size).toBe(0);
  });

  test("output-less unknown tool events are intent fragments — counted, not emitted", () => {
    const parser = new SseParser();
    const events = feed(
      parser,
      [
        toolIntentLine("remove_slides", "4"),
        toolIntentLine("search", "query"),
      ].join("\n"),
    );
    expect(events).toEqual([]);
    expect(parser.suppressedToolIntentFragments).toBe(2);
  });
});

describe("empty output", () => {
  test("insert_page with whitespace-only output emits no page and flags a warning", () => {
    const parser = new SseParser();
    const store = new PageStore();
    const blank =
      'data: {"choices":[{"messages":[{"phase":"tool","tool_name":"insert_page","content":[{"type":"object","object":{"output":"   ","position":1}}]}]}]}';
    const events = feed(parser, blank);
    expect(events).toEqual([]);
    expect(parser.warnings.some((w) => w.includes("empty output"))).toBe(true);
    for (const ev of events) store.applyEvent(ev);
    expect(store.size).toBe(0);
  });
});

describe("malformed JSON frames", () => {
  test("skipped and counted; 3 consecutive -> one stream_error, counter resets", () => {
    const parser = new SseParser();
    expect(parser.push("data: {oops")).toEqual([]);
    expect(parser.push('data: {"a":')).toEqual([]);
    const third = parser.push("data: not json at all");
    expect(third).toHaveLength(1);
    expect(asStreamError(third[0]!).message).toContain("malformed");

    expect(parser.push("data: {broken")).toEqual([]);
    expect(parser.push("data: {again")).toEqual([]);
    expect(parser.push("data: {third")).toHaveLength(1);
  });

  test("malformed run resets after a good frame", () => {
    const parser = new SseParser();
    expect(parser.push("data: {bad")).toEqual([]);
    expect(parser.push('data: {"phase":"answer","delta":{"content":[{"type":"text","text":"ok"}]}}')).toEqual([
      { kind: "answer", text: "ok" },
    ]);
    expect(parser.push("data: {bad")).toEqual([]);
    expect(parser.push("data: {bad")).toEqual([]);
  });

  test("valid JSON that is not an object counts as malformed", () => {
    const parser = new SseParser();
    expect(parser.push("data: [1,2,3]")).toEqual([]);
    expect(parser.push("data: 42")).toEqual([]);
    const third = parser.push("data: null");
    expect(asStreamError(third[0]!).code).toBe(null);
  });
});

describe("unknown phases", () => {
  test("log-and-continue without events or throws", () => {
    const parser = new SseParser();
    const events = parser.push(
      'data: {"index":7,"phase":"vibes","delta":{"content":[{"type":"text","text":"x"}]}}',
    );
    expect(events).toEqual([]);
    expect(parser.warnings.some((w) => w.includes('unknown phase "vibes"'))).toBe(true);
  });

  test("event without phase field is ignored with a warning", () => {
    const parser = new SseParser();
    const events = parser.push('data: {"delta":{"content":[{"type":"text","text":"x"}]}}');
    expect(events).toEqual([]);
    expect(parser.warnings.some((w) => w.includes("without phase"))).toBe(true);
  });
});

describe("usage", () => {
  test("total_tokens wins when present", () => {
    const parser = new SseParser();
    const events = parser.push('data: {"usage":{"total_tokens":100,"prompt_tokens":10,"completion_tokens":5}}');
    expect(events).toEqual([{ kind: "usage", totalTokens: 100 }]);
  });

  test("falls back to prompt+completion sum", () => {
    const parser = new SseParser();
    const events = parser.push('data: {"usage":{"prompt_tokens":812,"completion_tokens":24001}}');
    expect(events).toEqual([{ kind: "usage", totalTokens: 24813 }]);
  });
});

describe("conversation_id capture", () => {
  test("captured from flat envelope and from nested message level", () => {
    const flat = new SseParser();
    flat.push('data: {"phase":"thinking","delta":{"content":[]},"conversation_id":"conv-flat"}');
    expect(flat.conversationId).toBe("conv-flat");

    const nested = new SseParser();
    nested.push(
      'data: {"choices":[{"messages":[{"phase":"thinking","delta":{"content":[]},"conversation_id":"conv-msg"}]}]}',
    );
    expect(nested.conversationId).toBe("conv-msg");
  });

  test("latest id wins on multi-turn resume", () => {
    const parser = new SseParser();
    parser.push('data: {"conversation_id":"old"}');
    parser.push('data: {"conversation_id":"new"}');
    expect(parser.conversationId).toBe("new");
  });
});

describe("PageStore ordering", () => {
  test("sorts regardless of arrival order and preserves gaps without re-indexing", () => {
    const store = new PageStore();
    store.apply({ kind: "page", position: 5, html: "<html>5</html>", tool: "insert_page", title: null });
    store.apply({ kind: "page", position: 1, html: "<html>1</html>", tool: "insert_page", title: null });
    store.apply({ kind: "page", position: 3, html: "<html>3</html>", tool: "insert_page", title: null });
    expect(store.pages.map((p) => p.position)).toEqual([1, 3, 5]);
    expect(store.pages.map((p) => p.html)).toEqual(["<html>1</html>", "<html>3</html>", "<html>5</html>"]);
  });
});

describe("push accepts bare payloads and data:-prefixed lines", () => {
  test("both forms route identically", () => {
    const prefixed = new SseParser();
    const bare = new SseParser();
    const payload = '{"phase":"answer","delta":{"content":[{"type":"text","text":"done"}]}}';
    expect(prefixed.push(`data: ${payload}`)).toEqual([{ kind: "answer", text: "done" }]);
    expect(bare.push(payload)).toEqual([{ kind: "answer", text: "done" }]);
  });

  test("[DONE] with and without data: prefix (flushes pending page first)", () => {
    const parser = new SseParser();
    parser.push(insertPageLine(1, "<html>1</html>"));
    const events = parser.push("data: [DONE]");
    expect(events.map((e) => e.kind)).toEqual(["page", "done"]);
    expect(new SseParser().push("[DONE]")).toEqual([{ kind: "done" }]);
  });
});

describe("live fixtures (api.z.ai probe 2026-08-31)", () => {
  test("30KB stream head: framing + thinking + conversation capture, zero errors", () => {
    const raw = readFileSync(`${import.meta.dir}/fixtures/live-sse-sample.txt`, "utf8");
    const parser = new SseParser();
    const events = feed(parser, raw);
    expect(parser.conversationId).not.toBe(null);
    expect(events.some((e) => e.kind === "thinking")).toBe(true);
    expect(events.some((e) => e.kind === "stream_error")).toBe(false);
    const thinkingText = events
      .filter((e): e is Extract<SseEvent, { kind: "thinking" }> => e.kind === "thinking")
      .map((e) => e.text)
      .join("");
    expect(thinkingText.length).toBeGreaterThan(100);
  });

  test("tool-phase excerpt: add_slide deltas assemble into one BANANA page", () => {
    const raw = readFileSync(`${import.meta.dir}/fixtures/live-sse-tool-sample.txt`, "utf8");
    const parser = new SseParser();
    const store = new PageStore();
    const events = feed(parser, raw);
    for (const ev of events) store.applyEvent(ev);

    expect(parser.conversationId).not.toBe(null);
    expect(store.size).toBe(1);
    const page = store.pages[0]!;
    expect(page.position).toBe(1);
    expect(page.title).toBe("BANANA");
    expect(page.html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(page.html.trimEnd().endsWith("</html>")).toBe(true);
    expect(page.html).toContain("BANANA");
    expect(events.some((e) => e.kind === "stream_error")).toBe(false);
  });
});
