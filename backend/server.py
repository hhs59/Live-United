import json
import http.server
import os
import socketserver
from datetime import datetime, timedelta, timezone
from pathlib import Path

from google import genai
from google.genai import types

from .avatar_pipeline import prepare_avatar
from .avatar_vision import (
    ALLOWED_AVATAR_MIME_TYPES,
    MAX_AVATAR_IMAGE_BYTES,
    AvatarVisionError,
    AvatarVisionQuotaError,
    AvatarVisionUnavailableError,
    normalize_mime_type,
    validate_image_signature,
)
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

API_POST_PATHS = frozenset({"/api/live-token", "/api/avatar/prepare"})

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
        if self.path not in API_POST_PATHS:
            self.send_error(404)
            return

        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._set_cors_headers()
        self.end_headers()

    def do_GET(self):
        self.send_error(404)

    def do_POST(self):
        if self.path not in API_POST_PATHS:
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

        if self.path == "/api/avatar/prepare":
            self._handle_avatar_preparation()
            return

        try:
            self._send_json(200, create_live_token())
        except Exception as error:
            print("Error creating Live API token:", error)
            self._send_json(
                500,
                {"error": "Unable to connect to the Gemini Live API. Check the API key and quota."},
            )

    def _read_avatar_request(self):
        raw_mime_type = self.headers.get("Content-Type", "")
        mime_type = normalize_mime_type(raw_mime_type)
        if mime_type not in ALLOWED_AVATAR_MIME_TYPES:
            raise AvatarVisionError("Avatar image must be PNG or JPEG.")

        raw_length = self.headers.get("Content-Length")
        try:
            content_length = int(raw_length) if raw_length is not None else -1
        except ValueError:
            content_length = -1

        if content_length <= 0:
            raise AvatarVisionError("Avatar image length is invalid.")
        if content_length > MAX_AVATAR_IMAGE_BYTES:
            raise OverflowError("Avatar image is too large.")

        image_bytes = self.rfile.read(content_length)
        if len(image_bytes) != content_length:
            raise AvatarVisionError("Avatar image body is incomplete.")

        try:
            validate_image_signature(image_bytes, mime_type)
        except AvatarVisionError:
            raise AvatarVisionError("Avatar image body is not a valid PNG or JPEG.")

        return image_bytes, mime_type

    def _handle_avatar_preparation(self):
        try:
            image_bytes, mime_type = self._read_avatar_request()
        except OverflowError:
            self._send_json(
                413,
                {
                    "error": "Avatar image is too large.",
                    "code": "avatar_too_large",
                },
            )
            return
        except AvatarVisionError:
            self._send_json(
                400,
                {
                    "error": "Avatar image request is invalid.",
                    "code": "invalid_avatar_request",
                },
            )
            return

        try:
            preparation = prepare_avatar(
                client,
                image_bytes,
                mime_type,
                cache_dir=BASE_DIR / "runtime" / "avatar-preparation" / "cache-v1",
            )
            self._send_json(200, preparation)
        except AvatarVisionError:
            self._send_json(
                422,
                {
                    "error": "Avatar geometry could not be prepared.",
                    "code": "avatar_not_detected",
                },
            )
        except AvatarVisionQuotaError:
            self._send_json(
                429,
                {
                    "error": "Avatar preparation quota is unavailable.",
                    "code": "avatar_analysis_quota",
                },
            )
        except AvatarVisionUnavailableError:
            self._send_json(
                503,
                {
                    "error": "Avatar preparation is temporarily unavailable.",
                    "code": "avatar_analysis_unavailable",
                },
            )
        except Exception as error:
            print("Avatar preparation failed:", type(error).__name__)
            self._send_json(
                500,
                {
                    "error": "Avatar preparation failed.",
                    "code": "avatar_analysis_failed",
                },
            )


def run_server():
    http_server = type(
        "UniApiServer",
        (socketserver.ThreadingTCPServer,),
        {"allow_reuse_address": True, "daemon_threads": True},
    )

    with http_server((HOST, PORT), UniApiHandler) as httpd:
        print(f"Uni backend API running at http://localhost:{PORT}")
        print(f"Allowed frontend origins: {', '.join(sorted(FRONTEND_ORIGINS))}")
        print(f"Live voice model: {LIVE_MODEL} | Vietnamese response language")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down backend API.")


if __name__ == "__main__":
    run_server()
