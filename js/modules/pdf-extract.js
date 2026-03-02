const pdfjsLib = await import('https://unpkg.com/pdfjs-dist@4.9.155/build/pdf.min.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@4.9.155/build/pdf.worker.min.mjs';

// Cached PDF document for on-demand page rendering
let cachedPdf = null;

// OCR server URL — set this to your server's address
// e.g. 'http://your-oracle-ip:5000' or 'https://ocr.yourdomain.com'
const OCR_SERVER = localStorage.getItem('kindleish:ocr-server') || '';

async function loadPdf(arrayBuffer) {
  try {
    return await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  } catch (e) {
    console.warn('PDF.js worker failed, retrying without worker:', e);
    pdfjsLib.GlobalWorkerOptions.workerSrc = '';
    const copy = arrayBuffer.slice ? arrayBuffer.slice(0) : arrayBuffer;
    return await pdfjsLib.getDocument({ data: copy, disableAutoFetch: true }).promise;
  }
}

export async function extractBook(blob, onProgress) {
  const arrayBuffer = await blob.arrayBuffer();
  const pdf = await loadPdf(arrayBuffer);
  cachedPdf = pdf;
  const totalPages = pdf.numPages;
  const allHtml = [];

  for (let i = 1; i <= totalPages; i++) {
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
          return await ocrPages(pdf, totalPages, onProgress);
        } catch (err) {
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
      return await ocrPages(pdf, totalPages, onProgress);
    } catch (err) {
      console.warn('OCR failed, falling back to image mode:', err);
      return `<!--SCANNED:${totalPages}-->`;
    }
  }

  return combined;
}

// OCR: try server first, fall back to client-side Tesseract.js
async function ocrPages(pdf, totalPages, onProgress) {
  const serverUrl = localStorage.getItem('kindleish:ocr-server') || '';

  if (serverUrl) {
    try {
      return await ocrPagesServer(pdf, totalPages, onProgress, serverUrl);
    } catch (err) {
      console.warn('Server OCR failed, falling back to client-side:', err);
    }
  }

  return await ocrPagesClient(pdf, totalPages, onProgress);
}

// Server-side OCR: send each page image to the server
async function ocrPagesServer(pdf, totalPages, onProgress, serverUrl) {
  if (onProgress) onProgress(0, totalPages, 'ocr-loading');

  // Quick health check
  const healthResp = await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
  if (!healthResp.ok) throw new Error('Server not reachable');

  const allHtml = [];

  for (let i = 1; i <= totalPages; i++) {
    if (onProgress) onProgress(i, totalPages, 'ocr');

    // Render page to canvas
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    // Send to server as JPEG base64
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);

    // Free canvas memory
    canvas.width = 0;
    canvas.height = 0;

    const resp = await fetch(`${serverUrl}/api/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl })
    });

    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
    const { text } = await resp.json();

    if (text && text.trim()) {
      const paragraphs = text.trim().split(/\n\s*\n/).filter(p => p.trim());
      const html = paragraphs.map(p =>
        `<p>${escapeHtml(p.replace(/\n/g, ' ').trim())}</p>`
      ).join('\n');
      if (html) allHtml.push(html);
    }
  }

  return allHtml.join('\n');
}

// Client-side OCR using Tesseract.js (fallback)
async function ocrPagesClient(pdf, totalPages, onProgress) {
  if (onProgress) onProgress(0, totalPages, 'ocr-loading');

  const mod = await import('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js');
  const createWorker = mod.createWorker || mod.default?.createWorker;
  const worker = await createWorker('eng');

  const allHtml = [];

  for (let i = 1; i <= totalPages; i++) {
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

  await worker.terminate();
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
