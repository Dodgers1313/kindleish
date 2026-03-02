import { getBook, saveExtractedHtml } from './modules/storage.js';
import { extractBook, renderPdfPage } from './modules/pdf-extract.js';
import { initPaginator, goToPage, nextPage, prevPage, getCurrentPage, getTotalPages, getProgress, recalculate } from './modules/paginator.js';
import { initGestures } from './modules/gestures.js';
import { restoreTheme, setTheme, getCurrentTheme } from './modules/themes.js';
import { initTypography, increaseFontSize, decreaseFontSize, setFontFamily, setLineHeight, getFontSize, getFontFamily, getLineHeight } from './modules/typography.js';
import { initBookmarks, toggleBookmark, isBookmarked } from './modules/bookmarks.js';
import { initProgress, saveCurrentPosition, restorePosition } from './modules/progress.js';

// DOM elements
const readerLoading = document.getElementById('reader-loading');
const extractProgress = document.getElementById('extract-progress');
const extractCancel = document.getElementById('extract-cancel');
const viewport = document.getElementById('viewport');
const contentContainer = document.getElementById('content-container');
const progressBar = document.getElementById('progress-bar');
const topBar = document.getElementById('top-bar');
const bottomBar = document.getElementById('bottom-bar');
const bookTitle = document.getElementById('book-title');
const backBtn = document.getElementById('back-btn');
const bookmarkBtn = document.getElementById('bookmark-btn');
const bookmarkIcon = document.getElementById('bookmark-icon');
const pageInfo = document.getElementById('page-info');
const pctInfo = document.getElementById('pct-info');
const progressSlider = document.getElementById('progress-slider');
const settingsBtn = document.getElementById('settings-btn');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsPanel = document.getElementById('settings-panel');
const fontDecrease = document.getElementById('font-decrease');
const fontIncrease = document.getElementById('font-increase');
const fontSizeValue = document.getElementById('font-size-value');

let chromeVisible = false;
let settingsVisible = false;
let bookId = null;
let extractionAbortController = null;
let extractionCancelled = false;

// Scanned PDF state
let scannedMode = false;
let scannedPageCount = 0;
let scannedCurrentPage = 1;
let bookBlob = null;

function isAbortError(err) {
  return err?.name === 'AbortError' || err?.message === 'Operation canceled';
}

function cancelExtraction() {
  if (!extractionAbortController) return;
  extractionCancelled = true;
  extractProgress.textContent = 'Canceling...';
  extractCancel.disabled = true;
  extractionAbortController.abort();
}

async function init() {
  // Get book ID from URL
  const params = new URLSearchParams(window.location.search);
  bookId = params.get('id');

  if (!bookId) {
    window.location.href = 'index.html';
    return;
  }

  // Restore theme and typography first (before content renders)
  restoreTheme();
  initTypography(onTypographyChange);

  // Load book from IndexedDB
  const book = await getBook(bookId);
  if (!book) {
    window.location.href = 'index.html';
    return;
  }

  bookTitle.textContent = book.title;
  document.title = book.title + ' - Kindleish';

  // Extract text or use cached
  let html = book.extractedHtml;
  if (!html) {
    extractProgress.textContent = 'Extracting text...';
    extractCancel.classList.remove('hidden');
    extractCancel.disabled = false;
    extractionAbortController = new AbortController();
    extractionCancelled = false;
    try {
      html = await extractBook(book.blob, (current, total, phase) => {
        if (phase === 'ocr-loading') {
          extractProgress.textContent = 'Loading OCR engine...';
        } else if (phase === 'ocr') {
          extractProgress.textContent = `Reading page ${current} of ${total} (OCR)...`;
        } else {
          extractProgress.textContent = `Scanning page ${current} of ${total}...`;
        }
      }, { signal: extractionAbortController.signal });
      // Save extraction result (non-fatal if it fails)
      try {
        await saveExtractedHtml(bookId, html);
      } catch (saveErr) {
        console.warn('Could not cache extraction result:', saveErr);
      }
    } catch (err) {
      if (extractionCancelled || isAbortError(err)) {
        window.location.href = 'index.html';
        return;
      }
      console.error('Extraction failed:', err);
      extractProgress.textContent = 'Could not extract text from this PDF.';
      setTimeout(() => {
        if (confirm('Could not read this PDF. It may be corrupted, password-protected, or a scanned document.\n\nReturn to library?')) {
          window.location.href = 'index.html';
        }
      }, 500);
      return;
    } finally {
      extractionAbortController = null;
      extractCancel.classList.add('hidden');
    }
  }

  // Check if this is a scanned PDF
  const scannedMatch = html.match(/<!--SCANNED:(\d+)-->/);
  if (scannedMatch) {
    await initScannedMode(book, parseInt(scannedMatch[1]));
    return;
  }

  // Inject content
  contentContainer.innerHTML = html;

  // Wait for fonts to load before paginating
  await document.fonts.ready;

  // Init modules
  initProgress(bookId);
  initBookmarks(bookId, updateBookmarkUI);

  const totalPages = initPaginator({
    onPageChange: onPageChange
  });

  // Restore reading position
  const savedPage = restorePosition(bookId, totalPages);
  goToPage(savedPage, false);

  // Init gestures
  initGestures(viewport, {
    onNext: () => nextPage(),
    onPrev: () => prevPage(),
    onCenterTap: toggleChrome
  });

  // Hide loading screen
  readerLoading.classList.add('hidden');

  // Wire up UI controls
  wireControls();

  // Update initial UI state
  updateUI();
  updateSettingsUI();
}

