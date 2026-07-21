from fastapi import APIRouter, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel
import os
import json
import httpx
import time
import secrets
import uuid
import asyncio
from pathlib import Path
from server.core.state import (
    VERSION, Z_AI_API_KEY, ZAI_ENDPOINT, generate_token, STYLE_BANK_DIR,
    get_session_store, update_session_store, set_conversation_id, sanitize_html
)
from server.core.prompts import build_system_prompt, inject_print_css, FORMATS, load_format_metadata, load_role_metadata
from server.core.styles import load_style_bank, embed_style_fonts
from server.core.parser import FileParserPipeline
from server.core.generator import (
    ChatRequest, BatchRequest, BatchSlideGenerator, clean_agent_output,
    combine_tool_pages, extract_final_html, save_slide_to_file, wrap_in_slide_html
)

router = APIRouter()

file_parser = FileParserPipeline(api_key=Z_AI_API_KEY)
batch_generator = BatchSlideGenerator(api_key=Z_AI_API_KEY)

class CostEstimateRequest(BaseModel):
    prompt: str
    files_attached: int = 0
    format: str = "slides"
    page_count: int | None = None

def estimate_cost(input_tokens: int, output_tokens: int) -> float:
    cost_usd = (output_tokens / 1_000_000) * 0.007
    return round(cost_usd, 6)

def get_git_version():
    try:
        import subprocess
        r = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=os.path.dirname(os.path.abspath(__file__)),
        )
        return r.stdout.strip() if r.returncode == 0 else "unknown"
    except Exception:
        return "unknown"

@router.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "Zlides API",
        "version": VERSION,
        "git_commit": get_git_version(),
    }

@router.get("/version")
async def version():
    return {"version": VERSION, "git_commit": get_git_version()}

@router.get("/formats")
async def list_formats():
    """List available formats (dynamically loaded from formats/*.json)."""
    return load_format_metadata()

@router.get("/roles")
async def list_roles():
    """List available personality roles (dynamically loaded from roles/*.json)."""
    return load_role_metadata()

@router.post("/estimate-cost")
async def estimate_cost_endpoint(req: CostEstimateRequest):
    """Estimate token/cost for a generation request."""
    prompt_len = len(req.prompt)
    estimated_input_tokens = int(prompt_len * 0.7) + 8000 + (req.files_attached * 3000)
    
    if req.format == "poster":
        estimated_output_tokens = 2000
    elif req.format == "worksheet":
        estimated_output_tokens = 3000
    elif req.format == "report":
        estimated_output_tokens = 4000
    else:  # slides or auto
        estimated_output_tokens = (req.page_count or 5) * 1600

    cost_usd = estimate_cost(estimated_input_tokens, estimated_output_tokens)
    return {"cost_usd": cost_usd, "input_tokens": estimated_input_tokens, "output_tokens": estimated_output_tokens}

@router.post("/batch")
async def process_batch(req: BatchRequest):
    """Queue multiple generation requests"""
    topics = [{"prompt": p} for p in req.prompts]
    results = await batch_generator.generate_topic_batch(topics)
    return {"results": results, "status": "batch_completed"}

@router.post("/upload")
async def upload_file(file: UploadFile = File(...), type: str = Form("file")):
    """Enhanced upload endpoint to handle prime parsing and style extraction."""
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
    elif "reference" in type.lower() or "neutral" in type.lower():
        parsed_data = file_parser.parse_pdf(content, file.filename, tier="prime")
        parsed_markdown = parsed_data.get("markdown", "")
    else:
        parsed_data = file_parser.parse_pdf(content, file.filename, tier="prime")
        parsed_markdown = parsed_data.get("markdown", "")

    return {
        "status": "success",
        "parsed_markdown": parsed_markdown,
        "style_extracted": style_extracted
    }

