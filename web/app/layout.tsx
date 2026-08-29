// @ts-nocheck
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";

import "./globals.css";

import { AppShell } from "@/components/app-shell";
import { ThemeProvider } from "@/components/theme-provider";
import { NotificationProvider } from "@/components/notification-provider";

export const metadata = {
  title: "OWC — Operator Console",
  description: "Agent pipeline observability console for Open Web Catcher.",
  icons: {
    icon: [
      {
        url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' fill='none'%3E%3Cpath d='M16 3.5L26.5 9.25L26.5 22.75L16 28.5L5.5 22.75L5.5 9.25Z' stroke='%23c9a84c' stroke-width='1.35' stroke-linejoin='round' opacity='0.9'/%3E%3Cpath d='M16 9.5L21 12.25L21 19.75L16 22.5L11 19.75L11 12.25Z' stroke='%23c9a84c' stroke-width='1.1' stroke-linejoin='round' opacity='0.55'/%3E%3Cpath d='M3 16H9' stroke='%23c9a84c' stroke-width='1.6' stroke-linecap='round'/%3E%3Cpath d='M23 16H29' stroke='%23c9a84c' stroke-width='1.6' stroke-linecap='round'/%3E%3Ccircle cx='16' cy='16' r='2.1' fill='%23c9a84c'/%3E%3C/svg%3E",
        type: "image/svg+xml",
      },
    ],
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${GeistSans.variable} ${GeistMono.variable} font-sans antialiased`}>
        <ThemeProvider>
          <NotificationProvider>
            <AppShell>{children}</AppShell>
          </NotificationProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
