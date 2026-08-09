import os
import time
import json
import asyncio
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

VERSION = "0.2.0"
Z_AI_API_KEY = os.getenv("Z_AI_API_KEY", "")

SAVED_SLIDES_DIR = "saved_slides"
SESSION_FILE = "session.json"
STYLE_BANK_DIR = Path("style_bank")
ASSETS_DIR = Path("assets")
FONT_DIR = ASSETS_DIR / "fonts"
PREFERENCES_FILE = Path("PREFERENCES.md")

os.makedirs(SAVED_SLIDES_DIR, exist_ok=True)
os.makedirs(STYLE_BANK_DIR, exist_ok=True)

SESSION_TTL_SECONDS = 30 * 60

# Thread-safe session helpers
_session_lock = asyncio.Lock()

def load_session() -> dict:
    if os.path.exists(SESSION_FILE):
        try:
            with open(SESSION_FILE, "r") as f:
                data = json.load(f)
                ts = data.get("updated_at", 0)
                if ts and (time.time() - ts) > SESSION_TTL_SECONDS:
                    return {"conversation_id": None}
                return data
        except Exception:
            pass
    return {"conversation_id": None}

def save_session(session: dict):
    session["updated_at"] = time.time()
    with open(SESSION_FILE, "w") as f:
        json.dump(session, f)

def clear_session():
    """Wipe session.json file from disk immediately."""
    if os.path.exists(SESSION_FILE):
        try:
            os.remove(SESSION_FILE)
        except Exception:
            pass

async def set_conversation_id(conv_id: str | None):
    async with _session_lock:
        session = load_session()
        session["conversation_id"] = conv_id
        save_session(session)

async def get_session_store() -> dict:
    async with _session_lock:
        return load_session()

def sanitize_html(html: str) -> str:
    """Sanitize the HTML by stripping `<script>` tags and inline `on*` event handlers to prevent XSS in the same-origin sandboxed iframe."""
    if not html:
        return html
    import re
    # Remove script tags and all content inside them
    html = re.sub(r"<script\b[^>]*>([\s\S]*?)</script>", "", html, flags=re.IGNORECASE)
    # Remove inline on* event handlers
    html = re.sub(r"\bon[a-zA-Z]+\s*=\s*(['\"])(.*?)\1", "", html, flags=re.IGNORECASE)
    html = re.sub(r"\bon[a-zA-Z]+\s*=\s*([^'\">\s]+)", "", html, flags=re.IGNORECASE)
    return html
