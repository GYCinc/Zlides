# Zlides

Generate HTML presentations, posters, worksheets, and reports by streaming prompts to a Z.AI agent. Built with FastAPI, Svelte 5, and headless Chromium PDF rendering.

**Not just slides.** Zlides produces five distinct content formats — presentations, posters, worksheets, reports, and regenerative learning resources — all as self-contained, printable HTML files.

---

## Features

### Five Output Formats

| Format | What It Produces |
|--------|-----------------|
| **slides** | Multi-section HTML presentation with page breaks |
| **poster** | Single-page, visually dense, eye-catching |
| **worksheet** | Interactive exercises — fill-in-the-blank, matching, short answer |
| **report** | Professional document with headings, tables, and structured content |
| **rr** | Regenerative Resource — embeds re-generate buttons on exercises and vocabulary for teachers |

### Print-Friendly by Default

Every generated document includes universal `@media print` CSS:

- **PDF (Light)** — strips dark backgrounds, forces readable black-on-white text, avoids page breaks inside cards
- **PDF (Dark)** — preserves branded colors, adds only pagination rules
- **Browser printing** (Ctrl+P) — light mode is baked in automatically

PDF export runs server-side via Playwright + headless Chromium for deterministic, browser-independent output.

### Style Pack System

Styles are JSON files that guide the AI's visual output — colors, fonts, card styling, accent treatments, and print rules.

| Built-in Style | Look |
|----------------|------|
| `gitenglish` | Dark editorial — flat cards, burnt orange → burnt rose gradient accents, Raleway headings |
| `clean` | Light professional — white/blue, subtle borders |
| `dark` | Dark mode — near-black with purple accents |
| `minimal` | Pure typographic — black and white, Georgia serif body, no decoration |
| `auto` | No style — let the agent decide |

Add your own by dropping a JSON file in `style_bank/`. The built-in style editor (pencil icon next to the style dropdown) lets you create and edit packs visually.

### Streaming with Live Preview

The web UI streams responses via SSE — you watch the agent think, then build the HTML section by section. The preview iframe re-renders on every chunk.

### File Ingestion (Three Modes)

Upload PDFs, documents, or images and choose how to use them:

- **Remake Content** — Parse the file into markdown and generate slides/reports from it
- **Harvest Style** — Reverse-engineer a style pack from an uploaded image or PDF
- **Reference** — Attach the file as neutral context; write your own prompt

### Batch Generation

Type `/batch` followed by prompts separated by double newlines. The server queues them with a concurrency semaphore (max 3 parallel) and generates everything without timeouts.

### Inline Editing

Toggle edit mode to directly modify the rendered HTML in the preview iframe. Use **Apply Everywhere** to send your visual edits to the agent and replicate them across all slides.

---

## Quick Start

