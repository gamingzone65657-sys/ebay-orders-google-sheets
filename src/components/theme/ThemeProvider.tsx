"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemePreference,
} from "@/lib/theme";

export type { ResolvedTheme, ThemePreference };
export { THEME_STORAGE_KEY };

interface ThemeContextValue {
  /** What the user chose, including "system". */
  preference: ThemePreference;
  /** What is actually rendered right now. */
  theme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  toggle: () => void;
  /** False until the client has read localStorage; guards hydration. */
  ready: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // Private mode or blocked storage: fall back to the system preference.
  }
  return "system";
}

/** Applies the class the CSS keys off, and tells the browser to match. */
function applyTheme(theme: ResolvedTheme) {
  const root = document.documentElement;

  // Suppress the cross-fade for this frame so the switch reads as instant.
  root.classList.add("theme-switching");
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;

  window.setTimeout(() => root.classList.remove("theme-switching"), 0);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // The server cannot know the preference, so the first render must match
  // whatever the inline script already put on <html>. Starting from "system"
  // and correcting in an effect keeps the markup identical on both sides.
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [resolved, setResolved] = useState<ResolvedTheme>("light");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = readStoredPreference();
    const next = stored === "system" ? systemTheme() : stored;
    setPreferenceState(stored);
    setResolved(next);
    setReady(true);
    // The inline script already set this; re-applying keeps React's view and
    // the DOM in agreement if storage changed in another tab.
    applyTheme(next);
  }, []);

  // Follow the OS only while the user has not made a choice.
  useEffect(() => {
    if (preference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const next = media.matches ? "dark" : "light";
      setResolved(next);
      applyTheme(next);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  // Keep multiple tabs in step.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      const stored = readStoredPreference();
      const next = stored === "system" ? systemTheme() : stored;
      setPreferenceState(stored);
      setResolved(next);
      applyTheme(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    const effective = next === "system" ? systemTheme() : next;
    setPreferenceState(next);
    setResolved(effective);
    applyTheme(effective);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage unavailable — the theme still applies for this session.
    }
  }, []);

  const toggle = useCallback(() => {
    setPreference(resolved === "dark" ? "light" : "dark");
  }, [resolved, setPreference]);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, theme: resolved, setPreference, toggle, ready }),
    [preference, resolved, setPreference, toggle, ready],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used inside <ThemeProvider>.");
  }
  return context;
}
