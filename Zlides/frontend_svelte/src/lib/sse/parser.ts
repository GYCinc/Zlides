/**
 * SSE wire parser for the slides_glm_agent stream.
 *
 * Framework-free (no DOM, no Svelte). Routing is keyed on STRUCTURED wire
 * fields only — `phase`, `tool_name`, `status`, `error`, `usage`,
 * `conversation_id`, `position` — never on content sniffing of HTML bodies.
 *
 * Partial-JSON policy:
 * - `feedSseFrame` buffers an incomplete trailing line in `rest` until the
 *   next feed completes it (buffer choice, not skip choice).
 * - A COMPLETE line that still fails JSON.parse is skipped and counted;
 *   >= 3 consecutive malformed frames yield one `stream_error` event
 *   (distinguishes noise from protocol drift) and the counter resets.
 */

export type SseEvent =
  | { kind: "thinking"; text: string }
  | { kind: "page"; position: number | null; html: string; tool: string; title: string | null }
  | { kind: "tool_misc"; tool: string; summary: string }
  | { kind: "answer"; text: string }
  | { kind: "stream_error"; code: string | null; message: string }
  | { kind: "usage"; totalTokens: number }
  | { kind: "done" };

export type PageEvent = Extract<SseEvent, { kind: "page" }>;

export interface PageEntry {
  position: number;
  html: string;
  title?: string;
}

/**
 * Page-bearing tools. LIVE-VERIFIED (2026-08-31 probe, api.z.ai): the real
 * stream uses `add_slide` (streams HTML via `output` deltas) and
 * `create_slide` (intent/title only). `insert_page`/`modify_page` are kept
 * for spec/history-shape compatibility.
 */
const PAGE_TOOLS = new Set(["insert_page", "modify_page", "add_slide", "create_slide"]);
const MALFORMED_THRESHOLD = 3;
const DONE_SENTINEL = "[DONE]";

export function feedSseFrame(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split(/\r\n|\n|\r/);
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (/^-?\d+$/.test(t)) {
      const n = Number(t);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function asErrorCode(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return asString(v);
}

/**
 * Position wire values live-verified as ARRAYS (`"position":[1]`); scalars
 * (number / numeric string) accepted for spec-shape compatibility. Arrays
 * yield their first finite element (remove-operations may list many; a page
 * assembly targets one).
 */
function positionFromWire(v: unknown): number | null {
  if (Array.isArray(v)) {
    for (const el of v) {
      const n = asFiniteNumber(el);
      if (n !== null) return n;
    }
    return null;
  }
  return asFiniteNumber(v);
}

function firstDefined(...candidates: unknown[]): unknown {
  for (const c of candidates) {
    if (c !== undefined) return c;
  }
  return undefined;
}

function firstNonEmptyString(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    const s = asString(c);
    if (s !== null) return s;
  }
  return null;
}

/** Text parts from a `content`/`delta.content` slot: bare string, single item, or item array. */
function textParts(content: unknown): string[] {
  if (typeof content === "string") return content.length > 0 ? [content] : [];
  const items = Array.isArray(content) ? content : [content];
  const out: string[] = [];
  for (const it of items) {
    if (isRecord(it) && it.type === "text" && typeof it.text === "string" && it.text.length > 0) {
      out.push(it.text);
    }
  }
  return out;
}

/**
 * Slide-HTML payload from a tool `output` slot. Accepted structured shapes:
 * string | array of (string | {text}) | object with `html` or `content` string.
 * No regex, no content sniffing — verbatim extraction only.
 */
function extractToolOutput(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    let s = "";
    for (const p of raw) {
      if (typeof p === "string") s += p;
      else if (isRecord(p) && typeof p.text === "string") s += p.text;
    }
    return s;
  }
  if (isRecord(raw)) {
    if (typeof raw.html === "string") return raw.html;
    if (typeof raw.content === "string") return raw.content;
  }
  return null;
}

interface ErrorFields {
  code: string | null;
  message: string;
}

function errorFieldsFrom(ml: Record<string, unknown>, content: unknown): ErrorFields {
  const err = isRecord(ml.error) ? ml.error : null;
  const code = err ? asErrorCode(err.code) : asErrorCode(ml.code);
  const message =
    (err ? asString(err.message) : null) ??
    firstNonEmptyString(...textParts(content)) ??
    `Agent stream reported failure${code === null ? "" : ` (code ${code})`}`;
  return { code, message };
}

export class SseParser {
  private malformedRun = 0;
  private conversationIdValue: string | null = null;
  private accKey: string | null = null;
  private accTool = "unknown_tool";
  private accPosition: number | null = null;
  private accTitle: string | null = null;
  private accHtml = "";
  readonly warnings: string[] = [];

