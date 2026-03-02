from flask import Flask, request, jsonify, send_from_directory, Response, stream_with_context
from flask_cors import CORS
import pytesseract
from PIL import Image
import fitz  # PyMuPDF
import io
import json
import base64
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import threading

app = Flask(__name__)
CORS(app)

# Global OCR queue — only one OCR job runs at a time
_ocr_lock = threading.Lock()
_ocr_queue_count = 0  # number of jobs waiting or running
_ocr_queue_count_lock = threading.Lock()

SAVE_ENABLED = os.environ.get("OCR_SAVE_ENABLED", "1") != "0"
SAVE_DIR = Path(os.environ.get("OCR_SAVE_DIR", "/data/ocr"))
LIBRARY_DIR = Path(os.environ.get("LIBRARY_DIR", "/data/library"))
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


@app.route("/api/ocr/queue", methods=["GET"])
def ocr_queue_status():
    with _ocr_queue_count_lock:
        return jsonify({"waiting": _ocr_queue_count})


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
        image = Image.open(io.BytesIO(image_bytes)).convert('L')

        with _ocr_queue_count_lock:
            global _ocr_queue_count
            _ocr_queue_count += 1
        try:
            with _ocr_lock:
                text = pytesseract.image_to_string(image, config='--oem 1')
        finally:
            with _ocr_queue_count_lock:
                _ocr_queue_count -= 1
        save_ocr_text(text, data.get("session"), data.get("page"))

        return jsonify({"text": text})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _render_and_ocr_page(args: tuple) -> tuple[int, str]:
    """Render a single PDF page with PyMuPDF and OCR it. Thread-safe."""
    pdf_bytes, page_num, ocr_config = args
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        page = doc.load_page(page_num)
        # Render at 2x scale (~144 DPI) for good OCR accuracy
        mat = fitz.Matrix(2.0, 2.0)
        pix = page.get_pixmap(matrix=mat, colorspace=fitz.csGRAY)
        img = Image.frombytes("L", (pix.width, pix.height), pix.samples)
        text = pytesseract.image_to_string(img, config=ocr_config)
        return page_num, text
    finally:
        doc.close()


@app.route("/api/ocr/pdf", methods=["POST"])
def ocr_pdf():
    """Accept a base64-encoded PDF, render+OCR pages and stream progress as NDJSON.

    Each line is a JSON object:
      {"page": 0, "total": N}                  — queued/starting
      {"page": i, "total": N, "text": "..."}   — page completed
      {"done": true, "pages": ["...", ...]}     — all done
    """
    data = request.json
    if not data or "pdf" not in data:
        return jsonify({"error": "Missing 'pdf' field"}), 400

    try:
        pdf_b64 = data["pdf"]
        if "," in pdf_b64:
            pdf_b64 = pdf_b64.split(",", 1)[1]
        pdf_bytes = base64.b64decode(pdf_b64)

        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        num_pages = len(doc)
        doc.close()

        session = data.get("session")
        ocr_config = "--oem 1"
        cpu_count = os.cpu_count() or 4
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    def generate():
        global _ocr_queue_count
        with _ocr_queue_count_lock:
            _ocr_queue_count += 1

        # Send initial status so client knows total pages
        yield json.dumps({"page": 0, "total": num_pages}) + "\n"

        texts = [""] * num_pages
        try:
            with _ocr_lock:
                completed = 0
                with ThreadPoolExecutor(max_workers=cpu_count) as executor:
                    futures = {
                        executor.submit(_render_and_ocr_page, (pdf_bytes, i, ocr_config)): i
                        for i in range(num_pages)
                    }
                    from concurrent.futures import as_completed
                    for future in as_completed(futures):
                        page_num, text = future.result()
                        texts[page_num] = text
                        completed += 1
                        save_ocr_text(text, session, page_num + 1)
                        yield json.dumps({"page": completed, "total": num_pages}) + "\n"
        finally:
            with _ocr_queue_count_lock:
                _ocr_queue_count -= 1

        yield json.dumps({"done": True, "pages": texts}) + "\n"

    return Response(
        stream_with_context(generate()),
        mimetype="application/x-ndjson",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"}
    )


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


