#!/bin/bash

# Zlides Launcher (Pure Client-Side SSE Architecture)
PORT=2727

clear
echo "Starting Zlides GUI..."
echo ""

# Load env files (.secrets.env is canonical — ZAI_API_KEY / Z_AI_API_KEY)
if [ -f /home/hayron/.secrets.env ]; then
    set -a
    source /home/hayron/.secrets.env
    set +a
fi
if [ -f .env ]; then
    set -a
    source .env
    set +a
fi
# Accept either ZAI_API_KEY (secrets) or Z_AI_API_KEY
if [ -z "$Z_AI_API_KEY" ] && [ -n "$ZAI_API_KEY" ]; then
    export Z_AI_API_KEY="$ZAI_API_KEY"
fi

# ── Kill anything on our port ──────────────────────────────────────────────
echo "Cleaning up old processes on port $PORT..."
pids=$(lsof -ti:"$PORT" 2>/dev/null)
if [ -n "$pids" ]; then
    echo "  Killing processes on port $PORT: $pids"
    echo "$pids" | xargs kill -9 2>/dev/null || true
    sleep 1
fi

vite_pids=$(lsof -ti:2727 2>/dev/null || true)
if [ -n "$vite_pids" ]; then
    echo "  Killing vite on port 2727: $vite_pids"
    echo "$vite_pids" | xargs kill -9 2>/dev/null || true
    sleep 1
fi

if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "Error: Port $PORT still in use after cleanup!"
    exit 1
fi

# ── Trap cleanup ───────────────────────────────────────────────────────────
FRONTEND_PID=""

cleanup() {
    echo ""
    echo "Shutting down Zlides..."
    [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null
    sleep 1
    [ -n "$FRONTEND_PID" ] && kill -9 "$FRONTEND_PID" 2>/dev/null
    exit 0
}
trap cleanup INT TERM EXIT

# ── Start Vite GUI on port 2727 ────────────────────────────────────────────
echo "Starting Zlides Vite GUI on port $PORT..."
cd frontend_svelte
export PATH="$HOME/.bun/bin:$PATH"

if command -v bun >/dev/null 2>&1; then
    bun run dev --port $PORT --host 0.0.0.0 2>&1 &
else
    npm run dev -- --port $PORT --host 0.0.0.0 2>&1 &
fi
FRONTEND_PID=$!
cd ..

sleep 2
if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
    echo "Error: Frontend failed to start!"
    exit 1
fi

echo ""
echo "Zlides GUI running at http://localhost:$PORT"
echo "Press Ctrl+C to stop"
echo ""

# Auto-open browser
sleep 1
xdg-open "http://localhost:$PORT" 2>/dev/null &

wait "$FRONTEND_PID"
