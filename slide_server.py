import socket
import os
import uvicorn
from server.app import app


if __name__ == "__main__":
    # Local binding only
    host = os.environ.get("HOST", "127.0.0.1")

    from server.core.state import clear_session
    clear_session()
    print(f"Cleared session state. Binding Zlides server to {host}...")

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, 2828))
    sock.close()

    uvicorn.run("slide_server:app", host=host, port=2828)
