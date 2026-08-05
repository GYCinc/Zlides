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

import asyncio
import json
import uuid
from pathlib import Path

from zai import ZaiClient

FORMATS_DIR = Path("formats")
RATE_USD_PER_M = 0.70


def build_prompt(fmt: str, message: str) -> str:
    """Format instruction + verbatim template + user request, in one message."""
    instruction = ""
    fmt_file = FORMATS_DIR / f"{fmt}.json"
    if fmt_file.exists():
        instruction = json.loads(fmt_file.read_text(encoding="utf-8")).get("prompt", "")

    if fmt and instruction:
        base = f"Create a {fmt} (HTML format).\n\n{instruction}"
    else:
        base = instruction or "Create a standalone self-contained HTML document."

    template_file = FORMATS_DIR / f"{fmt}.template.html"
    if template_file.exists():
        base += (
            "\n\n--- TEMPLATE (reproduce EXACTLY, replace content with provided data) ---\n"
            + template_file.read_text(encoding="utf-8")
        )

    return f"{base}\n\nUSER REQUEST:\n{message}"


def _next_or_none(iterator):
    try:
        return next(iterator)
    except StopIteration:
        return None


def _messages_from_chunk(chunk: dict) -> list[dict]:
    """Live stream shape: choices[].messages (array); official schema: .message."""
    choices = chunk.get("choices") or []
    if not choices:
        return []
    messages = choices[0].get("message") or []
    if isinstance(messages, dict):
        messages = [messages]
    return messages or (choices[0].get("messages") or [])


async def stream(api_key: str, fmt: str, message: str,
                 conversation_id: str | None = None,
                 base_url: str | None = None):
    """Stream one generation. Yields (event, payload); last is
    ("final_html", {"html", "filename", "conversation_id", "cost_usd"})."""
    if not api_key:
        raise ValueError("No Z.AI API key configured.")

    messages = [{"role": "user", "content": [{"type": "text", "text": build_prompt(fmt, message)}]}]

    kwargs = {
        "agent_id": "slides_glm_agent",
        "stream": True,
        "messages": messages,
        "request_id": str(uuid.uuid4()),
    }
    if conversation_id:
        kwargs["extra_body"] = {"conversation_id": conversation_id}

    if base_url and base_url.rstrip("/").endswith("/v1/agents"):
        base_url = base_url[: base_url.rfind("/v1/agents")]
    if not base_url:
        base_url = None

    def _open():
        client = ZaiClient(api_key=api_key, base_url=base_url)
        return client.agents.invoke(**kwargs)

    stream_iter = await asyncio.to_thread(_open)

    accumulators: dict[tuple, str] = {}
    usage: dict = {}

    while True:
        try:
            chunk_obj = await asyncio.to_thread(_next_or_none, stream_iter)
        except Exception as ex:
            yield ("error", {"type": "error", "text": f"Z.AI stream error: {ex}"})
            return
        if chunk_obj is None:
            break

        try:
            chunk = chunk_obj.to_dict() if hasattr(chunk_obj, "to_dict") else chunk_obj
        except Exception:
            continue
        if not isinstance(chunk, dict):
            continue

        if chunk.get("conversation_id"):
            conversation_id = chunk["conversation_id"]
        if chunk.get("usage"):
            usage = chunk["usage"]
        if chunk.get("error"):
            error = chunk["error"]
            yield ("error", {"type": "error", "text": error.get("message", "Z.AI generation failed") if isinstance(error, dict) else str(error)})
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

    document = "".join(accumulators[k] for k in sorted(accumulators)) if accumulators else ""
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
