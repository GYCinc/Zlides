import json
from pathlib import Path
from server.core.state import PREFERENCES_FILE

FORMATS_DIR = Path("formats")


# ── Dynamic Loaders ─────────────────────────────────────────────────────────
# Drop a JSON into formats/ or a CSS/MD into templates/ and it works.
# No Python editing required.


def load_format_metadata() -> list[dict]:
    """Load format metadata for the /formats endpoint."""
    results = []
    if not FORMATS_DIR.exists():
        return results
    for f in sorted(FORMATS_DIR.glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            results.append({
                "id": data.get("id", f.stem),
                "name": data.get("name", f.stem.title()),
                "description": data.get("description", data.get("prompt", "")[:80]),
            })
        except Exception:
            pass
    return results


def load_preferences() -> str:
    """Load PREFERENCES.md if it exists — injected into every system prompt."""
    try:
        if PREFERENCES_FILE.exists():
            return PREFERENCES_FILE.read_text(encoding="utf-8").strip()
    except Exception:
        pass
    return ""

