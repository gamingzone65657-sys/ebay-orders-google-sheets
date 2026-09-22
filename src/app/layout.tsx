import type { Metadata } from "next";

import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "eBay → Google Sheets Automation",
    template: "%s · eBay → Google Sheets",
  },
  description:
    "Import eBay orders into a Google Sheet with configurable field mappings and scheduled syncs.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // The init script mutates <html> before React hydrates, so the class and
    // style attributes legitimately differ from the server-rendered output.
    <html lang="en" suppressHydrationWarning>
      <body className="bg-background text-foreground">
        {/* First node in <body> so it executes before anything below it is
            painted. A hand-authored <head> is not preserved by the App
            Router, and next/script cannot run this early. */}
        <script
          id="theme-init"
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
