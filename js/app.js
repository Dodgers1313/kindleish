import { saveBook, getAllBooks, deleteBook, clearBookData, getPosition, savePosition, getBookmarks, saveBookmarks, getLibraryOrder, saveLibraryOrder } from './modules/storage.js';
import { fetchLibrary, pushBookMeta, pushContent, deleteBookRemote, getUser } from './modules/sync.js';

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

const userDialog = document.getElementById('user-dialog');
const userNameInput = document.getElementById('user-name-input');
const userSubmit = document.getElementById('user-submit');
const userError = document.getElementById('user-error');

const userBadge = document.getElementById('user-badge');

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

  const MAX_SIZE = 250 * 1024 * 1024; // 250 MB
  if (file.size > MAX_SIZE) {
    alert(`File too large (${Math.round(file.size / 1024 / 1024)}MB). Maximum is 250MB.`);
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
    pushBookMeta(id, { title, addedAt: book.addedAt, pageCount: 0 });

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
    deleteBookRemote(deleteTargetId);
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

async function mergeWithServer(localBooks) {
  const remoteBooks = await fetchLibrary();
  if (!remoteBooks) return localBooks; // offline — just use local

  const localMap = new Map(localBooks.map(b => [b.id, b]));
  const remoteMap = new Map(remoteBooks.map(b => [b.id, b]));

  // Remote books not in local → create local stubs
  for (const remote of remoteBooks) {
    if (!localMap.has(remote.id)) {
      const stub = {
        id: remote.id,
        title: remote.title,
        addedAt: remote.addedAt || Date.now(),
        pageCount: remote.pageCount || 0,
        blob: null,
        extractedHtml: null
      };
      try { await saveBook(stub); } catch {}
      localBooks.push(stub);

      // Sync position and bookmarks from server
      if (remote.position) savePosition(remote.id, remote.position);
      if (remote.bookmarks) saveBookmarks(remote.id, remote.bookmarks);
    }
  }

  // Local books not on server → either push (new upload) or delete (removed on another device)
  const toRemove = [];
  for (const local of localBooks) {
    if (!remoteMap.has(local.id)) {
      if (local.blob) {
        // Has a blob — freshly uploaded on this device, push to server
        pushBookMeta(local.id, { title: local.title, addedAt: local.addedAt, pageCount: local.pageCount || 0 });
        if (local.extractedHtml) pushContent(local.id, local.extractedHtml);
      } else {
        // No blob — was synced from server, now deleted remotely
        await deleteBook(local.id);
        clearBookData(local.id);
        toRemove.push(local.id);
      }
    }
  }
  if (toRemove.length > 0) {
    localBooks = localBooks.filter(b => !toRemove.includes(b.id));
    const cleanOrder = getLibraryOrder().filter(id => !toRemove.includes(id));
    saveLibraryOrder(cleanOrder);
  }

  // Merge positions — use newer timestamp
  for (const remote of remoteBooks) {
    if (!remote.position || !localMap.has(remote.id)) continue;
    const localPos = getPosition(remote.id);
    if (!localPos || remote.position.timestamp > localPos.timestamp) {
      savePosition(remote.id, remote.position);
    }
  }

  return localBooks;
}

// Render library
async function renderLibrary() {
  const localBooks = (await getAllBooks()).filter(book => {
    const id = String(book.id || '');
    const title = String(book.title || '');
    return !(id.startsWith('server-ocr-') || title.startsWith('Server OCR '));
  });

  // Merge with server library (non-blocking on failure)
  const books = await mergeWithServer(localBooks);

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
  const serverBooks = books.filter(book => {
    const id = String(book.id || '');
    const title = String(book.title || '');
    return id.startsWith('server-ocr-') || title.startsWith('Server OCR ');
  });
  if (serverBooks.length === 0) return;

  for (const book of serverBooks) {
    await deleteBook(book.id);
    clearBookData(book.id);
  }

  const cleanOrder = getLibraryOrder().filter(id => !String(id).startsWith('server-ocr-'));
  saveLibraryOrder(cleanOrder);
}

// Username prompt
function showUserDialog() {
  return new Promise(resolve => {
    userNameInput.value = '';
    userError.style.display = 'none';
    userDialog.classList.remove('hidden');
    userNameInput.focus();

    function submit() {
      const name = userNameInput.value.trim().toLowerCase();
      if (!name) {
        userError.textContent = 'Please enter a name.';
        userError.style.display = '';
        return;
      }
      if (name.length < 2) {
        userError.textContent = 'Name must be at least 2 characters.';
        userError.style.display = '';
        return;
      }
      localStorage.setItem('kindleish:user', name);
      userDialog.classList.add('hidden');
      resolve(name);
    }

    userSubmit.onclick = submit;
    userNameInput.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  });
}

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Show/update user badge
function updateUserBadge() {
  const user = getUser();
  userBadge.textContent = user ? `(${user})` : '';
}

// Tap badge to switch user
userBadge.addEventListener('click', async (e) => {
  e.stopPropagation();
  await showUserDialog();
  updateUserBadge();
  renderLibrary();
});

// Init
if (!getUser()) {
  await showUserDialog();
}
updateUserBadge();
await cleanupServerOcrEntries();
renderLibrary();
