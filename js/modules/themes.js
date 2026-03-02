import { getPrefs, savePrefs } from './storage.js';

const THEMES = ['white', 'sepia', 'dark'];

const THEME_COLORS = {
  white: '#ffffff',
  sepia: '#f4ecd8',
  dark: '#121212'
};

export function setTheme(theme) {
  if (!THEMES.includes(theme)) return;

  // Remove existing theme classes
  document.body.classList.remove(...THEMES.map(t => `theme-${t}`));
  document.body.classList.add(`theme-${theme}`);

  // Update meta theme-color for browser chrome
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.content = THEME_COLORS[theme];
  }

  // Save preference
  const prefs = getPrefs();
  prefs.theme = theme;
  savePrefs(prefs);
}

export function getCurrentTheme() {
  return getPrefs().theme || 'white';
}

export function restoreTheme() {
  const theme = getCurrentTheme();
  setTheme(theme);
}
