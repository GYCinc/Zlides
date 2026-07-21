import json
from pathlib import Path
from server.core.state import PREFERENCES_FILE
from server.core.styles import load_style_bank

FORMATS_DIR = Path("formats")
TEMPLATES_DIR = Path("templates")
ROLES_DIR = Path("roles")


# ── Dynamic Loaders ─────────────────────────────────────────────────────────
# Drop a JSON into formats/, roles/, or a CSS/MD into templates/ and it works.
# No Python editing required.


def load_formats() -> dict[str, str]:
    """Load all format definitions from formats/*.json.

    Each JSON file must have at minimum:
      { "id": "slides", "prompt": "Create a multi-slide..." }

    Returns a dict mapping format id -> prompt string.
    """
    formats = {}
    if not FORMATS_DIR.exists():
        return formats
    for f in sorted(FORMATS_DIR.glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            fid = data.get("id", f.stem)
            formats[fid] = data.get("prompt", "")
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


def load_roles() -> dict[str, dict]:
    """Load all personality role definitions from roles/*.json.

    Each JSON file must have at minimum:
      { "id": "balanced", "name": "Balanced", "prompt": "You are..." }

    Returns a dict mapping role id -> full role dict.
    """
    roles = {}
    if not ROLES_DIR.exists():
        return roles
    for f in sorted(ROLES_DIR.glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            rid = data.get("id", f.stem)
            roles[rid] = data
        except Exception as e:
            print(f"[Roles] Failed to load {f}: {e}")
    return roles


def load_role_metadata() -> list[dict]:
    """Load role metadata for the /roles endpoint."""
    results = []
    if not ROLES_DIR.exists():
        return results
    for f in sorted(ROLES_DIR.glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            results.append({
                "id": data.get("id", f.stem),
                "name": data.get("name", f.stem.replace("-", " ").title()),
                "description": data.get("description", ""),
            })
        except Exception:
            pass
    return results


def load_print_css(mode: str = "light") -> str:
    """Load a print CSS template from templates/print-{mode}.css.

    Falls back to an empty string if the file doesn't exist.
    Wraps the raw CSS in <style> tags for injection.
    """
    css_file = TEMPLATES_DIR / f"print-{mode}.css"
    if css_file.exists():
        raw = css_file.read_text(encoding="utf-8").strip()
        return f"<style>{raw}</style>"
    return ""


def load_template(name: str) -> str:
    """Load a text/markdown template from templates/{name}.

    Returns the raw file content, or an empty string if not found.
    """
    tpl = TEMPLATES_DIR / name
    if tpl.exists():
        return tpl.read_text(encoding="utf-8").strip()
    return ""


# ── Convenience Accessors (backward-compatible names) ───────────────────────


def _get_formats() -> dict[str, str]:
    """Get formats, with a hardcoded fallback if the formats/ dir is empty."""
    formats = load_formats()
    if not formats:
        # Bare minimum fallback so the server never breaks
        formats["slides"] = "Create a multi-slide HTML presentation."
    return formats


FORMATS = _get_formats()

UNIVERSAL_PRINT_LIGHT = load_print_css("light")
UNIVERSAL_PRINT_BRANDED = load_print_css("branded")

PRINT_PROMPT_INSTRUCTIONS = "\n\n" + load_template("print-rules.md") if load_template("print-rules.md") else ""

DEFAULT_ROLE_PROMPT = (
    "You are an expert graphic designer, curriculum developer, and professional presentations editor. "
    "You specialize in designing high-quality, beautiful, and semantic HTML layouts for slides, posters, reports, and interactive worksheets. "
    "Your designs are modern, clean, print-friendly, and visually outstanding."
)


def inject_print_css(html: str, light: bool = True) -> str:
    """Inject universal print CSS before </head>."""
    css = UNIVERSAL_PRINT_LIGHT if light else UNIVERSAL_PRINT_BRANDED
    if not css:
        return html
    if "</head>" in html:
        return html.replace("</head>", f"\n{css}\n</head>", 1)
    elif "</style>" in html:
        return html.replace("</style>", f"</style>\n{css}", 1)
    else:
        return html + css


def load_preferences() -> str:
    """Load PREFERENCES.md if it exists — injected into every system prompt."""
    try:
        if PREFERENCES_FILE.exists():
            return PREFERENCES_FILE.read_text(encoding="utf-8").strip()
    except Exception:
        pass
    return ""


def get_role_prompt(role_id: str = "balanced") -> str:
    """Get the role instruction for a given personality preset.

    Falls back to: roles/*.json -> templates/role.md -> hardcoded default.
    """
    # First try roles/ directory
    if role_id and role_id != "balanced":
        roles = load_roles()
        role = roles.get(role_id)
        if role:
            return role.get("prompt", DEFAULT_ROLE_PROMPT)

    # For "balanced" or missing role, check roles/balanced.json first
    roles = load_roles()
    balanced = roles.get("balanced")
    if balanced:
        return balanced.get("prompt", DEFAULT_ROLE_PROMPT)

    # Fallback to templates/role.md (legacy)
    role_md = load_template("role.md")
    if role_md:
        return role_md

    return DEFAULT_ROLE_PROMPT


def build_system_prompt(fmt: str, style_id: str, language: str = "en", role_id: str = "balanced") -> str:
    """Build the system prompt from role + format + style selections."""
    # Load role instruction from personality preset
    role_instruction = get_role_prompt(role_id)

    # Load format instruction dynamically
    formats = _get_formats()
    format_instruction = formats.get(fmt, formats.get("slides", ""))

    base = f"{role_instruction}\n\nCreate a {fmt} (HTML format).\n\n{format_instruction}"

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

    if PRINT_PROMPT_INSTRUCTIONS:
        base += PRINT_PROMPT_INSTRUCTIONS

    return base
