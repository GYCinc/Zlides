from dataclasses import dataclass, field
import os
import time
import json
import uuid
from datetime import datetime
from pathlib import Path
from server.core.state import SAVED_SLIDES_DIR, save_session
from server.core.styles import embed_style_fonts, load_style_bank

@dataclass
class ChatRequest:
    message: str
    system_prompt: str = ""
    page_count: int | None = None
    format: str = ""
    style: str = "auto"
    api_key: str = ""
    base_url: str = ""

@dataclass
class BatchRequest:
    prompts: list[str]
    format: str = ""
    style: str = "auto"
    page_count: int | None = None

def assemble_html_by_position(accumulators: dict) -> str:
    """Concatenate accumulated tool-output fragments in position order.

    Tool outputs stream in fragments per position (the official tool contract:
    tool_name / output / position). The final document is the fragments joined
    in sorted position order, with a defensive final escape decode.
    """
    if not accumulators:
        return ""
    chunks = [accumulators[k] for k in sorted(accumulators.keys())]
    combined = "".join(chunks).replace("\\n", "\n").replace('\\"', '"')
    return combined.strip()


def extract_messages_from_chunk(chunk: dict) -> list[dict]:
    """Return the agent's message list from a chunk.

    Live-proven stream shape (zai-sdk): choices[].messages (array).
    Official API schema: choices[].message (array).
    """
    choices = chunk.get("choices") or []
    if not choices:
        return []
    messages = choices[0].get("message") or []
    if isinstance(messages, dict):
        messages = [messages]
    if not messages:
        messages = choices[0].get("messages") or []
    return messages


def save_generated_html(html: str, prompt: str) -> str:
    try:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        clean = (
            "".join(c for c in prompt[:30] if c.isalnum() or c in " _-")
            .strip()
            .replace(" ", "_")
        )
        if not clean:
            clean = "untitled"
        filepath = os.path.join(SAVED_SLIDES_DIR, f"zlides_{timestamp}_{clean}.html")
        os.makedirs(SAVED_SLIDES_DIR, exist_ok=True)

        with open(filepath, "w", encoding="utf-8") as f:
            f.write(html)
        print(f"[Save] {filepath}", flush=True)
        return filepath
    except Exception as e:
        return f"save_failed: {e}"

def wrap_in_html(content: str, title: str = "Document") -> str:
    content_stripped = content.strip()
    if content_stripped.startswith("<") and (
        "</" in content_stripped or "/>" in content_stripped
    ):
        return content

    lines = content.split("\n")
    formatted = []
    for line in lines:
        line = line.strip()
        if line.startswith("# "):
            formatted.append(f"<h1>{line[2:]}</h1>")
        elif line.startswith("## "):
            formatted.append(f"<h2>{line[3:]}</h2>")
        elif line.startswith("- "):
            formatted.append(f"<li>{line[2:]}</li>")
        elif line:
            formatted.append(f"<p>{line}</p>")

    html_content = "\n".join(formatted)
    if "<li>" in html_content:
        html_content = f"<ul>{html_content}</ul>"

    return f"""<!DOCTYPE html><html><head><meta charset="utf-8"><title>{title}</title>
<style>
body {{ font-family: system-ui, -apple-system, sans-serif; background: #131313; color: #e0e0e0; padding: 40px; line-height: 1.6; max-width: 800px; margin: 0 auto; }}
h1 {{ color: #ff6600; font-size: 2.5em; border-bottom: 2px solid #ff6600; padding-bottom: 10px; margin-bottom: 30px; }}
h2 {{ font-size: 2em; margin: 30px 0 15px; }}
h3 {{ font-size: 1.5em; margin: 25px 0 10px; }}
p {{ margin-bottom: 15px; font-size: 1.1em; }}
ul {{ margin: 20px 0; padding-left: 30px; }}
li {{ margin-bottom: 10px; font-size: 1.1em; }}
</style></head>
<body>{html_content}</body></html>"""
