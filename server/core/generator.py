from dataclasses import dataclass
import os
from datetime import datetime
from server.core.state import SAVED_SLIDES_DIR

@dataclass
class ChatRequest:
    message: str
    system_prompt: str = ""
    page_count: int | None = None
    format: str = ""
    style: str = "auto"
    conversation_id: str | None = None
    api_key: str = ""
    base_url: str = ""

@dataclass
class BatchRequest:
    prompts: list[str]
    format: str = ""
    style: str = "auto"
    page_count: int | None = None


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