  /** Live-verified: tool intent fragments (input-only tool events) are progressive
   * tool-call text, not user-facing events — counted, never emitted. */
  suppressedToolIntentFragments = 0;

  get conversationId(): string | null {
    return this.conversationIdValue;
  }

  /**
   * Feed one raw SSE line: a full `data: …` line, its bare payload, a
   * keep-alive comment (`: …`), another SSE field line (ignored), or
   * `[DONE]`. Returns 0..n typed events. Never throws on wire data.
   *
   * Page HTML arrives as output DELTA fragments across consecutive tool
   * events (live-verified); this parser accumulates them per
   * (tool, position, title) and emits one assembled `page` event when the
   * key changes, the phase leaves `tool`, `[DONE]` arrives — or when you
   * call `flush()` after the stream closes. ALWAYS call `flush()` at end of
   * stream: the live stream has no [DONE]/usage terminator.
   */
  push(dataStr: string): SseEvent[] {
    const line = dataStr.trim();
    if (line.length === 0) return [];
    if (line.startsWith(":")) return [];
    if (line === DONE_SENTINEL || line.startsWith(`${DONE_SENTINEL}:`)) {
      const flushed = this.flushPage();
      return [...flushed, { kind: "done" }];
    }

    let payload: string;
    if (line.startsWith("data:")) {
      payload = line.slice(5).trim();
    } else if (line.startsWith("event:") || line.startsWith("id:") || line.startsWith("retry:")) {
      return [];
    } else {
      payload = line;
    }
    if (payload.length === 0) return [];
    if (payload === DONE_SENTINEL) {
      const flushed = this.flushPage();
      return [...flushed, { kind: "done" }];
    }

    let chunk: unknown;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return this.registerMalformedFrame();
    }
    if (!isRecord(chunk)) {
      this.warnings.push("sse: data frame was valid JSON but not an object — skipped");
      return this.registerMalformedFrame();
    }

    this.malformedRun = 0;

    const events: SseEvent[] = [];

    const topConv = asString(chunk.conversation_id);
    if (topConv !== null) this.conversationIdValue = topConv;