@router.post("/command")
async def send_command(request: ChatRequest):
    effective_api_key = request.api_key or Z_AI_API_KEY
    effective_endpoint = request.base_url or ZAI_ENDPOINT

    headers = {
        "Authorization": f"Bearer {generate_token(effective_api_key)}",
        "Content-Type": "application/json",
        "Accept-Language": "en-US,en",
    }

    system_prompt = build_system_prompt(
        fmt=request.format or request.slide_type or "slides",
        style_id=request.style or request.theme or "auto",
        language=request.language,
        role_id=request.role or "balanced",
    )

    if request.page_count:
        page_instruction = f"\nCRITICAL: MUST create exactly {request.page_count} {'slides' if request.format == 'slides' else 'sections'}."
    else:
        page_instruction = ""

    user_text = request.message
    if request.system_prompt:
        user_text = f"{request.system_prompt}\n\n{user_text}"

    full_prompt = f"{system_prompt}{page_instruction}\n\nUSER REQUEST:\n{user_text}"
    messages = [{"role": "user", "content": [{"type": "text", "text": full_prompt}]}]
    
    session_data = await get_session_store()
    conversation_id = session_data.get("conversation_id")

    payload = {
        "agent_id": "slides_glm_agent",
        "stream": True,
        "messages": messages,
        "enable_thinking": True,
    }

    if request.web_search:
        payload["tools"] = [{"type": "web_search", "web_search": {"enable": True}}]

    if request.page_count:
        payload["max_pages"] = request.page_count
        
    payload["max_tokens"] = 120000
    payload["ctrl_step"] = 0.7

    is_edit_request = conversation_id and any(
        word in request.message.lower()
        for word in ["edit", "change", "modify", "update", "fix", "adjust", "reformat", "layout"]
    )

    payload["extra_body"] = {
        "cache_salt": secrets.token_urlsafe(32),
        "thinking": {
            "type": "disabled" if is_edit_request else "enabled",
            "clear_thinking": False,
        },
        "tool_stream": True,
    }
    payload["response_format"] = {"type": "json_object"}
    payload["requestId"] = str(uuid.uuid4())

    if conversation_id:
        payload["conversation_id"] = conversation_id

    # Queue style extraction parameters
    style_image_id = session_data.get("pending_style_image")
    if style_image_id:
        payload["file_ids"] = [style_image_id]
        await update_session_store({"pending_style_image": None})

    print(f"[API] Format: {request.format} | Style: {request.style} | Message: {request.message[:50]}...")

    async def generate():
        if effective_api_key == "mock" or not effective_api_key or effective_api_key == "key.secret" or effective_api_key.startswith("your_"):
            yield f"data: {json.dumps({'type': 'thinking', 'content': 'Offline Mock Mode: API Key missing or set to mock. Designing locally...'})}\n\n"
            await asyncio.sleep(0.3)
            yield f"data: {json.dumps({'type': 'thinking', 'content': 'Applying styling configs...'})}\n\n"
            await asyncio.sleep(0.3)
            
            style_id = request.style or request.theme or "auto"
            styles = load_style_bank()
            style_pack = styles.get(style_id, {})
            css = style_pack.get("css", {})
            bg = css.get("bg", "#131313")
            card_bg = css.get("card", "#1f1f1f")
            accent = css.get("accent", "#ff6600")
            text_color = css.get("text", "#ffffff")
            
            page_count = request.page_count or 4
            html_slides = []
            
            for i in range(1, page_count + 1):
                yield f"data: {json.dumps({'type': 'thinking', 'content': f'Generating slide {i} of {page_count}...'})}\n\n"
                await asyncio.sleep(0.4)
                
                slide_html = f"""<section class="slide" style="background: {bg}; color: {text_color}; padding: 60px; min-height: 100vh; display: flex; flex-direction: column; justify-content: center; box-sizing: border-box; font-family: system-ui, sans-serif; position: relative; border-bottom: 1px dashed rgba(255,255,255,0.1); page-break-after: always;">
    <div style="max-width: 900px; margin: 0 auto; width: 100%;">
        <header style="margin-bottom: 30px;">
            <span style="font-size: 10px; font-weight: bold; text-transform: uppercase; color: {accent}; letter-spacing: 2px;">Slide {i} of {page_count}</span>
            <h1 style="font-size: 40px; margin: 8px 0 0 0; color: {text_color}; font-weight: 800; line-height: 1.2;">Offline Presentation</h1>
        </header>
        <div style="display: grid; grid-template-columns: 1.2fr 1fr; gap: 40px; align-items: start;">
            <div style="background: {card_bg}; padding: 30px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.08); box-shadow: 0 10px 30px rgba(0,0,0,0.25);">
                <h3 style="font-size: 18px; margin: 0 0 15px 0; color: {accent};">Vibe: "{request.message[:40]}"</h3>
                <p style="font-size: 15px; line-height: 1.6; margin: 0; opacity: 0.95;">
                    This presentation was generated entirely offline using the built-in Mock Layout Engine because no Z.AI API key was configured.
                </p>
                <div style="margin-top: 25px; padding-top: 20px; border-t: 1px solid rgba(255,255,255,0.1); display: flex; align-items: center; gap: 10px;">
                    <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: {accent};"></span>
                    <span style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.7;">Format: {request.format or "slides"}</span>
                </div>
            </div>
            <div>
                <h4 style="font-size: 14px; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 15px 0; opacity: 0.7;">Highlights</h4>
                <ul style="margin: 0; padding-left: 20px; font-size: 14px; line-height: 2;">
                    <li>Interactive live editing works</li>
                    <li>PDF / PNG Export fully active</li>
                    <li>Cost Management tracked</li>
                    <li>Style pack colors applied</li>
                </ul>
            </div>
        </div>
    </div>
</section>"""
                html_slides.append(slide_html)
                yield f"data: {json.dumps({'type': 'slide_page', 'html': slide_html, 'position': [i]})}\n\n"
            
            combined_body = "\n".join(html_slides)
            final_html = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>{request.message[:45]}</title>
    <style>
        body {{ margin: 0; padding: 0; background: {bg}; }}
        @media print {{
            .slide {{ min-height: 100vh !important; height: 100vh !important; }}
        }}
    </style>
