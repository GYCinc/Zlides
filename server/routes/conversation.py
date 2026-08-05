from fastapi import APIRouter
from server.core.state import set_conversation_id, PREFERENCES_FILE
from server.core.prompts import load_preferences

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


@router.post("/conversation/clear")
async def clear_conversation():
    """Clear conversation history to start a fresh token context session."""
    await set_conversation_id(None)
    return {"status": "cleared"}
