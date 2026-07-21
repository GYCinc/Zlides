from fastapi import APIRouter, HTTPException
import httpx
from server.core.state import Z_AI_API_KEY, generate_token, update_session_store, get_session_store, set_conversation_id, PREFERENCES_FILE
from server.core.prompts import load_preferences
from server.core.generator import ChatRequest

router = APIRouter()

@router.get("/preferences")
async def get_preferences():
    content = load_preferences()
    if not content:
        content = "# My Preferences\n\n<!-- Write your style/layout/content preferences here. These get injected into every generation. -->\n<!-- Example: Always use sans-serif fonts. Keep paragraphs short. Use generous padding. -->"
    return {"content": content}

@router.post("/preferences")
async def save_preferences(request: dict):
    content = request.get("content", "")
    PREFERENCES_FILE.write_text(content, encoding="utf-8")
    return {"saved": True}

@router.post("/style")
async def ingest_style(request: dict):
    style_data = request.get("style", {})
    await update_session_store({"pending_style": style_data})
    return {"status": "style_queued", "style": style_data}

@router.post("/pointer")
async def ingest_pointer(request: dict):
    pointer_data = request.get("pointer", {})
    await update_session_store({"pending_pointer": pointer_data})
    return {"status": "pointer_queued", "pointer": pointer_data}

@router.post("/async")
async def async_generate(request: ChatRequest):
    if not Z_AI_API_KEY:
        raise HTTPException(status_code=401, detail="Z_AI_API_KEY not configured")

    token = generate_token(Z_AI_API_KEY, exp_seconds=3600)
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    url = "https://api.z.ai/v1/agents/async-result"

    payload = {
        "agent_id": "slides_glm_agent",
        "custom_variables": {
            "include_pdf": False
        }
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            response = await client.post(url, json=payload, headers=headers)
            if response.status_code != 200:
                raise HTTPException(status_code=response.status_code, detail=response.text)
            return response.json()
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

@router.post("/export")
async def export_conversation(request: dict):
    if not Z_AI_API_KEY:
        raise HTTPException(status_code=401, detail="Z_AI_API_KEY not configured")

    conversation_id = request.get("conversation_id")
    if not conversation_id:
        raise HTTPException(status_code=400, detail="conversation_id required")

    include_pdf = request.get("include_pdf", True)
    include_html = request.get("include_html", False)

    token = generate_token(Z_AI_API_KEY, exp_seconds=3600)
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    url = "https://api.z.ai/v1/agents/conversation"

    payload = {
        "agent_id": "slides_glm_agent",
        "conversation_id": conversation_id,
        "custom_variables": {
            "include_pdf": include_pdf,
            "include_html": include_html
        }
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            response = await client.post(url, json=payload, headers=headers)
            if response.status_code != 200:
                raise HTTPException(status_code=response.status_code, detail=response.text)

            data = response.json()
            return {"status": "success", "data": data}
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

@router.get("/conversation/{conversation_id}")
async def get_conversation_history(conversation_id: str):
    if not Z_AI_API_KEY:
        raise HTTPException(status_code=401, detail="Z_AI_API_KEY not configured")

    token = generate_token(Z_AI_API_KEY, exp_seconds=3600)
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    url = "https://api.z.ai/v1/agents/conversation"

    payload = {
        "agent_id": "slides_glm_agent",
        "conversation_id": conversation_id,
        "custom_variables": {
            "include_pdf": True
        }
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            response = await client.post(url, json=payload, headers=headers)
            if response.status_code != 200:
                raise HTTPException(status_code=response.status_code, detail=response.text)
            return response.json()
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

@router.post("/conversation/clear")
async def clear_conversation():
    """Clear conversation history to start a fresh token context session."""
    await set_conversation_id(None)
    await update_session_store({
        "pending_style": None,
        "pending_pointer": None,
        "pending_style_image": None
    })
    return {"status": "cleared"}
