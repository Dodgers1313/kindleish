from flask import Flask, request, jsonify
from flask_cors import CORS
import pytesseract
from PIL import Image
import io
import base64
import os
from datetime import datetime, timezone
from pathlib import Path

app = Flask(__name__)
CORS(app)

SAVE_ENABLED = os.environ.get("OCR_SAVE_ENABLED", "1") != "0"
SAVE_DIR = Path(os.environ.get("OCR_SAVE_DIR", "/data/ocr"))


def save_ocr_text(text: str, session: str | None, page: int | None) -> None:
    if not SAVE_ENABLED or not text.strip():
        return

    SAVE_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    safe_session = "".join(c for c in (session or "unknown") if c.isalnum() or c in ("-", "_"))[:80]
    page_part = f"p{page:04d}" if isinstance(page, int) and page > 0 else "p0000"
    filename = f"{ts}_{safe_session}_{page_part}.txt"
    (SAVE_DIR / filename).write_text(text, encoding="utf-8")


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


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
