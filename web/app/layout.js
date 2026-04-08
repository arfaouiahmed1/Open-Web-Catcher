import "./globals.css";

import { AppShell } from "@/components/app-shell";

export const metadata = {
  title: "Open Web Catcher Operator Console",
  description: "Node-driven observability and evaluation console for Open Web Catcher."
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
