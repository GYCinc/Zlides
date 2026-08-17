"""Z.AI agent streaming — exactly the official API contract, nothing else.

Official (docs.z.ai/api-reference/agents/agent.md):
  POST /v1/agents {agent_id, stream, conversation_id, request_id, messages}
  chunk: conversation_id, choices[].messages[] {phase: thinking|tool|answer,
         content[] {type: text|object, object: {tool_name, output, position}}},
         usage, error
Pricing (docs.z.ai/guides/agents/slide.md): $0.70 per 1M tokens.

The user message is composed from the user's own format prompt + optional
{fmt}.template.html + the request text. Everything else in this file is the
official response contract, verbatim.
"""

import json
import re
import uuid
from pathlib import Path
import httpx

with open("layouts.json", "r", encoding="utf-8") as lf:
    layout_matrix = json.load(lf)
RATE_USD_PER_M = 0.70
DEFAULT_ZAI_URL = "https://api.z.ai/api/v1/agents"


def combine_html_chunks(chunks: list[str]) -> str:
    """Combine multiple HTML page chunks into a single valid HTML document.

    If there is only 1 chunk or chunks are simple fragments, join them.
    If multiple full <!DOCTYPE html> documents are returned, extract styles/head
    from the first document and merge body contents cleanly into one master document.
    """
    if not chunks:
        return ""
    if len(chunks) == 1:
        return chunks[0]

    # Check if multiple chunks are full HTML documents
    doctype_count = sum(1 for c in chunks if "<!doctype" in c.lower() or "<html" in c.lower())
    if doctype_count <= 1:
        return "".join(chunks)

    styles = []
    for c in chunks:
        for m in re.finditer(r"<style\b[^>]*>([\s\S]*?)</style>", c, re.IGNORECASE):
            styles.append(m.group(1).strip())

    bodies = []
    for c in chunks:
        m = re.search(r"<body\b[^>]*>([\s\S]*?)</body>", c, re.IGNORECASE)
        if m:
            bodies.append(m.group(1).strip())
        else:
            clean_c = re.sub(r"<!DOCTYPE[^>]*>", "", c, flags=re.IGNORECASE)
            clean_c = re.sub(r"</?(?:html|head|body)\b[^>]*>", "", clean_c, flags=re.IGNORECASE)
            clean_c = re.sub(r"<style\b[^>]*>[\s\S]*?</style>", "", clean_c, flags=re.IGNORECASE)
            if clean_c.strip():
                bodies.append(clean_c.strip())

    combined_style = "\n\n".join(set(styles))
    combined_body = "\n\n".join(bodies)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.75"/>
