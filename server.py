import os
import json
import http.server
import socketserver
from datetime import datetime, timedelta, timezone
from urllib.parse import unquote, urlparse
from pathlib import Path
from google import genai
from google.genai import types

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "src"
LIVE_MODEL = "gemini-3.1-flash-live-preview"

# Load environment variables from .env file if present
env_path = BASE_DIR / ".env"
if env_path.exists():
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, val = line.split("=", 1)
                os.environ.setdefault(key.strip(), val.strip())

API_KEY = os.environ.get("GEMINI_API_KEY", "")
HOST = os.environ.get("HOST", "0.0.0.0")
try:
    PORT = int(os.environ.get("PORT", 3000))
except ValueError:
    PORT = 3000

if not API_KEY:
    print("WARNING: GEMINI_API_KEY is not set in the environment or .env file.")

# Initialize Gemini Client
client = genai.Client(api_key=API_KEY) if API_KEY else None

SYSTEM_PROMPT = """Bạn là Uni, linh vật Live United — một trợ lý AI vui vẻ, năng lượng và luôn hỗ trợ người dùng.

TÍNH CÁCH:
- Bạn lan tỏa sự tích cực, tinh thần đoàn kết và sự tò mò.
- Bạn năng lượng, thân thiện, vui vẻ và luôn khích lệ người dùng.
- Sứ mệnh của bạn là truyền cảm hứng và kết nối mọi người.
- Bạn nói chuyện tự nhiên, ấm áp như một người bạn.

QUY TẮC TRẢ LỜI:
- Luôn trả lời bằng tiếng Việt, trừ khi người dùng yêu cầu rõ ràng một ngôn ngữ khác.
- Giữ câu trả lời NGẮN, tối đa 1-2 câu vì bạn đang trò chuyện bằng giọng nói.
- Không dùng Markdown, gạch đầu dòng, ký hiệu định dạng, dấu sao hoặc emoji.
- Nói tự nhiên, gần gũi và dễ nghe khi đọc thành tiếng.
- Luôn trả lời đúng vào điều người dùng vừa nói. Không trả lời bằng một câu chung chung như "Hãy làm đi" nếu chưa giải thích người dùng nên làm gì.
"""

def create_live_token():
    if not client:
        raise ValueError("Gemini client is not configured with an API key.")

    now = datetime.now(timezone.utc)
    # Keep the token short-lived and one-use. The current SDK's model
    # constraint serialization is incompatible with the constrained Live
    # WebSocket endpoint, so the browser selects LIVE_MODEL in its setup.
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
        "system_prompt": SYSTEM_PROMPT,
    }


SENSITIVE_FILES = {
    ".env",
    ".firebaserc",
    "firebase.json",
    "requirements.txt",
    "server.py",
}


class UniChatHandler(http.server.SimpleHTTPRequestHandler):
    """Serve public files and mint short-lived Live API browser tokens."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    #Validate path
    def _is_public_path(self):
        path = unquote(urlparse(self.path).path).lstrip("/")
        if not path:
            return True

        parts = Path(path).parts
        if any(part in {"..", *SENSITIVE_FILES} for part in parts):
            return False
        if any(part == "__pycache__" or part.endswith(".pyc") for part in parts):
            return False
        if any(part.startswith(".") for part in parts):
            return False
        return True

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # This server is for local development. Always reload changed UI and
        # avatar files instead of letting the browser keep stale assets.
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_GET(self):
        if not self._is_public_path():
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self):
        if not self._is_public_path():
            self.send_error(404)
            return
        super().do_HEAD()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        if urlparse(self.path).path != "/api/live-token":
            self.send_response(404)
            self.end_headers()
            return

        try:
            self._send_json(200, create_live_token())
        except Exception as e:
            print("Error creating Live API token:", e)
            self._send_json(500, {"error": "Unable to connect to the Gemini Live API. Check the API key and quota."})


def run_server():
    http_server = type("UniThreadingHTTPServer", (socketserver.ThreadingTCPServer,), {
        "allow_reuse_address": True,
        "daemon_threads": True,
    })

    with http_server((HOST, PORT), UniChatHandler) as httpd:
        print(f"Uni voice assistant server running at http://localhost:{PORT}")
        if HOST == "0.0.0.0":
            print("For a phone on the same Wi-Fi, open http://<computer-ip>:%s" % PORT)
            print("Mobile microphone access may require HTTPS or localhost.")
        print(f"Live voice model: {LIVE_MODEL} | Vietnamese response language")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server.")

if __name__ == "__main__":
    run_server()
