import os
import time
import json
import asyncio
import uuid
import secrets
from datetime import datetime
from pathlib import Path
from pydantic import BaseModel
from server.core.state import SAVED_SLIDES_DIR, save_session
from server.core.styles import embed_style_fonts, load_style_bank

class ChatRequest(BaseModel):
    message: str
    system_prompt: str = ""
    role: str = "balanced"
    page_count: int | None = None
    slide_type: str = "slides"
    theme: str = ""
    language: str = "en"
    web_search: bool = True
    format: str = "slides"
    style: str = "auto"
    api_key: str = ""
    base_url: str = ""

class BatchRequest(BaseModel):
    prompts: list[str]
    format: str = "slides"
    style: str = "auto"
    role: str = "balanced"
    page_count: int | None = None

def clean_agent_output(raw: str) -> str:
    """Clean the raw agent output — strip code fences, extract HTML."""
    if not raw or len(raw) < 20:
        return ""
    text = raw.strip()

    # Strip markdown code fences
    if text.startswith("```"):
        first_newline = text.index("\n") if "\n" in text else len(text)
        text = text[first_newline + 1 :]
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3].rstrip()

    text = text.strip()
    if text.startswith("<") or text.startswith("<!DOCTYPE"):
        return text

    for marker in ["<!DOCTYPE", "<html", "<div", "<section", "<style"]:
        idx = text.find(marker)
        if idx >= 0:
            return text[idx:]
    return ""

def combine_tool_pages(pages: list) -> str:
    """Combine HTML chunks from tool outputs into a single document, resolving updates and deletes surgically."""
    if not pages:
        return ""

    active_pages = {}
    for p in pages:
        position = p.get("position")
        tool_name = p.get("tool_name", "")
        html = p.get("html", "")

        if not position:
            continue

        pos_key = tuple(position)

        # Check if this is a deletion
        if any(w in tool_name for w in ["remove", "delete"]):
            active_pages.pop(pos_key, None)
        else:
            # Overwrite or insert the page
            active_pages[pos_key] = html

    sorted_keys = sorted(active_pages.keys())
    html_chunks = [active_pages[k] for k in sorted_keys]
    combined = "".join(html_chunks)
    combined = combined.replace("\\n", "\n").replace('\\"', '"')
    combined = combined.strip()

    if combined.startswith("<") or combined.startswith("<!DOCTYPE"):
        return combined

    for marker in ["<!DOCTYPE", "<html", "<div", "<section", "<style"]:
        idx = combined.find(marker)
        if idx >= 0:
            return combined[idx:]
    return ""

def extract_final_html(data: dict) -> str:
    """Extract HTML from a complete (non-streaming) API response."""
    if not isinstance(data, dict):
        return ""
    choices = data.get("choices", [])
    if not choices:
        return ""
    messages = choices[0].get("messages", [])

    for msg in messages:
        content = msg.get("content", [])
        if isinstance(content, list):
            for item in content:
                if item.get("type") == "object":
                    output = item.get("object", {}).get("output", "")
                    if output and len(output) > 50:
                        return output

    for msg in messages:
        content = msg.get("content", [])
        if isinstance(content, list):
            for item in content:
                if item.get("type") == "text":
                    text = item.get("text", "")
                    if text and ("<" in text) and len(text) > 50:
                        cleaned = clean_agent_output(text)
                        if cleaned:
                            return cleaned

    for msg in messages:
        content = msg.get("content", {})
        if isinstance(content, dict):
            text = content.get("text", "")
            if text and len(text) > 50:
                return text
    return ""

def save_slide_to_file(html: str, prompt: str) -> str:
    try:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        clean = (
            "".join(c for c in prompt[:30] if c.isalnum() or c in " _-")
            .strip()
            .replace(" ", "_")
        )
        if not clean:
            clean = "untitled"
        filepath = os.path.join(SAVED_SLIDES_DIR, f"slide_{timestamp}_{clean}.html")
        os.makedirs(SAVED_SLIDES_DIR, exist_ok=True)

        # Estimate generation cost to embed in file metadata comment
        input_words = len(prompt.split())
        est_input_tokens = int(input_words * 1.5) + 8000
        est_output_tokens = int(len(html) / 4)
        total_tokens = est_input_tokens + est_output_tokens
        # $0.007 per 1k input/output combined token rate (agent overhead factored)
        est_cost_usd = (total_tokens / 1_000_000) * 0.007
        
        metadata_comment = (
            f"\n\n<!-- Zlides Generation Metadata:\n"
            f"  - Timestamp: {timestamp}\n"
            f"  - Prompt: {prompt[:120]}\n"
            f"  - Est. Input Tokens: {est_input_tokens}\n"
            f"  - Est. Output Tokens: {est_output_tokens}\n"
            f"  - Est. Cost (USD): ${est_cost_usd:.6f}\n"
            f"-->"
        )
        
        # Append metadata comment to the end of the HTML file
        html_with_metadata = html + metadata_comment

        with open(filepath, "w", encoding="utf-8") as f:
            f.write(html_with_metadata)
        print(f"[Save] {filepath} (Est. Cost: ${est_cost_usd:.6f})")
        return filepath
    except Exception as e:
        return f"save_failed: {e}"

def wrap_in_slide_html(content: str, title: str = "Slide") -> str:
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

class BatchSlideGenerator:
    """Headless batch slide generation for multiple topics/prompts."""
    def __init__(self, api_key: str, max_concurrent: int = 3):
        self.api_key = api_key
        self.max_concurrent = max_concurrent
        self.semaphore = asyncio.Semaphore(max_concurrent)

    async def _generate_one(self, payload: dict) -> dict:
        import httpx
        async with self.semaphore:
            try:
                # We call our own local /api/print endpoint so it handles all styling and file saving
                async with httpx.AsyncClient(timeout=300.0) as client:
                    resp = await client.post("http://127.0.0.1:2828/api/print", json=payload)
                    if resp.status_code == 200:
                        return {"status": "completed", "prompt": payload.get("message"), "file": resp.json().get("filename")}
                    return {"status": "error", "prompt": payload.get("message"), "error": resp.text}
            except Exception as e:
                return {"status": "error", "prompt": payload.get("message"), "error": str(e)}

    async def generate_topic_batch(self, topics: list[dict]) -> list[dict]:
        tasks = [
            self._generate_one(topic)
            for topic in topics
        ]
        return await asyncio.gather(*tasks, return_exceptions=True)
