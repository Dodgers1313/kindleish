const pdfjsLib = await import('https://unpkg.com/pdfjs-dist@4.9.155/build/pdf.min.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@4.9.155/build/pdf.worker.min.mjs';

// Cached PDF document for on-demand page rendering
let cachedPdf = null;

// OCR server URL — set this to your server's address
// e.g. 'http://your-oracle-ip:5000' or 'https://ocr.yourdomain.com'
const OCR_SERVER = localStorage.getItem('kindleish:ocr-server') || '';

function createAbortError() {
  const err = new Error('Operation canceled');
  err.name = 'AbortError';
  return err;
}

function isAbortError(err) {
  return err?.name === 'AbortError';
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

async function yieldToUi(signal = null) {
  // Let click/touch handlers run between OCR units of work.
  await new Promise(resolve => setTimeout(resolve, 0));
  throwIfAborted(signal);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 0, signal = null) {
  const controller = new AbortController();
  let timeoutId = null;
  let timedOut = false;

  const handleAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) throw createAbortError();
    signal.addEventListener('abort', handleAbort, { once: true });
  }

  if (timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (signal?.aborted) throw createAbortError();
    if (timedOut) throw new Error('Request timed out');
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (signal) signal.removeEventListener('abort', handleAbort);
  }
}

async function loadPdf(arrayBuffer, signal = null) {
  throwIfAborted(signal);
  try {
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    throwIfAborted(signal);
    return pdf;
  } catch (e) {
    if (isAbortError(e)) throw e;
    console.warn('PDF.js worker failed, retrying without worker:', e);
    pdfjsLib.GlobalWorkerOptions.workerSrc = '';
    const copy = arrayBuffer.slice ? arrayBuffer.slice(0) : arrayBuffer;
    const loadingTask = pdfjsLib.getDocument({ data: copy, disableAutoFetch: true });
    const pdf = await loadingTask.promise;
    throwIfAborted(signal);
    return pdf;
  }
}

export async function extractBook(blob, onProgress, options = {}) {
  const signal = options.signal || null;
  throwIfAborted(signal);
  const arrayBuffer = await blob.arrayBuffer();
  throwIfAborted(signal);
  const pdf = await loadPdf(arrayBuffer, signal);
  cachedPdf = pdf;
  const totalPages = pdf.numPages;
  const allHtml = [];

  for (let i = 1; i <= totalPages; i++) {
    await yieldToUi(signal);
    throwIfAborted(signal);
    if (onProgress) onProgress(i, totalPages, 'extract');

    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const html = reconstructText(content.items);
    if (html.trim()) {
      allHtml.push(html);
    }

    // Early detection: after 10 pages, if barely any text, it's scanned
    if (i === Math.min(10, totalPages)) {
      const earlyText = allHtml.join('').replace(/<[^>]*>/g, '').trim();
      if (earlyText.length < 20) {
        try {
          return await ocrPages(pdf, blob, totalPages, onProgress, signal);
        } catch (err) {
          if (isAbortError(err)) throw err;
          console.warn('OCR failed, falling back to image mode:', err);
          return `<!--SCANNED:${totalPages}-->`;
        }
      }
    }
  }

  const combined = allHtml.join('');

  const textLength = combined.replace(/<[^>]*>/g, '').trim().length;
  if (textLength < 100 && totalPages > 1) {
    try {
      return await ocrPages(pdf, blob, totalPages, onProgress, signal);
    } catch (err) {
      if (isAbortError(err)) throw err;
      console.warn('OCR failed, falling back to image mode:', err);
      return `<!--SCANNED:${totalPages}-->`;
    }
  }

  return combined;
}

// OCR: try server first (same-origin or configured URL), fall back to client-side Tesseract.js
async function ocrPages(pdf, blob, totalPages, onProgress, signal = null) {
  await yieldToUi(signal);
  throwIfAborted(signal);
  // Use configured URL, or empty string for same-origin relative requests
  const serverUrl = localStorage.getItem('kindleish:ocr-server') || '';

  try {
    console.log('[OCR] Trying server at', serverUrl || '(same-origin)');
    return await ocrPagesServer(pdf, blob, totalPages, onProgress, serverUrl, signal);
  } catch (err) {
    if (isAbortError(err)) throw err;
    console.warn('[OCR] Server failed, falling back to client-side:', err);
  }

  console.log('[OCR] Using client-side Tesseract.js');
  return await ocrPagesClient(pdf, totalPages, onProgress, signal);
}

// Convert a Blob to base64 string (without data URL prefix)
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function pagesToHtml(pages) {
  return pages.map(text => {
    if (!text || !text.trim()) return '';
    const paragraphs = text.trim().split(/\n\s*\n/).filter(p => p.trim());
    return paragraphs.map(p =>
      `<p>${escapeHtml(p.replace(/\n/g, ' ').trim())}</p>`
    ).join('\n');
  }).filter(Boolean).join('\n');
}

