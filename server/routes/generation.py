"""Zlides API routes — thin layer over server/stream.py (the generation program).

Routes only: /health, /formats, /upload, /batch, /command. Generation itself
lives in server/stream.py; this file handles HTTP concerns (style/fonts/sanitize
post-processing, saving, session persistence).
"""

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import StreamingResponse
import json

from server.core.state import (
    Z_AI_API_KEY, STYLE_BANK_DIR, VERSION,
    get_session_store, set_conversation_id, sanitize_html,
)
from server.core.prompts import load_format_metadata
from server.core.styles import load_style_bank, embed_style_fonts
from server.core.parser import FileParserPipeline
from server.core.generator import (
    ChatRequest, BatchRequest, save_generated_html,
)
from server.stream import stream

router = APIRouter()
file_parser = FileParserPipeline(api_key=Z_AI_API_KEY)

EDIT_KEYWORDS = {"edit", "change", "modify", "update", "fix", "adjust", "reformat", "layout", "convert"}


def _is_edit_request(text: str) -> bool:
    return any(k in text.lower() for k in EDIT_KEYWORDS)


def _apply_style(html: str, style_id: str) -> str:
    """App layer: embed the style pack's fonts; sanitize before serving."""
    if style_id and style_id != "auto":
        sp = load_style_bank().get(style_id)
        if sp:
            html = embed_style_fonts(html, sp)
    return sanitize_html(html)


@router.get("/health")
async def health():
    return {"status": "ok", "service": "Zlides API", "version": VERSION}


@router.get("/formats")
async def list_formats():
    return load_format_metadata()


@router.post("/command")
async def send_command(request: ChatRequest):
    session_data = await get_session_store()
    conversation_id = session_data.get("conversation_id")
    if not _is_edit_request(request.message):
        conversation_id = None

    print(f"[API] Format: {request.format} | Style: {request.style} | Message: {request.message[:50]}...", flush=True)

    async def sse_generator():
        async for event_name, payload in stream(
            api_key=request.api_key or Z_AI_API_KEY,
            fmt=request.format,
            message=request.message,
            conversation_id=conversation_id,
            base_url=request.base_url,
        ):
            if event_name == "final_html":
                html = _apply_style(payload["html"], request.style)
                payload["html"] = html
                payload["filename"] = save_generated_html(html, request.message)
                if payload.get("conversation_id"):
                    await set_conversation_id(payload["conversation_id"])
            yield f"data: {json.dumps(payload)}\n\n"

    return StreamingResponse(sse_generator(), media_type="text/event-stream")


@router.post("/batch")
async def process_batch(req: BatchRequest):
    results = []
    for prompt in req.prompts:
        try:
            html = ""
            async for event_name, payload in stream(
                api_key=Z_AI_API_KEY,
                fmt=req.format,
                message=prompt,
            ):
                if event_name == "final_html":
                    html = _apply_style(payload["html"], req.style)
            if html:
                results.append({"status": "completed", "prompt": prompt, "filename": save_generated_html(html, prompt), "html": html})
            else:
                results.append({"status": "error", "prompt": prompt, "error": "no output"})
        except Exception as e:
            results.append({"status": "error", "prompt": prompt, "error": str(e)})
    return {"results": results, "status": "batch_completed"}


@router.post("/upload")
async def upload_file(file: UploadFile = File(...), type: str = Form("file")):
    ALLOWED_EXTENSIONS = {"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "png", "jpg", "jpeg", "csv", "txt", "md", "apkg", "zip"}
    ext = file.filename.split(".")[-1].lower() if "." in file.filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="File type not allowed")
    content = await file.read()

    style_extracted = None
    parsed_markdown = ""
    if "style" in type.lower() or file.filename.endswith(('.png', '.jpg', '.jpeg')):
        from server.core.harvester import harvest_style_from_image
        style_extracted = harvest_style_from_image(content, file.filename)
        with open(STYLE_BANK_DIR / f"{style_extracted['id']}.json", "w", encoding="utf-8") as sf:
            json.dump(style_extracted, sf, indent=2)
    else:
        parsed_data = file_parser.parse_pdf(content, file.filename, tier="prime")
        parsed_markdown = parsed_data.get("markdown", "")

    return {"status": "success", "parsed_markdown": parsed_markdown, "style_extracted": style_extracted}
