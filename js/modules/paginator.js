let container = null;
let viewport = null;
let currentPage = 1;
let totalPages = 1;
let pageWidth = 0;
let onPageChange = null;

export function initPaginator(opts = {}) {
  container = document.getElementById('content-container');
  viewport = document.getElementById('viewport');
  onPageChange = opts.onPageChange || null;

  recalculate();

  // Recalculate on resize / orientation change
  window.addEventListener('resize', debounce(() => {
    const savedPct = totalPages > 1 ? (currentPage - 1) / (totalPages - 1) : 0;
    recalculate();
    const newPage = Math.max(1, Math.round(savedPct * (totalPages - 1)) + 1);
    goToPage(newPage, false);
  }, 200));

  return totalPages;
}

export function recalculate() {
  if (!container) return;

  // Save reading position as percentage before repaginating
  const savedPct = totalPages > 1 ? (currentPage - 1) / (totalPages - 1) : 0;

  // Reset transform to measure properly
  container.style.transition = 'none';
  container.style.transform = 'translateX(0)';

  // Force layout
  void container.offsetHeight;

  // With column-gap: 0 and column-width: 100vw, each page = viewport width
  pageWidth = viewport.offsetWidth;
  const scrollW = container.scrollWidth;
  totalPages = Math.max(1, Math.round(scrollW / pageWidth));

  // Restore position by percentage (not raw page number)
  currentPage = Math.max(1, Math.round(savedPct * (totalPages - 1)) + 1);
  if (currentPage > totalPages) currentPage = totalPages;

  // Re-enable transition and go to restored page
  requestAnimationFrame(() => {
    container.style.transition = '';
    goToPage(currentPage, false);
  });
}

export function goToPage(page, animate = true) {
  if (!container) return;
  if (page < 1 || page > totalPages) return;

  currentPage = page;
  const offset = (page - 1) * pageWidth;

  if (!animate) {
    container.style.transition = 'none';
  }

  container.style.transform = `translateX(-${offset}px)`;

  if (!animate) {
    void container.offsetHeight;
    requestAnimationFrame(() => {
      container.style.transition = '';
    });
  }

  if (onPageChange) {
    onPageChange(currentPage, totalPages);
  }
}

export function nextPage() {
  if (currentPage < totalPages) {
    goToPage(currentPage + 1);
    return true;
  }
  return false;
}

export function prevPage() {
  if (currentPage > 1) {
    goToPage(currentPage - 1);
    return true;
  }
  return false;
}

export function getCurrentPage() {
  return currentPage;
}

export function getTotalPages() {
  return totalPages;
}

export function getProgress() {
  if (totalPages <= 1) return 1;
  return (currentPage - 1) / (totalPages - 1);
}

// Drag support for follow-the-finger page turning
let dragStartX = 0;
let dragOffset = 0;
let isDragging = false;

export function startDrag(x) {
  isDragging = true;
  dragStartX = x;
  dragOffset = (currentPage - 1) * pageWidth;
  container.style.transition = 'none';
}

export function updateDrag(x) {
  if (!isDragging) return;
  const dx = x - dragStartX;
  const newOffset = dragOffset - dx;
  container.style.transform = `translateX(-${newOffset}px)`;
}

export function endDrag(x, velocity) {
  if (!isDragging) return;
  isDragging = false;

  const dx = x - dragStartX;
  const threshold = pageWidth * 0.2;

  container.style.transition = '';

  // Determine if we should turn the page
  if (dx < -threshold || velocity < -0.5) {
    nextPage();
  } else if (dx > threshold || velocity > 0.5) {
    prevPage();
  } else {
    // Snap back
    goToPage(currentPage);
  }
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