    const choices = chunk.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      for (const choice of choices) {
        if (!isRecord(choice)) continue;
        const choiceConv = asString(choice.conversation_id);
        if (choiceConv !== null) this.conversationIdValue = choiceConv;
        const messages = Array.isArray(choice.messages)
          ? choice.messages
          : choice.message !== undefined
            ? [choice.message]
            : [];
        for (const msg of messages) {
          if (isRecord(msg)) this.handleMessageLike(msg, events);
        }
      }
    } else {
      this.handleMessageLike(chunk, events);
    }

    const usage = chunk.usage;
    if (isRecord(usage)) {
      const total =
        asFiniteNumber(usage.total_tokens) ??
        this.sumTokens(usage.prompt_tokens, usage.completion_tokens) ??
        this.sumTokens(usage.input_tokens, usage.output_tokens);
      if (total !== null) {
        events.push({ kind: "usage", totalTokens: total });
      } else {
        this.warnings.push("sse: usage frame without recognizable token fields — ignored");
      }
    }

    return events;
  }

  private sumTokens(a: unknown, b: unknown): number | null {
    const x = asFiniteNumber(a);
    const y = asFiniteNumber(b);
    return x !== null && y !== null ? x + y : null;
  }

  private registerMalformedFrame(): SseEvent[] {
    this.malformedRun += 1;
    this.warnings.push(`sse: malformed data frame skipped (${this.malformedRun} consecutive)`);
    if (this.malformedRun >= MALFORMED_THRESHOLD) {
      this.malformedRun = 0;
      return [
        {
          kind: "stream_error",
          code: null,
          message: `Stream protocol drift: ${MALFORMED_THRESHOLD} consecutive malformed frames`,
        },
      ];
    }
    return [];
  }

  private handleMessageLike(ml: Record<string, unknown>, events: SseEvent[]): void {
    const msgConv = asString(ml.conversation_id);
    if (msgConv !== null) this.conversationIdValue = msgConv;

    const delta = isRecord(ml.delta) ? ml.delta : null;
    const content = ml.content !== undefined ? ml.content : (delta?.content ?? undefined);
    const phase = asString(ml.phase);

    if (ml.status === "failed" || ml.error !== undefined) {
      events.push(...this.flushPage());
      events.push({ kind: "stream_error", ...errorFieldsFrom(ml, content) });
      return;
    }

    if (phase !== "tool") {
      events.push(...this.flushPage());
    }

    switch (phase) {
      case "thinking": {
        for (const text of textParts(content)) {
          events.push({ kind: "thinking", text });
        }
        return;
      }
      case "answer": {
        for (const text of textParts(content)) {
          events.push({ kind: "answer", text });
        }
        return;
      }
      case "tool": {
        this.routeToolEvent(ml, events);
        return;
      }
      case "error": {
        events.push({ kind: "stream_error", ...errorFieldsFrom(ml, content) });
        return;
      }
      default: {
        if (phase === null && (ml.usage !== undefined || ml.conversation_id !== undefined)) {
          return;
        }
        this.warnings.push(
          phase === null
            ? "sse: event without phase field — ignored"
            : `sse: unknown phase "${phase}" — ignored (log-and-continue)`,
        );
      }
    }
  }

  /**
   * Emit any pending assembled page and reset the accumulator. Call once
   * after the stream closes (the live stream has no [DONE] terminator).
   */
  flush(): SseEvent[] {
    return this.flushPage();
  }

  private flushPage(): SseEvent[] {
    if (this.accKey === null) return [];
    const html = this.accHtml;
    const tool = this.accTool;
    const position = this.accPosition;
    const title = this.accTitle;
    this.accKey = null;
    this.accHtml = "";
    this.accPosition = null;
    this.accTitle = null;
    if (html.trim().length === 0) {
      this.warnings.push(`sse: ${tool} page with empty output — no page emitted`);
      return [];
    }
    if (position === null) {
      this.warnings.push(`sse: ${tool} page delivered without position — kept out of ordering`);
    }
    return [{ kind: "page", position, html, tool, title }];
  }

  private routeToolEvent(ml: Record<string, unknown>, events: SseEvent[]): void {
    const rawContent = ml.content;
    const items = Array.isArray(rawContent) ? rawContent : rawContent !== undefined ? [rawContent] : [];

    let obj: Record<string, unknown> | null = null;
    let itemRef: Record<string, unknown> | null = null;
    for (const it of items) {
      if (isRecord(it) && it.type === "object" && isRecord(it.object)) {
        obj = it.object;
        itemRef = it;
        break;
      }
    }

    // LIVE-VERIFIED: tool_name sits INSIDE content[type=object].object
    // (e.g. {"tool_name":"add_slide"}); message-level tool_name kept as
    // spec-shape fallback.
    const tool = firstNonEmptyString(obj?.tool_name, itemRef?.tool_name, ml.tool_name, ml.name) ?? "unknown_tool";

    const outputRaw = obj !== null && obj.output !== undefined ? obj.output : ml.output;
    const output = outputRaw !== undefined ? extractToolOutput(outputRaw) : null;

    const position =
      obj !== null
        ? positionFromWire(firstDefined(obj.position, itemRef?.position, ml.position))
        : positionFromWire(ml.position);

    const title = obj !== null ? asString(obj.title) : null;

    if (PAGE_TOOLS.has(tool)) {
      if (output !== null && output.length > 0) {
        const key = `${tool}|${position === null ? "?" : position}|${title ?? ""}`;
        if (this.accKey !== null && this.accKey !== key) {
          events.push(...this.flushPage());
        }
        this.accKey = key;
        this.accTool = tool;
        if (this.accPosition === null) this.accPosition = position;
        if (this.accTitle === null) this.accTitle = title;
        this.accHtml += output;
      } else {
        this.suppressedToolIntentFragments += 1;
      }
      return;
    }

    if (output !== null && output.length > 0) {
      events.push({ kind: "tool_misc", tool, summary: output });
    } else {
      this.suppressedToolIntentFragments += 1;
    }
  }
}

/**
 * Ordered page reducer. Duplicate position: later event overwrites the
 * earlier page (agent regenerating page N mid-stream is legal) and is
 * flagged. Missing position: never crashes, never invents an index — the
 * payload is kept in `unpositioned` and flagged.
 */
export class PageStore {
  private readonly byPosition = new Map<number, { html: string; title: string | null }>();
  readonly unpositioned: { html: string; tool: string; title: string | null }[] = [];
  readonly warnings: string[] = [];

  apply(ev: PageEvent): void {
    if (ev.position === null) {
      this.unpositioned.push({ html: ev.html, tool: ev.tool, title: ev.title });
      this.warnings.push(
        `page: ${ev.tool} output without position kept aside (${this.unpositioned.length} total)`,
      );
      return;
    }
    if (this.byPosition.has(ev.position)) {
      this.warnings.push(`page: position ${ev.position} overwritten by later event`);
    }
    this.byPosition.set(ev.position, { html: ev.html, title: ev.title });
  }

  applyEvent(ev: SseEvent): void {
    if (ev.kind === "page") this.apply(ev);
  }

  /** Pages sorted ascending by 1-based position; gaps are preserved (UI renders placeholders). */
  get pages(): PageEntry[] {
    return [...this.byPosition.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([position, v]) =>
        v.title === null ? { position, html: v.html } : { position, html: v.html, title: v.title },
      );
  }

  get size(): number {
    return this.byPosition.size;
  }
}
