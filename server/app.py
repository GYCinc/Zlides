from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from server.core.state import VERSION
from server.routes.saved import router as saved_router
from server.routes.styles import router as styles_router
from server.routes.export import router as export_router
from server.routes.conversation import router as conversation_router
from server.routes.generation import router as generation_router

app = FastAPI(title="Zlides API", version=VERSION)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Router Registrations
app.include_router(generation_router)
app.include_router(saved_router)
app.include_router(styles_router)
app.include_router(export_router)
app.include_router(conversation_router)

# Mount the static Svelte compiled frontend
app.mount("/assets", StaticFiles(directory="dist/assets"), name="assets")

@app.get("/")
async def root():
    return FileResponse("dist/index.html")
