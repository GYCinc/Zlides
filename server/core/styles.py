import json
from server.core.state import STYLE_BANK_DIR, FONT_DIR

def load_style_bank() -> dict:
    """Load all style packs from style_bank/ directory."""
    styles = {}
    for f in STYLE_BANK_DIR.glob("*.json"):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            styles[data["id"]] = data
        except Exception as e:
            print(f"[StyleBank] Failed to load {f}: {e}")
    return styles

def embed_style_fonts(html: str, style_pack: dict | None) -> str:
    """Make a generated HTML doc font-self-contained for a style pack."""
    import base64 as _b64
    import re as _re

    if not html:
        return html

    # 1. Strip external font imports / links
    html = _re.sub(
        r"@import\s+url\(\s*['\"]?https?://[^)]*(?:fonts\.googleapis|fonts\.gstatic|fonts\.bunny|fontsource|use\.typekit)[^)]*\)\s*[^;]*;?",
        "",
        html,
        flags=_re.IGNORECASE,
    )
    html = _re.sub(
        r"<link\b[^>]*(?:fonts\.googleapis|fonts\.gstatic|fonts\.bunny)[^>]*>",
        "",
        html,
        flags=_re.IGNORECASE,
    )

    # 2. Build embedded @font-face blocks for fonts that have local .woff2
    fonts = (style_pack or {}).get("fonts", {})
    face_blocks = []
    for role in ("heading", "body"):
        stack = fonts.get(role, "")
        if not stack:
            continue
        m = _re.search(r"['\"]([^'\"]+)['\"]", stack)
        if not m:
            continue
        family = m.group(1)
        for woff2 in sorted(FONT_DIR.glob(f"{family.lower()}-*.woff2")):
            wm = _re.search(r"-(\d{3})$", woff2.stem)
            weight = wm.group(1) if wm else "400"
            b64 = _b64.b64encode(woff2.read_bytes()).decode("ascii")
            face_blocks.append(
                f"@font-face{{font-family:'{family}';font-weight:{weight};"
                f"font-style:normal;font-display:swap;"
                f"src:url(data:font/woff2;base64,{b64}) format('woff2');}}"
            )

    if not face_blocks:
        return html

    injection = "\n<style>\n" + "\n".join(face_blocks) + "\n</style>\n"
    if "</head>" in html:
        return html.replace("</head>", f"{injection}</head>", 1)
    if "<style>" in html:
        return html.replace("<style>", f"{injection}\n<style>", 1)
    return injection + html
