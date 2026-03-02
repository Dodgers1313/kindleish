import { startDrag, updateDrag, endDrag } from './paginator.js';

let callbacks = {};
let viewportEl = null;

let pointerStartX = 0;
let pointerStartY = 0;
let pointerStartTime = 0;
let isTracking = false;
let hasMoved = false;
let lastX = 0;
let lastTime = 0;
let velocity = 0;

const SWIPE_THRESHOLD = 30;
const TAP_THRESHOLD = 10;
const LEFT_ZONE = 0.25;
const RIGHT_ZONE = 0.75;

export function initGestures(el, cbs) {
  viewportEl = el;
  callbacks = cbs;

  viewportEl.addEventListener('pointerdown', onPointerDown, { passive: true });
  viewportEl.addEventListener('pointermove', onPointerMove, { passive: true });
  viewportEl.addEventListener('pointerup', onPointerUp, { passive: true });
  viewportEl.addEventListener('pointercancel', onPointerCancel, { passive: true });

  // Prevent context menu on long press
  viewportEl.addEventListener('contextmenu', (e) => e.preventDefault());

  // Keyboard navigation
  document.addEventListener('keydown', onKeyDown);
}

function onPointerDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;

  isTracking = true;
  hasMoved = false;
  pointerStartX = e.clientX;
  pointerStartY = e.clientY;
  pointerStartTime = Date.now();
  lastX = e.clientX;
  lastTime = pointerStartTime;
  velocity = 0;

  startDrag(e.clientX);
}

function onPointerMove(e) {
  if (!isTracking) return;

  const dx = Math.abs(e.clientX - pointerStartX);
  const dy = Math.abs(e.clientY - pointerStartY);

  // If vertical movement is dominant, let the browser scroll
  if (!hasMoved && dy > dx && dy > TAP_THRESHOLD) {
    isTracking = false;
    return;
  }

  if (dx > TAP_THRESHOLD) {
    hasMoved = true;
  }

  // Calculate velocity
  const now = Date.now();
  const dt = now - lastTime;
  if (dt > 0) {
    velocity = (e.clientX - lastX) / dt; // px/ms
  }
  lastX = e.clientX;
  lastTime = now;

  if (hasMoved) {
    updateDrag(e.clientX);
  }
}

function onPointerUp(e) {
  if (!isTracking) return;
  isTracking = false;

  const dx = e.clientX - pointerStartX;
  const dy = e.clientY - pointerStartY;
  const dt = Date.now() - pointerStartTime;

  if (hasMoved) {
    // It was a swipe/drag — let paginator handle it
    endDrag(e.clientX, velocity);
    return;
  }

  // It was a tap
  if (Math.abs(dx) < TAP_THRESHOLD && Math.abs(dy) < TAP_THRESHOLD) {
    const pct = e.clientX / window.innerWidth;

    if (pct < LEFT_ZONE) {
      callbacks.onPrev?.();
    } else if (pct > RIGHT_ZONE) {
      callbacks.onNext?.();
    } else {
      callbacks.onCenterTap?.();
    }
  }
}

function onPointerCancel() {
  if (isTracking) {
    isTracking = false;
    endDrag(lastX, 0);
  }
}

function onKeyDown(e) {
  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      e.preventDefault();
      callbacks.onPrev?.();
      break;
    case 'ArrowRight':
    case 'ArrowDown':
    case ' ':
      e.preventDefault();
      callbacks.onNext?.();
      break;
  }
}

export function destroy() {
  if (viewportEl) {
    viewportEl.removeEventListener('pointerdown', onPointerDown);
    viewportEl.removeEventListener('pointermove', onPointerMove);
    viewportEl.removeEventListener('pointerup', onPointerUp);
    viewportEl.removeEventListener('pointercancel', onPointerCancel);
  }
  document.removeEventListener('keydown', onKeyDown);
}
