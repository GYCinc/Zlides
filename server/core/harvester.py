import io
import math
import time
from PIL import Image

def rgb_to_hex(r: int, g: int, b: int) -> str:
    return f"#{r:02x}{g:02x}{b:02x}"

def get_lightness(r: int, g: int, b: int) -> float:
    # Standard relative luminance formula
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0

def get_contrast_ratio(c1: tuple[int,int,int], c2: tuple[int,int,int]) -> float:
    l1 = get_lightness(*c1) + 0.05
    l2 = get_lightness(*c2) + 0.05
    return max(l1, l2) / min(l1, l2)

def color_distance(c1: tuple[int,int,int], c2: tuple[int,int,int]) -> float:
    # 3D Euclidean distance in RGB space
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(c1, c2)))

def harvest_style_from_image(image_bytes: bytes, filename: str) -> dict:
    """Harvest real color styling options from reference images using Pillow pixel analysis."""
    try:
        img = Image.open(io.BytesIO(image_bytes))
        # Convert to RGB if not already
        if img.mode != 'RGB':
            img = img.convert('RGB')
        
        # Resize to small dimension for fast processing and color grouping
        img_small = img.resize((100, 100))
        
        # Count color frequencies
        colors_dict = {}
        for x in range(img_small.width):
            for y in range(img_small.height):
                color = img_small.getpixel((x, y))
                colors_dict[color] = colors_dict.get(color, 0) + 1
        
        # Sort colors by frequency
        sorted_colors = sorted(colors_dict.items(), key=lambda item: item[1], reverse=True)
        
        # Find dominant background color (most common color)
        bg_rgb = sorted_colors[0][0]
        bg_hex = rgb_to_hex(*bg_rgb)
        is_dark = get_lightness(*bg_rgb) < 0.5
        
        # Filter other colors to find candidates
        # Find text candidate: must have high contrast with background
        text_rgb = None
        for color, _ in sorted_colors[1:]:
            if get_contrast_ratio(bg_rgb, color) > 4.5:
                text_rgb = color
                break
        
        # Fallback text if contrast requirement not met
        if not text_rgb:
            text_rgb = (240, 240, 240) if is_dark else (30, 30, 30)
        text_hex = rgb_to_hex(*text_rgb)
        
        # Find card candidate: similar hue to background but slightly lighter/darker
        card_rgb = None
        for color, _ in sorted_colors[1:]:
            dist = color_distance(bg_rgb, color)
            # Find a tonal color that is distinct but close
            if 15 < dist < 80:
                card_rgb = color
                break
                
        if not card_rgb:
            # Generate a procedural card color (tonal shift)
            factor = 1.15 if is_dark else 0.88
            card_rgb = tuple(min(255, max(0, int(c * factor))) for c in bg_rgb)
        card_hex = rgb_to_hex(*card_rgb)

        # Find accent candidate: distinct hue/saturation, colorful
        accent_rgb = None
        for color, _ in sorted_colors[1:]:
            # Check saturation (variance between RGB channels)
            avg = sum(color) / 3
            variance = sum((c - avg) ** 2 for c in color) / 3
            if variance > 300: # Decently colorful
                # Check distance from bg and text to ensure visibility
                if color_distance(bg_rgb, color) > 80 and get_contrast_ratio(bg_rgb, color) > 3.0:
                    accent_rgb = color
                    break
        
        if not accent_rgb:
            # Fallback to high contrast primary color
            accent_rgb = (255, 102, 0) if is_dark else (37, 99, 235)
        accent_hex = rgb_to_hex(*accent_rgb)

        # Generate support colors
        text_sec_rgb = tuple(int((t + b) / 2) for t, b in zip(text_rgb, bg_rgb))
        text_sec_hex = rgb_to_hex(*text_sec_rgb)
        
        border_rgb = tuple(int((c + b) / 2) for c, b in zip(card_rgb, bg_rgb))
        border_hex = rgb_to_hex(*border_rgb)
        
        # Build prompt hint
        theme_type = "dark" if is_dark else "light"
        prompt_hint = (
            f"Use a clean, premium {theme_type} visual theme inspired by {filename}. "
            f"Set background to {bg_hex}, cards and content panels to {card_hex}, and main text to {text_hex}. "
            f"Apply the accent color {accent_hex} to highlights, callout markers, and focus elements. "
            f"Ensure clean layout, high contrast, and structural borders of {border_hex}."
        )

        return {
            "id": f"harvested_{int(time.time())}",
            "name": f"Palette from {filename}",
            "preview_colors": [bg_hex, card_hex, accent_hex, text_hex, border_hex],
            "prompt_hint": prompt_hint,
            "css": {
                "bg": bg_hex,
                "card": card_hex,
                "text": text_hex,
                "text_secondary": text_sec_hex,
                "accent": accent_hex,
                "border": border_hex,
                "success": "#16a34a",
                "danger": "#dc2626"
            },
            "fonts": {
                "body": "system-ui, -apple-system, sans-serif",
                "heading": "system-ui, sans-serif"
            },
            "card_style": "flat",
            "print_css": f"@media print {{ body {{ background: #fff !important; color: #111 !important; }} .card {{ border: 1px solid {border_hex} !important; background: #fafafa !important; }} }}"
        }
    except Exception as e:
        print(f"[Harvester Error] Failed to harvest style: {e}")
        # Return fallback clean style
        return {
            "id": f"harvested_fallback_{int(time.time())}",
            "name": f"Clean (Harvest Fallback)",
            "preview_colors": ["#f8f9fa", "#ffffff", "#2563eb", "#1e293b", "#e2e8f0"],
            "prompt_hint": "Use a clean light theme with background #f8f9fa, white cards, and primary blue accents.",
            "css": {
                "bg": "#f8f9fa",
                "card": "#ffffff",
                "text": "#1e293b",
                "text_secondary": "#64748b",
                "accent": "#2563eb",
                "border": "#e2e8f0",
                "success": "#16a34a",
                "danger": "#dc2626"
            }
        }