</head>
<body>
    {combined_body}
</body>
</html>"""
            final_html = sanitize_html(final_html)
            filepath = save_slide_to_file(final_html, request.message)
            filename = os.path.basename(filepath)
            
            yield f"data: {json.dumps({'type': 'final_html', 'html': final_html, 'filename': filename})}\n\n"
            return

        yield f"data: {json.dumps({'type': 'thinking', 'content': 'Contacting Z.AI and preparing generation...'})}\n\n"
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, read=None)) as client:
            async with client.stream("POST", effective_endpoint, json=payload, headers=headers) as response:
                if response.status_code != 200:
                    yield f"data: {json.dumps({'type': 'error', 'text': f'Z.AI API Error: {response.status_code}'})}\n\n"
                    return

                all_chunks = []
                answer_texts = []
                tool_html_pages = []
                last_valid_chunk = {}

                async for line in response.aiter_lines():
                    if not line.strip() or not line.startswith("data:"):
                        continue

                    line_data = line[5:].strip()
                    if line_data == "[DONE]":
                        continue

                    try:
                        chunk = json.loads(line_data)
                        if not isinstance(chunk, dict):
                            continue

                        all_chunks.append(chunk)

                        if chunk.get("conversation_id"):
                            await set_conversation_id(chunk["conversation_id"])

                        if chunk.get("status") == "failed":
                            error = chunk.get("error", {})
                            error_msg = error.get("message", "Z.AI generation failed")
                            yield f"data: {json.dumps({'type': 'error', 'text': error_msg})}\n\n"
                            return

                        choices = chunk.get("choices", [])
                        if not choices:
                            continue

                        messages = choices[0].get("messages", [])
                        if not messages:
                            continue

                        for msg in messages:
                            phase = msg.get("phase")
                            content_data = msg.get("content")
                            if isinstance(content_data, dict):
                                content_list = [content_data]
                            elif isinstance(content_data, list):
                                content_list = content_data
                            else:
                                continue

                            for content in content_list:
                                if content.get("type") == "text":
                                    text_val = content.get("text", "")
                                    if text_val:
                                        if phase == "thinking":
                                            yield f"data: {json.dumps({'type': 'thinking', 'content': text_val})}\n\n"
                                        else:
                                            answer_texts.append(text_val)
                                            yield f"data: {json.dumps({'type': 'answer', 'text': text_val})}\n\n"

                                elif content.get("type") == "object":
                                    obj_val = content.get("object", {})
                                    tool_name = obj_val.get("tool_name", "")
                                    output = obj_val.get("output", "")
                                    position = obj_val.get("position", [0])

                                    if output:
                                        cleaned_out = output.replace("\\n", "\n").replace('\\"', '"')
                                        
                                        # The API now sends deltas, but the frontend and combine_tool_pages expect accumulated strings.
                                        tool_key = (tool_name, tuple(position))
                                        if not hasattr(request, "_tool_accumulators"):
                                            request._tool_accumulators = {}
                                        request._tool_accumulators[tool_key] = request._tool_accumulators.get(tool_key, "") + cleaned_out
                                        accumulated_html = request._tool_accumulators[tool_key]

                                        tool_html_pages.append({"html": accumulated_html, "position": position, "tool_name": tool_name})
                                        
                                        event_type = "slide_page"
                                        if "replace" in tool_name or "update" in tool_name:
                                            event_type = "slide_replace"
                                        elif "remove" in tool_name or "delete" in tool_name:
                                            event_type = "slide_remove"
                                        elif "navigate" in tool_name or "show" in tool_name:
                                            event_type = "slide_navigate"

                                        yield f"data: {json.dumps({'type': event_type, 'html': accumulated_html, 'position': position, 'tool_name': tool_name})}\n\n"

                        last_valid_chunk = chunk

                    except Exception as ex:
                        print(f"[SSE Error] {ex}")

                # Final combined HTML construction
                slide_html = combine_tool_pages(tool_html_pages)
                if not slide_html:
                    slide_html = extract_final_html(last_valid_chunk)
                if not slide_html:
                    slide_html = clean_agent_output("\n".join(answer_texts))
                if not slide_html:
                    for chk in reversed(all_chunks):
                        extracted = extract_final_html(chk)
                        if extracted:
                            slide_html = extracted
                            break
                if not slide_html:
                    slide_html = wrap_in_slide_html("\n".join(answer_texts), request.message[:30])

                style_id = request.style or request.theme or "auto"
                if style_id and style_id != "auto":
                    styles = load_style_bank()
                    sp = styles.get(style_id)
                    if sp and sp.get("css"):
                        css_vars = "\n".join([f"      --zlides-{k}: {v};" for k, v in sp["css"].items()])
                        css_injection = f"\n<style>\n:root {{\n{css_vars}\n}}\n</style>\n"
                        if "</head>" in slide_html:
                            slide_html = slide_html.replace("</head>", f"{css_injection}</head>")
                        else:
                            slide_html = f"{css_injection}\n" + slide_html

                    slide_html = embed_style_fonts(slide_html, sp)

                slide_html = inject_print_css(slide_html, light=True)
                slide_html = sanitize_html(slide_html)

                filepath = save_slide_to_file(slide_html, request.message)
                filename = os.path.basename(filepath)

                yield f"data: {json.dumps({'type': 'final_html', 'html': slide_html, 'filename': filename})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")

@router.post("/api/print")
async def printing_press(request: ChatRequest):
    """One-shot 'printing press' — takes content, returns designed HTML."""
    effective_api_key = request.api_key or Z_AI_API_KEY
    effective_endpoint = request.base_url or ZAI_ENDPOINT

    headers = {
        "Authorization": f"Bearer {generate_token(effective_api_key)}",
        "Content-Type": "application/json",
        "Accept-Language": "en-US,en",
    }

    fmt = request.format or request.slide_type or "report"
    system_prompt = build_system_prompt(
        fmt=fmt,
        style_id=request.style or request.theme or "auto",
        language=request.language,
        role_id=request.role or "balanced",
    )

    one_shot = (
        "\n\nONE-SHOT MODE: You cannot ask questions or clarify. "
        "Take the content provided and design it as best you can. "
        "When in doubt about the content, preserve it as-is. "
        "Focus on layout, typography, and visual polish."
    )

    full_prompt = f"{system_prompt}{one_shot}\n\nCONTENT TO DESIGN:\n{request.message}"
    messages = [{"role": "user", "content": [{"type": "text", "text": full_prompt}]}]

    payload = {
        "agent_id": "slides_glm_agent",
        "stream": True,
        "messages": messages,
        "enable_thinking": False,
        "max_tokens": 120000,
        "ctrl_step": 0.7,
        "extra_body": {
            "cache_salt": secrets.token_urlsafe(32),
            "thinking": {"type": "disabled", "clear_thinking": True},
            "tool_stream": True,
        },
        "response_format": {"type": "json_object"},
        "requestId": str(uuid.uuid4()),
    }

    if request.page_count:
        payload["max_pages"] = request.page_count
        
    if effective_api_key == "mock" or not effective_api_key or effective_api_key == "key.secret" or effective_api_key.startswith("your_"):
        style_id = request.style or request.theme or "auto"
        styles = load_style_bank()
        style_pack = styles.get(style_id, {})
        css = style_pack.get("css", {})
        bg = css.get("bg", "#131313")
        card_bg = css.get("card", "#1f1f1f")
        accent = css.get("accent", "#ff6600")
        text_color = css.get("text", "#ffffff")
        
        page_count = request.page_count or 4
        html_slides = []
        for i in range(1, page_count + 1):
            slide_html = f"""<section class="slide" style="background: {bg}; color: {text_color}; padding: 60px; min-height: 100vh; display: flex; flex-direction: column; justify-content: center; box-sizing: border-box; font-family: system-ui, sans-serif; position: relative; border-bottom: 1px dashed rgba(255,255,255,0.1); page-break-after: always;">
    <div style="max-width: 900px; margin: 0 auto; width: 100%;">
        <header style="margin-bottom: 30px;">
            <span style="font-size: 10px; font-weight: bold; text-transform: uppercase; color: {accent}; letter-spacing: 2px;">Slide {i} of {page_count}</span>
            <h1 style="font-size: 40px; margin: 8px 0 0 0; color: {text_color}; font-weight: 800; line-height: 1.2;">Offline Presentation (Print)</h1>
        </header>
        <div style="background: {card_bg}; padding: 30px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.08);">
            <h3 style="font-size: 18px; margin: 0 0 15px 0; color: {accent};">Vibe: "{request.message[:40]}"</h3>
            <p style="font-size: 15px; line-height: 1.6; margin: 0; opacity: 0.9;">
                Printed offline using the built-in Mock Layout Engine because no Z.AI API key was configured.
            </p>
        </div>
    </div>
