from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import pytesseract
from PIL import Image
import io
import base64
import os
import re
from datetime import datetime, timezone
from pathlib import Path

app = Flask(__name__)
CORS(app)

SAVE_ENABLED = os.environ.get("OCR_SAVE_ENABLED", "1") != "0"
SAVE_DIR = Path(os.environ.get("OCR_SAVE_DIR", "/data/ocr"))
WEB_ROOT = Path(__file__).resolve().parent
OCR_FILE_RE = re.compile(
    r"^(?P<ts>\d{8}T\d{6}Z)_(?P<session>[A-Za-z0-9_-]+)_p(?P<page>\d{4})\.txt$"
)


def save_ocr_text(text: str, session: str | None, page: int | None) -> None:
    if not SAVE_ENABLED or not text.strip():
        return

    SAVE_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    safe_session = "".join(c for c in (session or "unknown") if c.isalnum() or c in ("-", "_"))[:80]
    page_part = f"p{page:04d}" if isinstance(page, int) and page > 0 else "p0000"
    filename = f"{ts}_{safe_session}_{page_part}.txt"
    (SAVE_DIR / filename).write_text(text, encoding="utf-8")


def get_saved_sessions() -> dict[str, dict]:
    sessions: dict[str, dict] = {}
    if not SAVE_DIR.exists():
        return sessions

    for file in SAVE_DIR.glob("*.txt"):
        match = OCR_FILE_RE.match(file.name)
        if not match:
            continue

        session = match.group("session")
        page = int(match.group("page"))
        ts = match.group("ts")
        if session not in sessions:
            sessions[session] = {
                "session": session,
                "files": [],
                "first_ts": ts,
                "last_ts": ts,
            }
        sessions[session]["files"].append((page, file))
        if ts < sessions[session]["first_ts"]:
            sessions[session]["first_ts"] = ts
        if ts > sessions[session]["last_ts"]:
            sessions[session]["last_ts"] = ts

    for data in sessions.values():
        data["files"].sort(key=lambda item: item[0])

    return sessions


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/api/ocr", methods=["POST"])
def ocr():
    """Accept a base64-encoded page image, return OCR'd text and persist it."""
    data = request.json
    if not data or "image" not in data:
        return jsonify({"error": "Missing 'image' field"}), 400

    try:
        # Decode base64 image (strip data URL prefix if present)
        img_data = data["image"]
        if "," in img_data:
            img_data = img_data.split(",", 1)[1]

        image_bytes = base64.b64decode(img_data)
        image = Image.open(io.BytesIO(image_bytes))

        # Run Tesseract OCR
        text = pytesseract.image_to_string(image)
        save_ocr_text(text, data.get("session"), data.get("page"))

        return jsonify({"text": text})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/ocr/sessions", methods=["GET"])
def ocr_sessions():
    sessions = get_saved_sessions()
    out = []
    for data in sessions.values():
        out.append(
            {
                "session": data["session"],
                "pages": len(data["files"]),
                "first_ts": data["first_ts"],
                "last_ts": data["last_ts"],
            }
        )
    out.sort(key=lambda item: item["last_ts"], reverse=True)
    return jsonify({"sessions": out})


@app.route("/api/ocr/sessions/<session>/text", methods=["GET"])
def ocr_session_text(session: str):
    sessions = get_saved_sessions()
    data = sessions.get(session)
    if not data:
        return jsonify({"error": "Session not found"}), 404

    combined = []
    for _, path in data["files"]:
        combined.append(path.read_text(encoding="utf-8"))
    return "".join(combined), 200, {"Content-Type": "text/plain; charset=utf-8"}


@app.route("/saved", methods=["GET"])
def saved_sessions_page():
    sessions = get_saved_sessions()
    rows = []
    for data in sorted(sessions.values(), key=lambda item: item["last_ts"], reverse=True):
        sid = data["session"]
        pages = len(data["files"])
        last_ts = data["last_ts"]
        rows.append(
            f'<li><a href="/api/ocr/sessions/{sid}/text" target="_blank">{sid}</a> '
            f"({pages} pages, last: {last_ts})</li>"
        )

    if not rows:
        body = "<p>No saved OCR sessions yet.</p>"
    else:
        body = "<ul>" + "".join(rows) + "</ul>"

    html = (
        "<!doctype html><html><head><meta charset='utf-8'><title>Saved OCR</title></head>"
        "<body><h1>Saved OCR Sessions</h1>"
        "<p>Tap a session to open the OCR text.</p>"
        f"{body}</body></html>"
    )
    return html


@app.route("/", methods=["GET"])
def web_index():
    return send_from_directory(WEB_ROOT, "index.html")


@app.route("/<path:asset_path>", methods=["GET"])
def web_assets(asset_path: str):
    # Keep API routes handled by their dedicated endpoints.
    if asset_path.startswith("api/"):
        return jsonify({"error": "Not found"}), 404

    target = WEB_ROOT / asset_path
    if target.exists() and target.is_file():
        return send_from_directory(WEB_ROOT, asset_path)
    return jsonify({"error": "Not found"}), 404


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
