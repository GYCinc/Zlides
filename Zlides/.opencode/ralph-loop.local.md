---
active: true
iteration: 2
maxIterations: 100
---

Fix the four frontend features in Zlides (frontend_svelte/src/App.svelte), using the pre-built packages exactly as they are meant to be used:
1. AI CHAT — proper streaming chat view that keeps up and never leaves the viewport (sticky bottom autoscroll)
2. CHAIN OF THOUGHT — render the agent's thinking stream using the installed ai-elements Reasoning components
3. LIVE PREVIEW — render slide_page events into the iframe as they arrive so pages visibly build
4. STREAMDOWN/SMOOTH RENDERING — use streamdown-svelte for the streaming markdown instead of hand-rolled parsing

Backend is DONE (slide_page/thinking/answer/usage events verified streaming over SSE). Do NOT touch slide_server.py, do NOT reset the running server on port 2828.

Verify with npx vite build in frontend_svelte until it passes clean.
