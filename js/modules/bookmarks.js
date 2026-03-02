import { getBookmarks, saveBookmarks } from './storage.js';

let bookId = null;
let bookmarks = [];
let onChangeCallback = null;

export function initBookmarks(id, onChange) {
  bookId = id;
  onChangeCallback = onChange;
  bookmarks = getBookmarks(id);
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