// Server-side OCR: upload full PDF for parallel server-side rendering + OCR
async function ocrPagesServer(pdf, blob, totalPages, onProgress, serverUrl, signal = null) {
  await yieldToUi(signal);
  throwIfAborted(signal);

  // Quick health check
  const healthResp = await fetchWithTimeout(`${serverUrl}/api/health`, {}, 5000, signal);
  if (!healthResp.ok) throw new Error('Server not reachable');

  if (onProgress) onProgress(0, totalPages, 'ocr-loading');
  const sessionId = `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Encode PDF as base64 and send to server for parallel render+OCR
  const pdfBase64 = await blobToBase64(blob);
  throwIfAborted(signal);

  // Check queue before submitting — show position in line
  try {
    const qResp = await fetchWithTimeout(`${serverUrl}/api/ocr/queue`, {}, 3000, signal);
    if (qResp.ok) {
      const q = await qResp.json();
      if (q.waiting > 0) {
        if (onProgress) onProgress(q.waiting, totalPages, 'ocr-queue');
      }
    }
  } catch (_) {}

  if (onProgress) onProgress(0, totalPages, 'ocr');

  const resp = await fetch(`${serverUrl}/api/ocr/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ pdf: pdfBase64, session: sessionId })
  });

  if (!resp.ok) throw new Error(`Server returned ${resp.status}`);

  // Read streaming NDJSON response for real-time progress
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalPages = null;

  while (true) {
    throwIfAborted(signal);
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete last line in buffer
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.done && msg.pages) {
          finalPages = msg.pages;
        } else if (msg.page !== undefined) {
          if (onProgress) onProgress(msg.page, msg.total, 'ocr');
        }
      } catch (_) {}
    }
  }
  // Process any remaining buffer
  if (buffer.trim()) {
    try {
      const msg = JSON.parse(buffer);
      if (msg.done && msg.pages) finalPages = msg.pages;
    } catch (_) {}
  }

  if (!finalPages) throw new Error('No pages received from server');
  if (onProgress) onProgress(totalPages, totalPages, 'ocr');
  return pagesToHtml(finalPages);
}

// Client-side OCR using Tesseract.js (fallback)
async function ocrPagesClient(pdf, totalPages, onProgress, signal = null) {
  await yieldToUi(signal);
  throwIfAborted(signal);
  if (onProgress) onProgress(0, totalPages, 'ocr-loading');

  const mod = await import('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js');
  const createWorker = mod.createWorker || mod.default?.createWorker;
  const worker = await createWorker('eng');
  const abortWorker = () => {
    try {
      worker.terminate();
    } catch (_) {}
  };
  if (signal) signal.addEventListener('abort', abortWorker, { once: true });

  const allHtml = [];

  try {
    for (let i = 1; i <= totalPages; i++) {
      await yieldToUi(signal);
      throwIfAborted(signal);
      if (onProgress) onProgress(i, totalPages, 'ocr');

      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;

      const { data } = await worker.recognize(canvas);

      canvas.width = 0;
      canvas.height = 0;

      const text = data.text.trim();
      if (text) {
        const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());
        const html = paragraphs.map(p =>
          `<p>${escapeHtml(p.replace(/\n/g, ' ').trim())}</p>`
        ).join('\n');
        if (html) allHtml.push(html);
      }
    }
  } catch (err) {
    if (signal?.aborted) throw createAbortError();
    throw err;
  } finally {
    if (signal) signal.removeEventListener('abort', abortWorker);
    try {
      await worker.terminate();
    } catch (_) {}
  }

  return allHtml.join('\n');
}

// Render a single PDF page to a canvas (called on demand by the reader)
export async function renderPdfPage(blob, pageNum) {
  if (!cachedPdf) {
    const arrayBuffer = await blob.arrayBuffer();
    cachedPdf = await loadPdf(arrayBuffer);
  }

  const page = await cachedPdf.getPage(pageNum);
  const baseViewport = page.getViewport({ scale: 1 });

  const targetWidth = window.innerWidth;
  const scale = Math.min(
    (targetWidth / baseViewport.width) * (window.devicePixelRatio || 1),
    3
  );
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');

  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

function reconstructText(items) {
  if (!items || items.length === 0) return '';

  const fontSizes = {};
  for (const item of items) {
    if (!item.str || !item.str.trim()) continue;
    const size = Math.round(Math.abs(item.transform[0]) * 10) / 10;
    fontSizes[size] = (fontSizes[size] || 0) + item.str.length;
  }

  let bodyFontSize = 12;
  let maxCount = 0;
  for (const [size, count] of Object.entries(fontSizes)) {
    if (count > maxCount) {
      maxCount = count;
      bodyFontSize = parseFloat(size);
    }
  }

  const headingThreshold = bodyFontSize * 1.2;
  const paragraphGapThreshold = bodyFontSize * 1.5;

  const blocks = [];
  let currentBlock = { text: '', isHeading: false };
  let prevY = null;

  for (const item of items) {
    if (!item.str) continue;

    const text = item.str;
    const fontSize = Math.abs(item.transform[0]);
    const y = item.transform[5];
    const isHeading = fontSize >= headingThreshold && text.trim().length > 0;

    if (prevY !== null) {
      const yDiff = Math.abs(prevY - y);

      if (yDiff > paragraphGapThreshold) {
        if (currentBlock.text.trim()) {
          blocks.push({ ...currentBlock });
        }
        currentBlock = { text: '', isHeading };
      } else if (isHeading !== currentBlock.isHeading && currentBlock.text.trim()) {
        blocks.push({ ...currentBlock });
        currentBlock = { text: '', isHeading };
      } else if (yDiff > fontSize * 0.5) {
        currentBlock.text += ' ';
      } else if (text.length > 0 && !currentBlock.text.endsWith(' ') && !text.startsWith(' ')) {
        if (currentBlock.text.length > 0) {
          currentBlock.text += ' ';
        }
      }
    }

    currentBlock.text += text;
    currentBlock.isHeading = currentBlock.isHeading || isHeading;
    prevY = y;
  }

  if (currentBlock.text.trim()) {
    blocks.push(currentBlock);
  }

  return blocks.map(block => {
    const text = escapeHtml(block.text.trim());
    if (!text) return '';
    if (block.isHeading) {
      return `<h2>${text}</h2>`;
    }
    return `<p>${text}</p>`;
  }).join('\n');
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
