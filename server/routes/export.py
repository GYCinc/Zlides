from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from io import BytesIO
from datetime import datetime
from server.core.prompts import UNIVERSAL_PRINT_LIGHT, UNIVERSAL_PRINT_BRANDED, inject_print_css
from server.core.export import html_to_pdf

router = APIRouter()

class PdfExportRequest(BaseModel):
    html: str
    options: dict | None = None
    print_mode: str | None = None  # "light" (default) or "branded"

@router.post("/export/html")
async def export_html(request: dict):
    """Return full HTML document for download."""
    html = request.get("html", "")
    if not html:
        raise HTTPException(status_code=400, detail="No HTML provided")
    return JSONResponse(content={"html": html})

@router.post("/export/pdf")
async def export_pdf(request: PdfExportRequest):
    """Convert provided HTML to a downloadable PDF document using Playwright."""
    if not request.html:
        raise HTTPException(status_code=400, detail="No HTML provided")

    html = request.html
    mode = request.print_mode or "light"

    if mode == "branded":
        html = html.replace(UNIVERSAL_PRINT_LIGHT, UNIVERSAL_PRINT_BRANDED)
    else:
        if UNIVERSAL_PRINT_LIGHT not in html:
            html = inject_print_css(html, light=True)

    try:
        pdf_bytes = await html_to_pdf(html, request.options or {})
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PDF generation failed: {e}")

    filename = f"slide_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf"
    return StreamingResponse(
        BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
