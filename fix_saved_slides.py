import os
import glob

directory = "/home/hayron/MyProjects/ZZZlides/saved_slides"
files = glob.glob(os.path.join(directory, "*.html"))

bad_css_1 = "overflow: visible !important;"
bad_css_2 = "float: none !important;"
bad_css_3 = "max-height: none !important;"
bad_css_4 = "@page { margin: 0; size: landscape; }"

fixed_count = 0

for file_path in files:
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()
    
    modified = False
    
    if bad_css_1 in content:
        content = content.replace(bad_css_1, "")
        modified = True
    if bad_css_2 in content:
        content = content.replace(bad_css_2, "")
        modified = True
    if bad_css_3 in content:
        content = content.replace(bad_css_3, "")
        modified = True
    if bad_css_4 in content:
        content = content.replace(bad_css_4, "")
        modified = True
        
    if modified:
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)
        fixed_count += 1

print(f"Fixed {fixed_count} existing HTML files in saved_slides.")
