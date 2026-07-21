# Stage 1: Build the Svelte frontend
FROM oven/bun:1 AS frontend-builder
WORKDIR /app
# Copy only the package files first for caching
COPY frontend_svelte/package.json frontend_svelte/bun.lockb* ./frontend_svelte/
WORKDIR /app/frontend_svelte
RUN bun install
# Copy the rest of the frontend source
COPY frontend_svelte/ ./
# Build the frontend -> this outputs to /app/public
RUN bun run build


# Stage 2: Build the Python backend and serve
FROM ghcr.io/astral-sh/uv:python3.11-bookworm-slim
WORKDIR /app

# Install system dependencies (Playwright needs system libs)
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget gnupg \
    && rm -rf /var/lib/apt/lists/*

# Copy uv project files
COPY pyproject.toml uv.lock ./
# Install python dependencies via uv
RUN uv sync --frozen --no-dev

# Copy the rest of the application code
COPY . .
# Copy compiled frontend from Stage 1
COPY --from=frontend-builder /app/public /app/public

# Install Playwright browsers (for PDF export)
RUN uv run playwright install chromium --with-deps

# Create saved_slides directory so it exists
RUN mkdir -p saved_slides

# Start the FastAPI server on Railway's dynamic $PORT
CMD ["sh", "-c", "uv run uvicorn slide_server:app --host 0.0.0.0 --port ${PORT:-2828}"]
