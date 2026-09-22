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
        {/*
          Sets the theme class on <html> before the first paint, so a dark-mode
          user never sees a white flash. First node in <body>, so it runs
          before anything below it is painted.

          This must stay a bare <script>. React 19 logs a dev-only warning here
          ("Scripts inside React components are never executed when rendering
          on the client"), which is true and harmless: the script only ever
          needs to run once, on the initial server-rendered document, and it
          does. The warning does not appear in a production build.

          next/script with beforeInteractive was tried and is wrong for this —
          it serialises the code into a queue (self.__next_s.push(...)) that
          Next's runtime drains after hydration, which is far too late and
          brings the flash back. Verified by reading the served HTML.
        */}
        <script
          id="theme-init"
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