// --- Scanned PDF mode ---

async function initScannedMode(book, pageCount) {
  scannedMode = true;
  scannedPageCount = pageCount;
  bookBlob = book.blob;

  // Create placeholder divs — one per PDF page, each forced into its own column
  const placeholders = [];
  for (let i = 1; i <= pageCount; i++) {
    placeholders.push(
      `<div class="scanned-page" data-page="${i}"><span class="scanned-page-label">Page ${i}</span></div>`
    );
  }
  contentContainer.innerHTML = placeholders.join('');

  // Init modules
  initProgress(bookId);
  initBookmarks(bookId, updateBookmarkUI);

  const totalPages = initPaginator({
    onPageChange: onScannedPageChange
  });

  // Restore reading position
  const savedPage = restorePosition(bookId, totalPages);
  goToPage(savedPage, false);

  // Render the current page
  await renderScannedPage(getCurrentPage());

  // Init gestures
  initGestures(viewport, {
    onNext: () => nextPage(),
    onPrev: () => prevPage(),
    onCenterTap: toggleChrome
  });

  // Hide loading screen
  readerLoading.classList.add('hidden');

  wireControls();
  updateUI();
  updateSettingsUI();
}

async function onScannedPageChange(page, totalPages) {
  updateUI();
  saveCurrentPosition(page, totalPages);
  await renderScannedPage(page);
}

async function renderScannedPage(page) {
  // Clean up distant pages to save memory (keep current +/- 1)
  contentContainer.querySelectorAll('.scanned-page canvas').forEach(canvas => {
    const pageNum = parseInt(canvas.parentElement.dataset.page);
    if (Math.abs(pageNum - page) > 1) {
      canvas.remove();
    }
  });

  // Render current page if not already rendered
  const pageDiv = contentContainer.querySelector(`.scanned-page[data-page="${page}"]`);
  if (!pageDiv || pageDiv.querySelector('canvas')) return;

  try {
    const canvas = await renderPdfPage(bookBlob, page);
    canvas.className = 'scanned-page-canvas';
    // Hide the label, show canvas
    const label = pageDiv.querySelector('.scanned-page-label');
    if (label) label.style.display = 'none';
    pageDiv.appendChild(canvas);
  } catch (err) {
    console.error('Failed to render page', page, err);
  }

  // Pre-render adjacent pages
  preRenderAdjacent(page);
}

async function preRenderAdjacent(page) {
  for (const adj of [page - 1, page + 1]) {
    if (adj < 1 || adj > scannedPageCount) continue;
    const div = contentContainer.querySelector(`.scanned-page[data-page="${adj}"]`);
    if (!div || div.querySelector('canvas')) continue;
    try {
      const canvas = await renderPdfPage(bookBlob, adj);
      canvas.className = 'scanned-page-canvas';
      const label = div.querySelector('.scanned-page-label');
      if (label) label.style.display = 'none';
      div.appendChild(canvas);
    } catch (err) {
      // Non-fatal, just skip pre-rendering
    }
  }
}

