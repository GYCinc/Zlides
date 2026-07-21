from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pathlib import Path
from datetime import datetime
import re
from server.core.state import SAVED_SLIDES_DIR

router = APIRouter()

@router.get("/saved")
async def list_saved_slides():
    """List all saved slides with metadata."""
    saved_dir = Path(SAVED_SLIDES_DIR)
    slides = []
    for f in sorted(saved_dir.glob("*.html"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            content = f.read_text(encoding="utf-8")
            title = f.stem
            m = re.search(r"<title>(.*?)</title>", content)
            if m:
                title = m.group(1)
            slides.append({
                "filename": f.name,
                "title": title,
                "size": f.stat().st_size,
                "modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
                "date": datetime.fromtimestamp(f.stat().st_mtime).strftime("%b %d, %H:%M"),
            })
        except Exception:
            pass
    return slides

@router.get("/saved/{filename}")
async def get_saved_slide(filename: str):
    """Serve a saved slide HTML file."""
    filepath = Path(SAVED_SLIDES_DIR) / filename
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Slide not found")
    return FileResponse(filepath)

@router.delete("/saved/{filename}")
async def delete_saved_slide(filename: str):
    """Delete a saved slide HTML file."""
    filepath = Path(SAVED_SLIDES_DIR) / filename
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Slide not found")
    
    try:
        filepath.unlink()
        return {"status": "success", "message": "File deleted"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
