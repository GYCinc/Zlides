import asyncio
from server.core.export import html_to_pdf

html_content = """
<!DOCTYPE html>
<html>
<head>
<style>
  .card {
    border: 1px solid black;
    margin-bottom: 20px;
    padding: 20px;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  section {
    margin-bottom: 30px;
    page-break-inside: avoid;
    break-inside: avoid;
  }
</style>
</head>
<body>
  <h1>Test Report</h1>
""" + "".join([
f"""
  <section>
    <h2>Section {i}</h2>
    <div class="grid">
      <div class="card">Card A<br><br><br>Line</div>
      <div class="card">Card B<br><br><br>Line</div>
    </div>
  </section>
""" for i in range(20)
]) + """
</body>
</html>
"""

async def run():
    # Test without Zlides print css
    pdf1 = await html_to_pdf(html_content, {"margin": {"top": "1cm", "right": "1cm", "bottom": "1cm", "left": "1cm"}})
    with open("test1.pdf", "wb") as f:
        f.write(pdf1)
    
    # Test WITH Zlides print light css
    from server.core.prompts import inject_print_css
    html_with_css = inject_print_css(html_content, light=True)
    pdf2 = await html_to_pdf(html_with_css, {"margin": {"top": "1cm", "right": "1cm", "bottom": "1cm", "left": "1cm"}})
    with open("test2.pdf", "wb") as f:
        f.write(pdf2)

asyncio.run(run())