// --- End scanned PDF mode ---

function onPageChange(page, totalPages) {
  updateUI();
  saveCurrentPosition(page, totalPages);
}

function onTypographyChange() {
  if (scannedMode) return; // typography changes don't affect scanned pages
  recalculate();
  updateSettingsUI();
}

function updateUI() {
  const page = getCurrentPage();
  const total = getTotalPages();
  const pct = Math.round(getProgress() * 100);

  // Progress bar
  progressBar.style.width = `${pct}%`;

  // Page info
  pageInfo.textContent = `Page ${page} of ${total}`;
  pctInfo.textContent = `${pct}%`;

  // Slider
  progressSlider.max = total;
  progressSlider.value = page;

  // Bookmark
  updateBookmarkUI();
}

function updateBookmarkUI() {
  const page = getCurrentPage();
  const marked = isBookmarked(page);
  bookmarkIcon.classList.toggle('active', marked);
}

function updateSettingsUI() {
  fontSizeValue.textContent = `${getFontSize()}px`;

  // Font family buttons
  document.querySelectorAll('.font-family-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.family === getFontFamily());
  });

  // Line spacing buttons
  const currentLH = getLineHeight();
  document.querySelectorAll('.line-spacing-btn').forEach(btn => {
    btn.classList.toggle('active', parseFloat(btn.dataset.spacing) === parseFloat(currentLH));
  });

  // Theme swatches
  const currentTheme = getCurrentTheme();
  document.querySelectorAll('.theme-swatch').forEach(swatch => {
    swatch.classList.toggle('active', swatch.dataset.theme === currentTheme);
  });
}

// Chrome (top/bottom bars)
function toggleChrome() {
  chromeVisible = !chromeVisible;
  topBar.classList.toggle('visible', chromeVisible);
  bottomBar.classList.toggle('visible', chromeVisible);

  if (!chromeVisible) {
    hideSettings();
  }
}

function hideChrome() {
  chromeVisible = false;
  topBar.classList.remove('visible');
  bottomBar.classList.remove('visible');
  hideSettings();
}

// Settings panel
function showSettings() {
  settingsVisible = true;
  settingsOverlay.classList.add('visible');
  settingsPanel.classList.add('visible');
}

function hideSettings() {
  settingsVisible = false;
  settingsOverlay.classList.remove('visible');
  settingsPanel.classList.remove('visible');
}

function toggleSettings() {
  if (settingsVisible) {
    hideSettings();
  } else {
    showSettings();
  }
}

// Wire up all control event listeners
function wireControls() {
  // Back button
  backBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.location.href = 'index.html';
  });

  // Bookmark button
  bookmarkBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleBookmark(getCurrentPage());
  });

  // Progress slider
  progressSlider.addEventListener('input', (e) => {
    e.stopPropagation();
    const page = parseInt(e.target.value);
    goToPage(page, false);
  });

  // Settings button
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSettings();
  });

  // Settings overlay (tap to close)
  settingsOverlay.addEventListener('click', () => {
    hideSettings();
  });

  // Prevent settings panel taps from closing
  settingsPanel.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // Font size controls
  fontDecrease.addEventListener('click', () => decreaseFontSize());
  fontIncrease.addEventListener('click', () => increaseFontSize());

  // Font family
  document.querySelectorAll('.font-family-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setFontFamily(btn.dataset.family);
    });
  });

  // Line spacing
  document.querySelectorAll('.line-spacing-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setLineHeight(parseFloat(btn.dataset.spacing));
    });
  });

  // Theme swatches
  document.querySelectorAll('.theme-swatch').forEach(swatch => {
    swatch.addEventListener('click', () => {
      setTheme(swatch.dataset.theme);
      updateSettingsUI();
    });
  });
}

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

extractCancel.addEventListener('click', cancelExtraction);
extractCancel.addEventListener('touchstart', (e) => {
  e.preventDefault();
  cancelExtraction();
}, { passive: false });

// Start
init();
