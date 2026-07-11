# Zlides

Generate HTML presentations, posters, worksheets, and reports by streaming prompts to a Z.AI agent. FastAPI backend, Svelte 5 frontend, CLI tool, and a one-shot API endpoint.

## Requirements

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) for Python packages
- [bun](https://bun.sh/) for frontend builds
- A `.env` file with your Z.AI API key:

```bash
echo 'Z_AI_API_KEY=your-key.secret' > .env
```

## Quick Start

```bash
./launch.sh
```

This loads `.env`, kills anything on port 2828, starts the server, and opens your browser. That's it.

## Building the Frontend

The frontend is a Svelte 5 app in `frontend_svelte/`. The compiled output lives in `public/`. You only need to rebuild if you change frontend code:

```bash
cd frontend_svelte
bun install        # first time only
bun run build      # outputs to ../public/
```

For live dev mode with hot reload:

```bash
cd frontend_svelte
bun run dev
```

## CLI Usage

The `zlides` CLI sends content to the local server's one-shot "printing press" endpoint. The server must be running (`./launch.sh`).

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
| `-s, --style` | Style pack name (see below) | `auto` |
| `-p, --pages` | Number of pages/slides | agent decides |
| `-F, --file` | Read content from a file | — |
| `-o, --output` | Save HTML to file instead of stdout | — |
| `--open` | Open result in browser after generation | — |

### Available Styles

`auto`, `gitenglish`, `clean`, `dark`, `minimal` (add your own in `style_bank/`)

## API Endpoints

### `POST /command` — Streaming generation (SSE)

The main endpoint used by the web UI. Streams thinking text and HTML chunks via Server-Sent Events.

```bash
curl -N -X POST http://localhost:2828/command \
  -H "Content-Type: application/json" \
  -d '{"message":"Create slides about the solar system","format":"slides","style":"dark"}'
```

### `POST /api/print` — One-shot generation (JSON)

No streaming, no conversation state. Returns complete HTML in a JSON response. This is what the CLI uses.

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

### Other Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Web UI |
| `GET` | `/styles` | List available style packs |
| `GET` | `/saved` | List recently generated slides |
| `POST` | `/upload` | Upload files (pdf, doc, images) to Z.AI |
| `GET` | `/preferences` | Get preferences file |
| `POST` | `/preferences` | Update preferences file |

## Formats

| Format | Output |
|--------|--------|
| `slides` | Multi-slide HTML presentation |
| `poster` | Single-page poster |
| `worksheet` | Printable worksheet |
| `report` | Structured report document |
| `rr` | Interactive RegenResource exercises |

## Styles

Styles are JSON files in `style_bank/`. Each defines colors, fonts, card style, and a `prompt_hint` that guides the AI's visual output. To create a custom style, add a new `.json` file to `style_bank/` and it'll be picked up automatically.

## Preferences

A `PREFERENCES.md` file at the project root is injected into every generation prompt. Edit it via the web UI (page icon in header) or directly. Use it to set persistent instructions like "always use British spelling" or "prefer bullet points over paragraphs."

## Running Tests

```bash
uv run pytest tests/
```

## Project Structure

```
zlides/
├── slide_server.py      # FastAPI app (entry point)
├── launch.sh            # Server launcher
├── zlides               # CLI tool
├── frontend_svelte/     # Svelte 5 frontend source
├── public/              # Compiled frontend (served by FastAPI)
├── style_bank/          # Style packs (JSON)
├── saved_slides/        # Generated HTML output (gitignored)
├── tests/               # Test suite
├── pyproject.toml       # Python deps (uv)
└── .env                 # API key (gitignored)
```

## Tech Stack

- **Backend:** FastAPI, uvicorn, httpx, zhipuai
- **Frontend:** Svelte 5, Tailwind CSS, svelte-virtual-chat, svelte-markdown
- **AI:** Z.AI GLM-4 agent API (`slides_glm_agent`)
- **Python:** managed with `uv`
- **Node:** managed with `bun`