</section>"""
            html_slides.append(slide_html)
        
        combined_body = "\n".join(html_slides)
        final_html = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>{request.message[:45]}</title>
    <style>
        body {{ margin: 0; padding: 0; background: {bg}; }}
        @media print {{
            .slide {{ min-height: 100vh !important; height: 100vh !important; }}
        }}
    </style>
</head>
<body>
    {combined_body}
</body>
</html>"""
        final_html = sanitize_html(final_html)
        save_slide_to_file(final_html, request.message)
        return {"html": final_html, "status": "completed"}

    async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, read=None)) as client:
        async with client.stream("POST", effective_endpoint, json=payload, headers=headers) as response:
            if response.status_code != 200:
                raise HTTPException(status_code=response.status_code, detail=f"Z.AI API Error: {response.status_code}")

            all_chunks = []
            answer_texts = []
            tool_html_pages = []
            last_valid_chunk = {}

            async for line in response.aiter_lines():
                if not line.strip() or not line.startswith("data:"):
                    continue
                line_data = line[5:].strip()
                if line_data == "[DONE]":
                    continue

                try:
                    chunk = json.loads(line_data)
                    if not isinstance(chunk, dict):
                        continue
                    all_chunks.append(chunk)

                    choices = chunk.get("choices", [])
                    if not choices:
                        continue

                    messages = choices[0].get("messages", [])
                    if not messages:
                        continue

                    for msg in messages:
                        content_data = msg.get("content")
                        if isinstance(content_data, dict):
                            content_list = [content_data]
                        elif isinstance(content_data, list):
                            content_list = content_data
                        else:
                            continue

                        for content in content_list:
                            if content.get("type") == "text":
                                text_val = content.get("text", "")
                                if text_val:
                                    answer_texts.append(text_val)
                            elif content.get("type") == "object":
                                obj_val = content.get("object", {})
                                tool_name = obj_val.get("tool_name", "")
                                output = obj_val.get("output", "")
                                position = obj_val.get("position", [0])

                                if output:
                                    cleaned_out = output.replace("\\n", "\n").replace('\\"', '"')
                                    tool_html_pages.append({"html": cleaned_out, "position": position, "tool_name": tool_name})
                    last_valid_chunk = chunk
                except Exception:
                    pass

            slide_html = combine_tool_pages(tool_html_pages)
            if not slide_html:
                slide_html = extract_final_html(last_valid_chunk)
            if not slide_html:
                slide_html = clean_agent_output("\n".join(answer_texts))
            if not slide_html:
                for chk in reversed(all_chunks):
                    extracted = extract_final_html(chk)
                    if extracted:
                        slide_html = extracted
                        break
            if not slide_html:
                slide_html = wrap_in_slide_html("\n".join(answer_texts), request.message[:30])

            style_id = request.style or request.theme or "auto"
            if style_id and style_id != "auto":
                styles = load_style_bank()
                sp = styles.get(style_id)
                if sp and sp.get("css"):
                    css_vars = "\n".join([f"      --zlides-{k}: {v};" for k, v in sp["css"].items()])
                    css_injection = f"\n<style>\n:root {{\n{css_vars}\n}}\n</style>\n"
                    if "</head>" in slide_html:
                        slide_html = slide_html.replace("</head>", f"{css_injection}</head>")
                    else:
                        slide_html = f"{css_injection}\n" + slide_html

                slide_html = embed_style_fonts(slide_html, sp)

            slide_html = inject_print_css(slide_html, light=True)
            slide_html = sanitize_html(slide_html)

            filepath = save_slide_to_file(slide_html, request.message)
            title = request.message[:60]
            return {"html": slide_html, "filename": filepath, "title": title}
