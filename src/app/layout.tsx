import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: { default: "Agents", template: "%s · Agents" }, description: "Control system for AI software development." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