<style>
{combined_style}
</style>
</head>
<body>
{combined_body}
</body>
</html>"""


LAYOUT_DIRECTIVES = {
        "document": """// SYSTEM GLOBAL CONFIGURATION
    GLOBAL_MARGIN = 0.0
    GLOBAL_BLEED  = true

    // FORMAT 1: LETTER DOCUMENT
    DOCUMENT_LAYOUT = [
        width: 215.9mm,
        height: 279.4mm,
        margin_top: GLOBAL_MARGIN,
        margin_bottom: GLOBAL_MARGIN,
        margin_left: GLOBAL_MARGIN,
        margin_right: GLOBAL_MARGIN,
        bleed: GLOBAL_BLEED
    ]""",
        "slides": """// SYSTEM GLOBAL CONFIGURATION
    GLOBAL_MARGIN = 0.0
    GLOBAL_BLEED  = true

    // FORMAT 2: WIDESCREEN SLIDE
    SLIDE_LAYOUT = [
        width: 1920px,
        height: 1080px,
        margin_top: GLOBAL_MARGIN,
        margin_bottom: GLOBAL_MARGIN,
        margin_left: GLOBAL_MARGIN,
        margin_right: GLOBAL_MARGIN,
        bleed: GLOBAL_BLEED
    ]""",
        "web": """// SYSTEM GLOBAL CONFIGURATION
    GLOBAL_MARGIN = 0.0
    GLOBAL_BLEED  = true

    // FORMAT 3: DESKTOP WEB PAGE
    WEB_PAGE_LAYOUT = [
        width: 1440px,
        height: dynamic,
        margin_top: GLOBAL_MARGIN,
        margin_bottom: GLOBAL_MARGIN,
        margin_left: GLOBAL_MARGIN,
        margin_right: GLOBAL_MARGIN,
        bleed: GLOBAL_BLEED
    ]"""
    }


    if fmt_clean and fmt_clean != "auto":
        fmt_file = FORMATS_DIR / f"{fmt_clean}.json"
        if fmt_file.exists():
            try:
                # Read the file text directly without parsing a specific key
                instruction = fmt_file.read_text(encoding="utf-8")
                if instruction:
                    parts.append(instruction)
            except Exception:
                pass


    # 2. Content (User Source Data)
    parts.append(message)

    # 3. Visual Style (Modifier on top of structured content)
    if style_id and style_id != "auto":
        styles = load_style_bank()
        style_pack = styles.get(style_id)
        if style_pack:
            hint = style_pack.get("prompt_hint", "")
            if hint:
                parts.append(f"STYLE DIRECTIVE:\n{hint}")

    return "\n\n".join(parts)


def _messages_from_chunk(chunk: dict) -> list[dict]:
    """Live stream shape: choices[].messages (array); official schema: .message."""
    choices = chunk.get("choices") or []
    if not choices:
        return []
    first_choice = choices[0]
    messages = first_choice.get("message") or first_choice.get("messages") or []
    if isinstance(messages, dict):
        messages = [messages]
    return messages


async def stream(api_key: str, fmt: str, message: str,
                 style: str = "auto",
                 conversation_id: str | None = None,
                 base_url: str | None = None):
    """Stream one generation using direct HTTP SSE. Yields (event, payload); last is
    ("final_html", {"html", "filename", "conversation_id", "cost_usd"})."""
    if not api_key:
        raise ValueError("No Z.AI API key configured.")

    messages = [{"role": "user", "content": [{"type": "text", "text": build_prompt(fmt, message, style)}]}]

    payload = {
        "agent_id": "slides_glm_agent",
        "stream": True,
        "messages": messages,
        "request_id": str(uuid.uuid4()),
    }
    if conversation_id:
        payload["conversation_id"] = conversation_id

    # Resolve target endpoint URL
    target_url = base_url.strip() if base_url and base_url.strip() else DEFAULT_ZAI_URL
    if not target_url.endswith("/v1/agents"):
        target_url = target_url.rstrip("/") + "/v1/agents"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }

    accumulators: dict[tuple, str] = {}
    usage: dict = {}

    import os
    cert_path = True
    try:
        import certifi
        cp = certifi.where()
        if cp and os.path.exists(cp):
            cert_path = cp
    except Exception:
        cert_path = True

    try:
        try:
            client = httpx.AsyncClient(timeout=180.0, verify=cert_path)
        except (FileNotFoundError, Exception):
            client = httpx.AsyncClient(timeout=180.0, verify=False)

        async with client:
            async with client.stream("POST", target_url, headers=headers, json=payload) as response:
                if response.status_code != 200:
                    body = await response.aread()
                    error_msg = body.decode("utf-8", errors="ignore")
                    yield ("error", {"type": "error", "text": f"Z.AI HTTP {response.status_code}: {error_msg}"})
                    return

                async for line in response.aiter_lines():
                    line = line.strip()
                    if not line or not line.startswith("data:"):
                        continue

                    data_str = line[5:].strip()
                    if data_str == "[DONE]":
                        break

                    try:
                        chunk = json.loads(data_str)
                    except Exception:
                        continue

                    if not isinstance(chunk, dict):
                        continue

                    if chunk.get("conversation_id"):
                        conversation_id = chunk["conversation_id"]
                    if chunk.get("usage"):
                        usage = chunk["usage"]
                    if chunk.get("error"):
                        err = chunk["error"]
                        err_text = err.get("message", "Z.AI generation failed") if isinstance(err, dict) else str(err)
                        yield ("error", {"type": "error", "text": err_text})
                        return

                    for msg in _messages_from_chunk(chunk):
                        phase = msg.get("phase")
                        content_data = msg.get("content")
                        contents = content_data if isinstance(content_data, list) else ([content_data] if isinstance(content_data, dict) else [])
                        for content in contents:
                            if content.get("type") == "text" and content.get("text"):
                                event = "thinking" if phase == "thinking" else "answer"
                                yield (event, {"type": event, "content": content["text"]})

                            elif content.get("type") == "object":
                                obj = content.get("object", {})
                                output = obj.get("output", "")
                                position = obj.get("position", [0])
                                if output:
                                    if not isinstance(output, str):
                                        output = str(output)
                                    key = tuple(position)
                                    accumulators[key] = accumulators.get(key, "") + output.replace("\\n", "\n").replace('\\"', '"')
                                    yield ("page", {
                                        "type": "page",
                                        "html": accumulators[key],
                                        "position": position,
                                        "tool_name": obj.get("tool_name", ""),
                                    })
    except Exception as ex:
        yield ("error", {"type": "error", "text": f"Z.AI stream error ({type(ex).__name__}): {ex}"})
        return

    raw_chunks = [accumulators[k] for k in sorted(accumulators)] if accumulators else []
    document = combine_html_chunks(raw_chunks)
    if not document:
        yield ("error", {"type": "error", "text": "Agent produced no HTML output."})
        return

    total_tokens = usage.get("total_tokens") or (usage.get("prompt_tokens", 0) + usage.get("completion_tokens", 0))
    yield ("final_html", {
        "type": "final_html",
        "html": document,
        "conversation_id": conversation_id,
        "usage": usage,
        "prompt_tokens": usage.get("prompt_tokens", 0),
        "completion_tokens": usage.get("completion_tokens", 0),
        "total_tokens": total_tokens,
        "cost_usd": round(total_tokens * RATE_USD_PER_M / 1_000_000, 4),
    })
