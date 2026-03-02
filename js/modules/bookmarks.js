import { getBookmarks, saveBookmarks } from './storage.js';
import { fetchBookmarks, pushBookmarks } from './sync.js';

let bookId = null;
let bookmarks = [];
let onChangeCallback = null;

export function initBookmarks(id, onChange) {
  bookId = id;
  onChangeCallback = onChange;
  bookmarks = getBookmarks(id);

  // Async merge with server
  fetchBookmarks(id).then(remote => {
    if (!remote || !remote.length) return;
    const merged = mergeBookmarks(bookmarks, remote);
    if (JSON.stringify(merged) !== JSON.stringify(bookmarks)) {
      bookmarks = merged;
      saveBookmarks(bookId, bookmarks);
      onChangeCallback?.();
    }
  });
}

function mergeBookmarks(local, remote) {
  const map = new Map();
  for (const b of local) map.set(b.page, b);
  for (const b of remote) {
    const existing = map.get(b.page);
    if (!existing || (b.timestamp || 0) > (existing.timestamp || 0)) {
      map.set(b.page, b);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.page - b.page);
}

export function toggleBookmark(page) {
  const idx = bookmarks.findIndex(b => b.page === page);
  if (idx >= 0) {
    bookmarks.splice(idx, 1);
  } else {
    bookmarks.push({ page, timestamp: Date.now() });
    bookmarks.sort((a, b) => a.page - b.page);
  }
  saveBookmarks(bookId, bookmarks);
  pushBookmarks(bookId, bookmarks);
  onChangeCallback?.();
  return isBookmarked(page);
}

export function isBookmarked(page) {
  return bookmarks.some(b => b.page === page);
}

export function getAllBookmarks() {
  return [...bookmarks];
}

export function getBookmarkCount() {
  return bookmarks.length;
}
