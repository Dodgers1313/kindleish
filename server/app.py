from flask import Flask, request, jsonify
from flask_cors import CORS
import pytesseract
from PIL import Image
import io
import base64
import os

app = Flask(__name__)
CORS(app)


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/api/ocr", methods=["POST"])
def ocr():
    """Accept a base64-encoded page image, return OCR'd text."""
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

        return jsonify({"text": text})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
