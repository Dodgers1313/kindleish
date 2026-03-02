FROM python:3.11-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends tesseract-ocr && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY server/app.py ./app.py
COPY index.html ./index.html
COPY reader.html ./reader.html
COPY manifest.json ./manifest.json
COPY sw.js ./sw.js
COPY css ./css
COPY js ./js
COPY icons ./icons

EXPOSE 5000
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--timeout", "120", "app:app"]
