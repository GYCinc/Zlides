from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

router = APIRouter()

@router.post("/export/html")
async def export_html(request: dict):
    """Return full HTML document for download."""
    html = request.get("html", "")
    if not html:
        raise HTTPException(status_code=400, detail="No HTML provided")
    return JSONResponse(content={"html": html})
