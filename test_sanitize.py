from server.core.state import sanitize_html
with open('sample.html', 'w') as f:
    f.write(sanitize_html("<body>\n    <section class='slide'>Hello</section>\n</body>"))
print(sanitize_html("<body>\n    <section class='slide'>Hello</section>\n</body>"))