# --- Library sync endpoints ---

def _get_user() -> str | None:
    """Get the current user from the X-User header."""
    user = request.headers.get("X-User", "").strip()
    if not user:
        return None
    # Sanitize: lowercase, alphanumeric + hyphens/underscores only
    return "".join(c for c in user.lower() if c.isalnum() or c in ("-", "_"))[:40] or None


def _user_dir() -> Path | None:
    user = _get_user()
    if not user:
        return None
    return LIBRARY_DIR / user


def _book_dir(book_id: str) -> Path | None:
    udir = _user_dir()
    if not udir:
        return None
    safe_id = "".join(c for c in book_id if c.isalnum() or c in ("-", "_"))[:80]
    return udir / safe_id


def _read_json(path: Path):
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


@app.route("/api/library", methods=["GET"])
def library_list():
    udir = _user_dir()
    if not udir:
        return jsonify({"error": "X-User header required"}), 400
    books = []
    if udir.exists():
        for d in udir.iterdir():
            if not d.is_dir():
                continue
            meta = _read_json(d / "meta.json")
            if not meta:
                continue
            entry = {**meta, "id": d.name, "hasContent": (d / "content.html").exists()}
            pos = _read_json(d / "position.json")
            if pos:
                entry["position"] = pos
            bm = _read_json(d / "bookmarks.json")
            if bm is not None:
                entry["bookmarks"] = bm
            books.append(entry)
    books.sort(key=lambda b: b.get("addedAt", 0), reverse=True)
    return jsonify({"books": books})


@app.route("/api/library/<book_id>", methods=["PUT"])
def library_put(book_id: str):
    d = _book_dir(book_id)
    if not d:
        return jsonify({"error": "X-User header required"}), 400
    data = request.json or {}
    meta = {"title": data.get("title", ""), "addedAt": data.get("addedAt", 0),
            "pageCount": data.get("pageCount", 0)}
    _write_json(d / "meta.json", meta)
    return jsonify(meta)


@app.route("/api/library/<book_id>", methods=["DELETE"])
def library_delete(book_id: str):
    d = _book_dir(book_id)
    if not d:
        return jsonify({"error": "X-User header required"}), 400
    if not d.exists():
        return jsonify({"error": "Not found"}), 404
    shutil.rmtree(d)
    return jsonify({"ok": True})


@app.route("/api/library/<book_id>/content", methods=["GET"])
def library_content_get(book_id: str):
    d = _book_dir(book_id)
    if not d:
        return jsonify({"error": "X-User header required"}), 400
    path = d / "content.html"
    if not path.exists():
        return jsonify({"error": "Not found"}), 404
    return path.read_text(encoding="utf-8"), 200, {"Content-Type": "text/html; charset=utf-8"}


@app.route("/api/library/<book_id>/content", methods=["PUT"])
def library_content_put(book_id: str):
    d = _book_dir(book_id)
    if not d:
        return jsonify({"error": "X-User header required"}), 400
    d.mkdir(parents=True, exist_ok=True)
    html = request.get_data(as_text=True)
    (d / "content.html").write_text(html, encoding="utf-8")
    return jsonify({"ok": True})


@app.route("/api/library/<book_id>/position", methods=["PUT"])
def library_position_put(book_id: str):
    d = _book_dir(book_id)
    if not d:
        return jsonify({"error": "X-User header required"}), 400
    data = request.json or {}
    d.mkdir(parents=True, exist_ok=True)
    path = d / "position.json"
    existing = _read_json(path)
    if existing and existing.get("timestamp", 0) >= data.get("timestamp", 0):
        return jsonify(existing)
    _write_json(path, data)
    return jsonify(data)


@app.route("/api/library/<book_id>/bookmarks", methods=["PUT"])
def library_bookmarks_put(book_id: str):
    d = _book_dir(book_id)
    if not d:
        return jsonify({"error": "X-User header required"}), 400
    data = request.json
    if data is None:
        data = []
    d.mkdir(parents=True, exist_ok=True)
    _write_json(d / "bookmarks.json", data)
    return jsonify(data)


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
