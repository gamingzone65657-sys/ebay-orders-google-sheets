/**
 * Theme constants shared by the server layout and the client provider.
 *
 * Deliberately not marked "use client": every export of a client module
 * becomes a client reference, so reading this key from the server component
 * that builds the pre-paint script would yield a proxy rather than a string.
 */

export const THEME_STORAGE_KEY = "ebs-theme";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/**
 * Runs before the browser paints, so the first frame is already the right
 * theme. React cannot do this job: the server has no access to localStorage,
 * so a provider-only implementation renders light and corrects itself after
 * hydration — a visible flash on every load for dark-mode users.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var k=${JSON.stringify(
  THEME_STORAGE_KEY,
)};var s=localStorage.getItem(k);var d=s==='dark'||((s===null||s==='system')&&window.matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.classList.toggle('dark',d);r.style.colorScheme=d?'dark':'light';}catch(e){}})();`;
