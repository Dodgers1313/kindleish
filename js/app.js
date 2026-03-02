import { saveBook, getAllBooks, deleteBook, clearBookData, getPosition, getLibraryOrder, saveLibraryOrder } from './modules/storage.js';

const fileInput = document.getElementById('file-input');
const dropZone = document.getElementById('drop-zone');
const emptyState = document.getElementById('empty-state');
const libraryGrid = document.getElementById('library-grid');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const deleteDialog = document.getElementById('delete-dialog');
const deleteCancel = document.getElementById('delete-cancel');
const deleteConfirm = document.getElementById('delete-confirm');

const settingsLink = document.getElementById('settings-link');
const settingsDialog = document.getElementById('settings-dialog');
const settingsCancel = document.getElementById('settings-cancel');
const settingsSave = document.getElementById('settings-save');
const ocrServerInput = document.getElementById('ocr-server-input');

let deleteTargetId = null;
let longPressTimer = null;

// Cover color palette
const COVER_COLORS = [
  '#1a1a2e', '#16213e', '#0f3460', '#533483',
  '#4a0e4e', '#2c3e50', '#34495e', '#2e4057',
  '#3d405b', '#5f0f40', '#006d77', '#264653',
  '#073b4c', '#582f0e', '#6b4226', '#1b4332'
];

function getCoverColor(title) {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = ((hash << 5) - hash) + title.charCodeAt(i);
    hash |= 0;
  }
  return COVER_COLORS[Math.abs(hash) % COVER_COLORS.length];
}

// Upload handling
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) handleFile(file);
  fileInput.value = '';
});

dropZone?.addEventListener('click', () => fileInput.click());

// Drag and drop
document.body.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone?.classList.add('drag-over');
});

document.body.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget || !document.body.contains(e.relatedTarget)) {
    dropZone?.classList.remove('drag-over');
  }
});

document.body.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone?.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type === 'application/pdf') {
    handleFile(file);
  }
});

function readFileAsArrayBuffer(file) {
  // Use FileReader for maximum mobile compatibility
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function generateId() {
  // Fallback for non-secure contexts where crypto.randomUUID() is unavailable
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

async function handleFile(file) {
  // Check by extension since mobile browsers sometimes report wrong MIME types
  const isPdf = file.type === 'application/pdf' ||
                file.name.toLowerCase().endsWith('.pdf');
  if (!isPdf) {
    alert('Please upload a PDF file.');
    return;
  }

  showLoading('Processing PDF...');

  try {
    const id = generateId();
    const title = file.name.replace(/\.pdf$/i, '');

    // Read file using FileReader (better mobile Safari support than file.arrayBuffer())
    const arrayBuffer = await readFileAsArrayBuffer(file);
    const blob = new Blob([arrayBuffer], { type: 'application/pdf' });

    const book = {
      id,
      title,
      blob,
      addedAt: Date.now(),
      pageCount: 0,
      extractedHtml: null
    };

    await saveBook(book);

    // Update library order
    const order = getLibraryOrder();
    order.unshift(id);
    saveLibraryOrder(order);

    hideLoading();

    // Navigate to reader
    window.location.href = `reader.html?id=${id}`;
  } catch (err) {
    hideLoading();
    console.error('Error saving PDF:', err);
    alert('Error: ' + err.message + '\n\nTry a smaller PDF or reload the page.');
  }
}

// Settings handling
settingsLink.addEventListener('click', () => {
  ocrServerInput.value = localStorage.getItem('kindleish:ocr-server') || '';
  settingsDialog.classList.remove('hidden');
});

settingsCancel.addEventListener('click', () => {
  settingsDialog.classList.add('hidden');
});

settingsSave.addEventListener('click', () => {
  const url = ocrServerInput.value.trim().replace(/\/+$/, '');
  if (url) {
    localStorage.setItem('kindleish:ocr-server', url);
  } else {
    localStorage.removeItem('kindleish:ocr-server');
  }
  settingsDialog.classList.add('hidden');
});

// Delete handling
deleteCancel.addEventListener('click', () => {
  deleteDialog.classList.add('hidden');
  deleteTargetId = null;
});

deleteConfirm.addEventListener('click', async () => {
  if (deleteTargetId) {
    await deleteBook(deleteTargetId);
    clearBookData(deleteTargetId);
    deleteTargetId = null;
    deleteDialog.classList.add('hidden');
    renderLibrary();
  }
});

function showDeleteDialog(bookId) {
  deleteTargetId = bookId;
  deleteDialog.classList.remove('hidden');
}

// Loading
function showLoading(text) {
  loadingText.textContent = text;
  loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
  loadingOverlay.classList.add('hidden');
}

// Render library
async function renderLibrary() {
  const books = await getAllBooks();

  if (books.length === 0) {
    emptyState.classList.remove('hidden');
    libraryGrid.innerHTML = '';
    return;
  }

  emptyState.classList.add('hidden');

  // Sort by last read (most recent first), then by added date
  const order = getLibraryOrder();
  books.sort((a, b) => {
    const aIdx = order.indexOf(a.id);
    const bIdx = order.indexOf(b.id);
    if (aIdx === -1 && bIdx === -1) return b.addedAt - a.addedAt;
    if (aIdx === -1) return 1;
    if (bIdx === -1) return -1;
    return aIdx - bIdx;
  });

  libraryGrid.innerHTML = books.map(book => {
    const position = getPosition(book.id);
    const progress = position ? position.percentage || 0 : 0;
    const progressPercent = Math.round(progress * 100);
    const color = getCoverColor(book.title);
    const lastRead = position ? formatDate(position.timestamp) : formatDate(book.addedAt);

    return `
      <div class="book-card" data-id="${book.id}">
        <div class="book-cover" style="background: ${color}">
          <span class="cover-title">${escapeHtml(book.title)}</span>
          ${progress > 0 ? `<div class="book-progress-bar" style="width: ${progressPercent}%"></div>` : ''}
        </div>
        <div class="book-info">
          <div class="book-title">${escapeHtml(book.title)}</div>
          <div class="book-meta">${progressPercent > 0 ? progressPercent + '%' : ''} ${lastRead}</div>
        </div>
      </div>
    `;
  }).join('');

  // Attach event listeners
  libraryGrid.querySelectorAll('.book-card').forEach(card => {
    const id = card.dataset.id;

    card.addEventListener('click', () => {
      window.location.href = `reader.html?id=${id}`;
    });

    // Long press to delete
    card.addEventListener('pointerdown', (e) => {
      longPressTimer = setTimeout(() => {
        e.preventDefault();
        showDeleteDialog(id);
      }, 600);
    });

    card.addEventListener('pointerup', () => clearTimeout(longPressTimer));
    card.addEventListener('pointerleave', () => clearTimeout(longPressTimer));
    card.addEventListener('pointermove', () => clearTimeout(longPressTimer));
  });
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function cleanupServerOcrEntries() {
  const books = await getAllBooks();
  const serverBooks = books.filter(book => String(book.id || '').startsWith('server-ocr-'));
  if (serverBooks.length === 0) return;

  for (const book of serverBooks) {
    await deleteBook(book.id);
    clearBookData(book.id);
  }

  const cleanOrder = getLibraryOrder().filter(id => !String(id).startsWith('server-ocr-'));
  saveLibraryOrder(cleanOrder);
}

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Init
await cleanupServerOcrEntries();
renderLibrary();
