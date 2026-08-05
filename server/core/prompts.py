import json
from pathlib import Path
from server.core.state import PREFERENCES_FILE
from server.core.styles import load_style_bank

FORMATS_DIR = Path("formats")


# ── Dynamic Loaders ─────────────────────────────────────────────────────────
# Drop a JSON into formats/ or a CSS/MD into templates/ and it works.
# No Python editing required.


def load_formats() -> dict[str, str]:
    """Load all format definitions from formats/*.json.

    Each JSON file must have at minimum:
      { "id": "slides", "prompt": "Create a multi-slide..." }

    Returns a dict mapping format file stem -> prompt string.
    """
    formats = {}
    if not FORMATS_DIR.exists():
        return formats
    for f in sorted(FORMATS_DIR.glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            formats[f.stem] = data.get("prompt", "")
        except Exception as e:
            print(f"[Formats] Failed to load {f}: {e}")
    return formats


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


# ── Convenience Accessors (backward-compatible names) ───────────────────────


def _get_formats() -> dict[str, str]:
    """Get formats, with a hardcoded fallback if the formats/ dir is empty."""
    formats = load_formats()
    if not formats:
        # Bare minimum fallback so the server never breaks
        formats["slides"] = "Create a multi-slide HTML presentation."
    return formats


FORMATS = _get_formats()


def load_preferences() -> str:
    """Load PREFERENCES.md if it exists — injected into every system prompt."""
    try:
        if PREFERENCES_FILE.exists():
            return PREFERENCES_FILE.read_text(encoding="utf-8").strip()
    except Exception:
        pass
    return ""


def build_system_prompt(fmt: str, style_id: str, language: str = "en") -> str:
    """Build the generation instruction from format + style selections.

    No base system prompt: the Z.AI slides agent carries its own
    server-side prompt and the Agents API only accepts user messages —
    anything we send rides inside the user message, so keep it to what the
    user actually selected (format, template, preferences, style).
    """
    # Load format instruction dynamically
    formats = _get_formats()
    format_instruction = formats.get(fmt, "Create a standalone self-contained HTML document.")

    if fmt and fmt in formats:
        base = f"Create a {fmt} (HTML format).\n\n{format_instruction}"
    else:
        base = format_instruction

    # If a reference template exists for this format (formats/{fmt}.template.html),
    # inject it verbatim so the agent reproduces its structure exactly.
    template_file = FORMATS_DIR / f"{fmt}.template.html"
    if template_file.exists():
        base += (
            "\n\n--- TEMPLATE (reproduce EXACTLY, replace content with provided data) ---\n"
            + template_file.read_text(encoding="utf-8")
        )

    prefs = load_preferences()
    if prefs:
        base += f"\n\n--- USER PREFERENCES (follow these closely) ---\n{prefs}"

    if style_id and style_id != "auto":
        styles = load_style_bank()
        style = styles.get(style_id)
        if style:
            base += f"\n\nStyle: {style.get('prompt_hint', style.get('name', style_id))}"
            css = style.get('css', {})
            if css:
                base += "\n\nCRITICAL COLOR PALETTE INSTRUCTIONS:\n"
                base += "You must explicitly use these exact hex colors in your inline CSS styling:\n"
                for k, v in css.items():
                    base += f"- {k}: {v}\n"

    return base
