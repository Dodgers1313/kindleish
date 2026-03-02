import { getPrefs, savePrefs } from './storage.js';

const FONT_MAP = {
  serif: 'var(--font-serif)',
  sans: 'var(--font-sans)',
  mono: 'var(--font-mono)'
};

const MIN_FONT_SIZE = 14;
const MAX_FONT_SIZE = 32;
const FONT_STEP = 2;

let onChangeCallback = null;

export function initTypography(onChange) {
  onChangeCallback = onChange;
  restorePrefs();
}

export function setFontSize(size) {
  size = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size));
  document.documentElement.style.setProperty('--font-size', `${size}px`);
  const prefs = getPrefs();
  prefs.fontSize = size;
  savePrefs(prefs);
  onChangeCallback?.();
}

export function increaseFontSize() {
  const prefs = getPrefs();
  setFontSize((prefs.fontSize || 18) + FONT_STEP);
}

export function decreaseFontSize() {
  const prefs = getPrefs();
  setFontSize((prefs.fontSize || 18) - FONT_STEP);
}

export function getFontSize() {
  return getPrefs().fontSize || 18;
}

export function setFontFamily(family) {
  if (!FONT_MAP[family]) return;
  document.documentElement.style.setProperty('--font-family', FONT_MAP[family]);
  const prefs = getPrefs();
  prefs.fontFamily = family;
  savePrefs(prefs);
  onChangeCallback?.();
}

export function getFontFamily() {
  return getPrefs().fontFamily || 'serif';
}

export function setLineHeight(lh) {
  document.documentElement.style.setProperty('--line-height', lh);
  const prefs = getPrefs();
  prefs.lineHeight = lh;
  savePrefs(prefs);
  onChangeCallback?.();
}

export function getLineHeight() {
  return getPrefs().lineHeight || 1.6;
}

export function restorePrefs() {
  const prefs = getPrefs();
  document.documentElement.style.setProperty('--font-size', `${prefs.fontSize || 18}px`);
  document.documentElement.style.setProperty('--font-family', FONT_MAP[prefs.fontFamily] || FONT_MAP.serif);
  document.documentElement.style.setProperty('--line-height', prefs.lineHeight || 1.6);
}
