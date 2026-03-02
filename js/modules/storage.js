const DB_NAME = 'kindleish-db';
const DB_VERSION = 1;
const STORE_NAME = 'books';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });

  return dbPromise;
}

export async function saveBook(book) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(book);
    request.onerror = (e) => reject(e.target.error);
    tx.oncomplete = () => resolve(book.id);
    tx.onerror = (e) => reject(e.target.error || new Error('Failed to save book'));
    tx.onabort = () => reject(tx.error || new Error('Book save transaction aborted'));
  });
}

export async function getBook(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

export async function getAllBooks() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

export async function deleteBook(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = (e) => reject(e.target.error);
  });
  // Also clean up localStorage
}

export async function saveExtractedHtml(id, html) {
  const book = await getBook(id);
  if (book) {
    book.extractedHtml = html;
    await saveBook(book);
  }
}

// localStorage helpers
export function getPrefs() {
  try {
    return JSON.parse(localStorage.getItem('kindleish:prefs')) || {
      fontSize: 18,
      fontFamily: 'serif',
      lineHeight: 1.6,
      theme: 'white'
    };
  } catch {
    return { fontSize: 18, fontFamily: 'serif', lineHeight: 1.6, theme: 'white' };
  }
}

export function savePrefs(prefs) {
  localStorage.setItem('kindleish:prefs', JSON.stringify(prefs));
}

export function getPosition(bookId) {
  try {
    return JSON.parse(localStorage.getItem(`kindleish:position:${bookId}`)) || null;
  } catch {
    return null;
  }
}

export function savePosition(bookId, position) {
  localStorage.setItem(`kindleish:position:${bookId}`, JSON.stringify({
    ...position,
    timestamp: Date.now()
  }));
}

export function getBookmarks(bookId) {
  try {
    return JSON.parse(localStorage.getItem(`kindleish:bookmarks:${bookId}`)) || [];
  } catch {
    return [];
  }
}

export function saveBookmarks(bookId, bookmarks) {
  localStorage.setItem(`kindleish:bookmarks:${bookId}`, JSON.stringify(bookmarks));
}

export function getLibraryOrder() {
  try {
    return JSON.parse(localStorage.getItem('kindleish:library-order')) || [];
  } catch {
    return [];
  }
}

export function saveLibraryOrder(order) {
  localStorage.setItem('kindleish:library-order', JSON.stringify(order));
}

export function clearBookData(bookId) {
  localStorage.removeItem(`kindleish:position:${bookId}`);
  localStorage.removeItem(`kindleish:bookmarks:${bookId}`);
  const order = getLibraryOrder().filter(id => id !== bookId);
  saveLibraryOrder(order);
}
