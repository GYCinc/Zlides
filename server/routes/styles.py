from fastapi import APIRouter, HTTPException
import json
from datetime import datetime
from server.core.state import STYLE_BANK_DIR
from server.core.styles import load_style_bank

router = APIRouter()

@router.get("/styles")
async def list_styles():
    """List all styles in bank (metadata only)."""
    styles = load_style_bank()
    result = []
    for sid, s in styles.items():
        result.append(
            {
                "id": sid,
                "name": s.get("name", sid),
                "preview_colors": s.get("preview_colors", []),
                "brand_png": s.get("brand_png"),
            }
        )
    return [{"id": "auto", "name": "Auto", "preview_colors": []}] + result

@router.get("/styles/{style_id}")
async def get_style(style_id: str):
    """Get full style pack."""
    styles = load_style_bank()
    if style_id not in styles:
        raise HTTPException(status_code=404, detail="Style not found")
    return styles[style_id]

@router.post("/styles/save")
async def save_style(request: dict):
    """Save a style pack to the bank."""
    style = request.get("style")
    if not style or not isinstance(style, dict) or "id" not in style:
        raise HTTPException(status_code=400, detail="Style must have an 'id'")

    sid = style["id"].lower().replace(" ", "-")
    filepath = STYLE_BANK_DIR / f"{sid}.json"

    style["id"] = sid
    style.setdefault("created_at", datetime.now().strftime("%Y-%m-%d"))
    style.setdefault("prompt_hint", "")
    style.setdefault("css", {})
    style.setdefault("fonts", {})
    style.setdefault("print_css", "")

    filepath.write_text(
        json.dumps(style, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return {"saved": True, "id": sid}

@router.delete("/styles/{style_id}")
async def delete_style(style_id: str):
    """Delete a style from the bank."""
    filepath = STYLE_BANK_DIR / f"{style_id}.json"
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Style not found")
    filepath.unlink()
    return {"deleted": True}
