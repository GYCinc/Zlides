from io import BytesIO
from datetime import datetime

try:
    from playwright.async_api import async_playwright
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False

async def html_to_pdf(html: str, options: dict | None = None) -> bytes:
    """Convert an HTML string to a PDF using Playwright + headless Chromium."""
    if not PLAYWRIGHT_AVAILABLE:
        raise RuntimeError(
            "Playwright is not installed. Run: uv pip install playwright && playwright install chromium"
        )

    opts = options or {}
    format_size = opts.get("format", "A4")
    landscape = opts.get("landscape", False)
    margin = opts.get(
        "margin",
        {"top": "0", "right": "0", "bottom": "0", "left": "0"},
    )
    print_background = opts.get("print_background", True)

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        try:
            page = await browser.new_page()
            await page.set_content(html, wait_until="load")
            
            # The exact high-tech repair script from your html-to-pdf.js project
            repair_script = """
            () => {
              const body = document.body;
              const bodyStyle = getComputedStyle(body);
              
              // Chrome PDF cannot render background-clip:text; it makes headings blank.
              document.querySelectorAll('*').forEach(el => {
                const s = getComputedStyle(el);
                if (s.webkitBackgroundClip === 'text' || s.backgroundClip === 'text') {
                  el.style.backgroundImage = 'none';
                  el.style.webkitBackgroundClip = 'border-box';
                  el.style.backgroundClip = 'border-box';
                  el.style.webkitTextFillColor = 'currentColor';
                }
              });

              // The HTML sometimes declares page-break-inside: avoid on whole sections.
              // Override those containers so they can flow, but keep cards/rows intact.
              document.querySelectorAll(
                '.section, .summary, .items-grid, .vocab-list, .phrase-list, ' +
                '.grammar-list, .idiom-list, .takeaway-list, .self-study-section'
              ).forEach(el => {
                el.style.pageBreakInside = 'auto';
                el.style.breakInside = 'auto';
              });

              document.querySelectorAll(
                '.card, .item-card, .vocab-item, .phrase-item, .grammar-item, .idiom-item, ' +
                '.takeaway-item, .list-item, .note-item, .example, .item-example'
              ).forEach(el => {
                el.style.pageBreakInside = 'avoid';
                el.style.breakInside = 'avoid';
              });

              ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].forEach(sel => {
                document.querySelectorAll(sel).forEach(el => {
                  el.style.pageBreakAfter = 'avoid';
                  el.style.breakAfter = 'avoid';
                });
              });
            }
            """
            await page.evaluate(repair_script)

            pdf_bytes = await page.pdf(
                format=format_size,
                landscape=landscape,
                margin=margin,
                print_background=print_background,
            )
            return pdf_bytes
        finally:
            await browser.close()