### Prerequisites

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) for Python packages
- [bun](https://bun.sh/) for frontend builds
- A Z.AI API key (format: `key.secret` — split on first dot for JWT auth)

### Setup

```bash
git clone https://github.com/LITAjm/Zlides.git
cd Zlides
echo 'Z_AI_API_KEY=your-key.secret' > .env
```

### Run

```bash
./launch.sh
```

This loads `.env`, kills anything on port 2828, starts the server, and opens your browser. The app runs at `http://localhost:2828`.

### One-time Setup for PDF Export

```bash
uv run playwright install chromium
```

---

## CLI Usage

The `zlides` CLI sends content to the local server's one-shot endpoint. The server must be running.

```bash
# Direct text
./zlides "Create slides about photosynthesis"

# From a file
./zlides -F notes.md -f report -s gitenglish -o output.html --open

# Piped from stdin
echo "Summary of WW2 battles" | ./zlides -f slides -s dark

# Piped from another command
cat lesson.md | ./zlides -f worksheet -p 3 -o lesson.html
```

### CLI Flags

| Flag | Description | Default |
|------|-------------|---------|
| `-f, --format` | `slides`, `poster`, `worksheet`, `report`, `rr` | `report` |
| `-s, --style` | Style pack name | `auto` |
| `-p, --pages` | Number of pages/slides | agent decides |
| `-F, --file` | Read content from a file | — |
| `-o, --output` | Save HTML to file instead of stdout | — |
| `--open` | Open result in browser after generation | — |

---

## API Reference

All endpoints are on `http://localhost:2828`. The server accepts JSON payloads unless noted.

### Generation

#### `POST /command` — Streaming (SSE)

Primary endpoint used by the web UI. Streams thinking text and HTML chunks via Server-Sent Events.

```bash
curl -N -X POST http://localhost:2828/command \
  -H "Content-Type: application/json" \
  -d '{"message":"Create slides about the solar system","format":"slides","style":"dark"}'
```

SSE event types: `thinking`, `answer`, `slide_page`, `slide_remove`, `slide_replace`, `slide_navigate`, `final_html`, `error`.

#### `POST /api/print` — One-shot (JSON)

No streaming, no conversation state. Returns complete HTML. This is what the CLI uses.

```bash
curl -X POST http://localhost:2828/api/print \
  -H "Content-Type: application/json" \
  -d '{"message":"Create a poster about water cycles","format":"poster","style":"gitenglish"}'
```

Response:

```json
{
  "html": "<!DOCTYPE html>...",
  "filename": "poster_2024-01-15_103022.html",
  "title": "Water Cycles Poster"
}
```

#### `POST /batch` — Batch Generation

Queue multiple prompts with concurrency-limited generation.

```bash
curl -X POST http://localhost:2828/batch \
  -H "Content-Type: application/json" \
  -d '{"prompts":["Slides about Mars","Slides about Venus","Slides about Jupiter"]}'
```

### Export

#### `POST /export/pdf` — HTML → PDF

Renders HTML to PDF via Playwright + headless Chromium.

```bash
curl -X POST http://localhost:2828/export/pdf \
  -H "Content-Type: application/json" \
  -d '{"html":"<html>...</html>","print_mode":"light"}' \
  --output slide.pdf
```

`print_mode`: `"light"` (default — white backgrounds, dark text) or `"branded"` (preserves original colors).

#### `POST /export/html` — Download HTML

Returns the full HTML document as JSON.

### Upload

#### `POST /upload` — File Ingestion

Accepts `multipart/form-data` with a `file` and `type` field.

```bash
curl -X POST http://localhost:2828/upload \
  -F "file=@lesson.pdf" \
  -F "type=content"
```

Modes: `content` (parse → slides), `style` (reverse-engineer style pack), `reference` (neutral context).

Supported: `pdf, doc, docx, xls, xlsx, ppt, pptx, png, jpg, jpeg, csv, txt, md`.

### Style Bank

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/styles` | List all style packs |
| `GET` | `/styles/{id}` | Get a full style pack |
| `POST` | `/styles/save` | Create or update a style pack |
| `DELETE` | `/styles/{id}` | Delete a style pack |

### Other Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check with version info |
| `GET` | `/saved` | List generated slides (newest first) |
| `GET` | `/saved/{filename}` | Serve a saved slide |
| `GET` | `/preferences` | Get preferences content |
| `POST` | `/preferences` | Update preferences |
| `GET` | `/formats` | List available formats |
| `POST` | `/estimate-cost` | Estimate generation cost in USD |

---

## Creating Custom Styles

Styles are JSON files in `style_bank/`. Here's the schema:

```json
{
  "id": "my-style",
  "name": "My Style",
  "preview_colors": ["#1a1a1a", "#ff6600"],
  "prompt_hint": "Describe the visual direction for the AI agent...",
  "css": {
    "bg": "#1a1a1a",
    "card": "#2a2a2a",
    "text": "#e0e0e0",
    "accent": "#ff6600",
    "border": "#444444"
  },
  "fonts": {
    "body": "system-ui, sans-serif",
    "heading": "'Inter', sans-serif"
  },
  "card_style": "flat",
  "print_css": "@media print { ... }"
}
```

**Key concept:** The `prompt_hint` is the styling engine. It's injected into the system prompt and the AI generates inline CSS based on your instructions. Be specific about the look you want — colors, border styles, accent treatments, shadows (or lack thereof).

You can also create styles visually using the built-in style editor in the web UI (click the pencil icon next to the style dropdown).

---

## Preferences

A `PREFERENCES.md` file at the project root is injected into every generation prompt. Edit it via the web UI (page icon in header) or directly.

Use it for persistent instructions:

```markdown
- Always use British spelling
- Prefer bullet points over paragraphs
- Use generous padding (at least 40px)
- Keep font sizes large and readable
```

---

## Building the Frontend

The frontend is a Svelte 5 app in `frontend_svelte/`. Compiled output lives in `dist/`. You only need to rebuild if you change frontend code:

```bash
cd frontend_svelte
bun install        # first time only
bun run build      # outputs to ../dist/
```

For live dev mode with hot reload:

```bash
cd frontend_svelte
bun run dev
```

---

## Running Tests

```bash
uv run pytest tests/
```

Tests cover PDF export validation (missing HTML, Playwright availability, output format). More tests welcome via PR.

---

## Project Structure

```
zlides/
├── slide_server.py       # FastAPI app — the real entry point
├── launch.sh             # Server launcher (sources .env, manages port)
├── zlides                # CLI tool (stdlib only, no deps)
├── frontend_svelte/      # Svelte 5 + Tailwind 4 frontend source
├── dist/                 # Compiled frontend (served by FastAPI)
├── style_bank/           # Style packs (JSON)
├── saved_slides/         # Generated HTML output (gitignored)
├── tests/                # Test suite
├── assets/               # Brand images, embedded fonts
├── pyproject.toml        # Python deps (uv)
└── .env                  # API key (gitignored)
```

---

## How It Works

```
User Prompt
    │
    ▼
FastAPI (/command) ──────► Z.AI Agent API (slides_glm_agent)
    │                         │
    │  SSE stream             │  Streams thinking + HTML tool calls
    │                         │
    ▼                         ▼
Frontend (Svelte 5)     HTML Extraction Pipeline:
    │                    1. Concatenate tool call outputs (sorted)
    │  Live preview      2. Decode escaped chars
    │  in iframe         3. Inject CSS variables + print CSS
    │                    4. Embed fonts as base64
    │                    5. Save to saved_slides/
    ▼
Final HTML (self-contained, offline-capable)
```

The agent outputs HTML via **tool calls** (`type: "object"`), not text. These arrive in small chunks (~100 chars) with position arrays. The server collects, sorts, concatenates, and decodes them into the final HTML document.

Generated files are fully self-contained — inline CSS, embedded fonts (base64 woff2), no external dependencies. They render correctly offline as standalone `.html` files.

---

## Tech Stack

- **Backend:** FastAPI, uvicorn, httpx, Pydantic, Playwright, PyJWT, zhipuai
- **Frontend:** Svelte 5, Tailwind CSS 4, Vite, svelte-virtual-chat, svelte-markdown
- **AI:** Z.AI agent API (`slides_glm_agent`)
- **Python:** managed with [uv](https://docs.astral.sh/uv/)
- **Node:** managed with [bun](https://bun.sh/)

---

## License

This project is open source. Feel free to fork, adapt, and build on it.

---

## Contributing

PRs welcome. Keep changes focused — read the existing code style before submitting.
