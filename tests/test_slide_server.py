import pytest
from fastapi.testclient import TestClient
from slide_server import app, PLAYWRIGHT_AVAILABLE

client = TestClient(app)


SAMPLE_HTML = """<!DOCTYPE html>
<html>
<head>
    <style>
        @page { size: A4 landscape; margin: 0; }
        body { font-family: sans-serif; margin: 40px; }
        .slide { page-break-after: always; }
    </style>
</head>
<body>
    <div class="slide"><h1>Slide 1</h1></div>
    <div class="slide"><h1>Slide 2</h1></div>
</body>
</html>
"""


def test_export_pdf_missing_html():
    response = client.post("/export/pdf", json={"html": ""})
    assert response.status_code == 400
    assert "No HTML provided" in response.text


@pytest.mark.skipif(not PLAYWRIGHT_AVAILABLE, reason="Playwright not installed")
def test_export_pdf_generates_pdf():
    response = client.post("/export/pdf", json={"html": SAMPLE_HTML})
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.content.startswith(b"%PDF-")
    assert len(response.content) > 1000


def test_export_pdf_without_playwright_returns_503(monkeypatch):
    # Force the availability flag to False so the endpoint returns a 503.
    monkeypatch.setattr("server.core.export.PLAYWRIGHT_AVAILABLE", False)
    response = client.post("/export/pdf", json={"html": SAMPLE_HTML})
    assert response.status_code == 503
    assert "Playwright is not installed" in response.text


def test_generate_token_signature():
    from slide_server import generate_token
    # Test that it works with default exp_seconds
    token_default = generate_token("testkey.testsecret")
    assert token_default is not None

    # Test that it accepts exp_seconds as keyword argument
    token_custom = generate_token("testkey.testsecret", exp_seconds=3600)
    assert token_custom is not None


def test_sanitize_html():
    from slide_server import sanitize_html
    dirty_html = (
        "<html><head><script>alert('xss')</script></head>"
        "<body><button onclick=\"doSomething()\" onload=bad() class=\"btn\">Click</button></body></html>"
    )
    clean = sanitize_html(dirty_html)
    assert "<script>" not in clean
    assert "onclick" not in clean
    assert "onload" not in clean
    assert "class=\"btn\"" in clean

