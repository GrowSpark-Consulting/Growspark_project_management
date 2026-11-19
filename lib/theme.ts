/**
 * Light / Dark / System theme (Grow Spark Workspace design system).
 * The theme is set on <html data-theme="light|dark">; every token switches automatically.
 * The choice is remembered in this browser (localStorage).
 */

export type ThemeChoice = 'light' | 'dark' | 'system';
export const THEME_STORAGE_KEY = 'gs-theme';

/** Runs in <head> before first paint so there is no flash of the wrong theme. */
export const THEME_INIT_SCRIPT = `(function(){try{var c=localStorage.getItem('${THEME_STORAGE_KEY}');var d=c==='dark'||((c===null||c==='system')&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light');}catch(e){}})();`;

export function readThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyThemeChoice(choice: ThemeChoice) {
  try {
    if (choice === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // storage blocked: still apply for this page view
  }
  document.documentElement.setAttribute('data-theme', resolveTheme(choice));
}
