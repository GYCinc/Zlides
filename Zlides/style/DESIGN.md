---
version: alpha
name: gitEnglish
description: Dark engineering-spec design system for English-learning worksheets, guides and decks. Near-black canvas, one orange brand accent, amber and teal semantics, Fraunces display over Inter body.
colors:
  bg: "#0f1112"
  surface: "#16181a"
  surface-elevated: "#1e2124"
  line: "#2e3236"
  line-strong: "#373b40"
  text-heading: "#ffffff"
  text: "#e5e7eb"
  text-body: "#cfd3d8"
  muted: "#9ca3af"
  faint: "#6b7280"
  brand: "#ff6b35"
  brand-deep: "#7e1500"
  amber: "#f0b23e"
  teal: "#4fb3a9"
  ok: "#10b981"
  err: "#f43f5e"
  c-vocab: "#447F9F"
  c-phrasal: "#3B8484"
  c-colloc: "#DE6E55"
  c-grammar: "#B06D29"
  c-idioms: "#62193D"
  c-focus: "#DCE62C"
  c-practice: "#B98CF0"
  c-selfstudy: "#6FC3DF"
typography:
  h1:
    fontFamily: Fraunces
    fontSize: 46px
    fontWeight: 560
    lineHeight: 1.2
    letterSpacing: -0.01em
  h2:
    fontFamily: Raleway
    fontSize: 22px
    fontWeight: 800
    lineHeight: 1.3
    letterSpacing: -0.01em
  h3:
    fontFamily: Raleway
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.35
  body-md:
    fontFamily: Inter
    fontSize: 15.5px
    fontWeight: 400
    lineHeight: 1.6
  body-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.55
  label-caps:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: 0.03em
rounded:
  none: 0px
  sm: 3px
  md: 6px
  lg: 12px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 40px
---

## Overview
Dark engineering-spec surface for adult English learners. Reads like a precision instrument panel: near-black canvas, hairline borders, one loud orange accent that only ever points at the current thing. Dense, adult, print-adjacent typography — never playful, never childish.

## Colors
- **Canvas (#0f1112):** the page under everything.
- **Surface (#16181a):** cards, panels, sheets that sit on the canvas.
- **Elevated (#1e2124):** hover states, popovers, inputs inside cards.
- **Line (#2e3236):** card perimeters and structural dividers. **Line-strong (#373b40):** interactive borders, table header rules.
- **Brand (#ff6b35):** the only accent — the current focus, the indicator rail. Nothing else competes.
- **Amber (#f0b23e):** warning / "common mistake". **Teal (#4fb3a9):** alternative / "another way". **Green (#10b981):** correct. **Red (#f43f5e):** incorrect.
- **Text:** white headings, #e5e7eb high-emphasis body, #cfd3d8 standard body, #9ca3af metadata, #6b7280 footers and disabled states.
- Section domain hues (slate blue, deep sea, terracotta, ochre, plum, lichen, soft violet, cyan) are scoped per section — never applied globally.

## Typography
- **Display (Fraunces):** h1 only. Editorial weight against flat black.
- **Head (Raleway, 800):** h2 and h3. Tight, engineered, no softness.
- **Body (Inter):** everything else, 15.5px with 1.6 line height.
- **Labels:** Inter 600 at 13px, letter-spacing 0.03em, uppercase where it reads as a tag.
- Mono only for short utility labels. Never for a sentence.

## Layout
Fluid single column, full width, sections separated by a hairline and 24px of air. Cards stack with 16px gaps. Two-column card grids only where content is naturally parallel.

## Elevation & Depth
Depth comes from tonal layering, not shadows. Canvas near-black, cards one step lighter, elevated surfaces one step above that. Shadows are rare and shallow — `0 2px 8px rgba(0,0,0,0.25)` is the ceiling. Borders do the structural work.

## Shapes
Small engineered radii: 3px on cards, chips and badges, 6px on inputs, 12px on large panels. Nothing is pill-shaped except tags. The 3px brand rail on a card's leading edge is the signature shape.

## Do's and Don'ts
- Do drive every section accent from `--accent` inherited on the section element; don't hardcode a hex per rule.
- Do keep body at 15.5px and labels at 13px or larger.
- Do use brand orange for exactly one thing per screen — the current focus.
- Don't introduce a hue that is not in this file.
- Don't mix more than two typefaces in one document.
- Don't use drop shadows heavier than 8px blur.
