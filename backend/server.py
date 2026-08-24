import json
import http.server
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from google import genai
from google.genai import types

from .prompts import BASE_SYSTEM_PROMPT


BASE_DIR = Path(__file__).resolve().parents[1]
LIVE_MODEL = "gemini-3.1-flash-live-preview"


def load_env_file():
    env_path = BASE_DIR / ".env"
    if not env_path.exists():
        return

    with env_path.open("r", encoding="utf-8") as env_file:
        for line in env_file:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip())


load_env_file()

API_KEY = os.environ.get("GEMINI_API_KEY", "")
HOST = os.environ.get("HOST", "0.0.0.0")
try:
    PORT = int(os.environ.get("PORT", 3000))
except ValueError:
    PORT = 3000

FRONTEND_ORIGINS = {
    origin.strip()
    for origin in os.environ.get(
        "FRONTEND_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
}

if not API_KEY:
    print("WARNING: GEMINI_API_KEY is not set in the environment or .env file.")

client = genai.Client(api_key=API_KEY) if API_KEY else None


def create_live_token():
    if not client:
        raise ValueError("Gemini client is not configured with an API key.")

    now = datetime.now(timezone.utc)
    token = client.auth_tokens.create(
        config=types.CreateAuthTokenConfig(
            uses=1,
            expire_time=now + timedelta(minutes=30),
            new_session_expire_time=now + timedelta(minutes=2),
        )
    )

    token_name = getattr(token, "name", None)
    if not token_name:
        raise RuntimeError("Gemini did not return a Live API token.")

    return {
        "token": token_name,
        "model": LIVE_MODEL,
        "system_prompt": BASE_SYSTEM_PROMPT,
    }


class UniApiHandler(http.server.BaseHTTPRequestHandler):
    """Expose the backend API without serving frontend files."""

    def _set_cors_headers(self):
        origin = self.headers.get("Origin")
        if origin in FRONTEND_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._set_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_OPTIONS(self):
        if self.path != "/api/live-token":
            self.send_error(404)
            return

        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._set_cors_headers()
        self.end_headers()

    def do_GET(self):
        self.send_error(404)

    def do_POST(self):
        if self.path != "/api/live-token":
            self.send_error(404)
            return

        origin = self.headers.get("Origin")
        if origin and origin not in FRONTEND_ORIGINS:
            self._send_json(
                403,
                {
                    "error": "Frontend origin is not allowed.",
                    "code": "origin_not_allowed",
                },
            )
            return

        try:
            self._send_json(200, create_live_token())
        except Exception as error:
            print("Error creating Live API token:", error)
            self._send_json(
                500,
                {"error": "Unable to connect to the Gemini Live API. Check the API key and quota."},
            )


def run_server():
    with http.server.ThreadingHTTPServer((HOST, PORT), UniApiHandler) as httpd:
        print(f"Uni backend API running at http://localhost:{PORT}")
        print(f"Allowed frontend origins: {', '.join(sorted(FRONTEND_ORIGINS))}")
        print(f"Live voice model: {LIVE_MODEL} | Vietnamese response language")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down backend API.")


if __name__ == "__main__":
    run_server()
