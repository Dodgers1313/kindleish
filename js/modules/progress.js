import { getPosition, savePosition as storeSavePosition } from './storage.js';

let bookId = null;

export function initProgress(id) {
  bookId = id;
}

export function saveCurrentPosition(page, totalPages) {
  if (!bookId) return;
  const percentage = totalPages > 1 ? (page - 1) / (totalPages - 1) : 1;
  storeSavePosition(bookId, { page, totalPages, percentage });
}

export function restorePosition(id, totalPages) {
  const pos = getPosition(id);
  if (!pos) return 1;

  // Use percentage to handle different page counts (font size / screen changes)
  if (pos.percentage !== undefined) {
    return Math.max(1, Math.round(pos.percentage * (totalPages - 1)) + 1);
  }

  // Fallback to raw page number
  return Math.min(pos.page || 1, totalPages);
}
