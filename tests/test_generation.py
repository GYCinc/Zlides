"""Pipeline tests — lock the behavior of the generation core against the
official Z.AI API contract (docs.z.ai/api-reference/agents/agent.md)."""

from server.core.generator import (
    assemble_html_by_position,
    extract_messages_from_chunk,
    save_generated_html,
    wrap_in_html,
)
from server.routes.generation import (
    _is_edit_request,
)


# ── Edit detection: convert continues the conversation ───────────────────────
def test_edit_keywords_include_convert():
    assert _is_edit_request("Now using all the same content. Convert it into a worksheet.")
    assert _is_edit_request("edit the layout")
    assert not _is_edit_request("make a brand new poster about the ocean")


# ── Chunk message extraction: live shape is choices[].messages ───────────────
def test_extract_messages_plural_live_shape():
    """Live-proven stream chunk: choices[].messages (array)."""
    chunk = {
        "id": "x", "agent_id": "slides_glm_agent", "conversation_id": "c1",
        "choices": [{"index": 0, "messages": [
            {"role": "assistant", "phase": "thinking", "content": [{"type": "text", "text": "planning"}]},
            {"role": "assistant", "phase": "tool", "content": [{"type": "object", "object": {"tool_name": "insert_page", "output": "<h1>x</h1>"}}]},
        ]}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }
    msgs = extract_messages_from_chunk(chunk)
    assert len(msgs) == 2
    assert msgs[0]["phase"] == "thinking"
    assert msgs[1]["content"][0]["object"]["tool_name"] == "insert_page"


def test_extract_messages_official_message_key():
    chunk = {"choices": [{"message": [{"role": "assistant", "phase": "answer", "content": []}]}]}
    msgs = extract_messages_from_chunk(chunk)
    assert len(msgs) == 1 and msgs[0]["phase"] == "answer"


def test_extract_messages_empty_chunk():
    assert extract_messages_from_chunk({}) == []
    assert extract_messages_from_chunk({"choices": []}) == []


# ── Tool output assembly: official tool contract (tool_name, output, position)
def test_assemble_html_by_position_sorts_and_concats():
    acc = {(2,): "<section>B</section>", (1,): "<section>A</section>"}
    assert assemble_html_by_position(acc) == "<section>A</section><section>B</section>"


def test_assemble_html_by_position_decodes_escapes():
    acc = {(1,): '<h1>Hi \\"there\\"</h1>\\n<p>x</p>'}
    assert assemble_html_by_position(acc) == '<h1>Hi "there"</h1>\n<p>x</p>'


def test_assemble_html_by_position_empty():
    assert assemble_html_by_position({}) == ""


# ── Last-resort wrapper ──────────────────────────────────────────────────────
def test_wrap_in_html_passthrough_for_existing_html():
    html = "<div>already html</div>"
    assert wrap_in_html(html) == html


def test_wrap_in_html_converts_markdown():
    out = wrap_in_html("# Title\n\nSome text.", title="T")
    assert "<h1>Title</h1>" in out
    assert "Some text." in out
    assert "T" in out


# ── Saved file naming: neutral zlides_ prefix ────────────────────────────────
def test_save_generated_html_filename_prefix(tmp_path, monkeypatch):
    monkeypatch.setattr("server.core.generator.SAVED_SLIDES_DIR", tmp_path)
    path = save_generated_html("<h1>hi</h1>", "lesson notes")
    assert path.startswith(str(tmp_path / "zlides_"))
    assert path.endswith(".html")
