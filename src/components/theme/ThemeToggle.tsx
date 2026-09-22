"use client";

import clsx from "clsx";
import { Moon, Sun } from "lucide-react";

import { useTheme } from "./ThemeProvider";

/**
 * Sun/Moon toggle.
 *
 * Until the client has read localStorage the button renders in a neutral
 * state with no icon swap, because guessing would either mismatch hydration
 * or flash the wrong glyph for a frame.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle, ready } = useTheme();
  const goingDark = theme !== "dark";
  const label = goingDark ? "Switch to dark mode" : "Switch to light mode";

  return (
    <button
      type="button"
      onClick={toggle}
      title={label}
      aria-label={label}
      // Exposes the state to assistive tech, not just the label.
      aria-pressed={theme === "dark"}
      className={clsx(
        "inline-flex h-9 w-9 items-center justify-center rounded-md border",
        "border-border bg-card text-muted-foreground",
        "transition-colors hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      {/* Both icons are rendered and cross-faded, so the button never changes
          size and there is no layout shift on toggle. */}
      <span className="relative block h-4 w-4" aria-hidden="true">
        <Sun
          className={clsx(
            "absolute inset-0 h-4 w-4 transition-opacity duration-150",
            ready && theme === "dark" ? "opacity-100" : "opacity-0",
          )}
        />
        <Moon
          className={clsx(
            "absolute inset-0 h-4 w-4 transition-opacity duration-150",
            ready && theme !== "dark" ? "opacity-100" : "opacity-0",
          )}
        />
      </span>
    </button>
  );
}
