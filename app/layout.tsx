import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "432 Resonance Stream Test",
  description: "Minimal WebSocket audio stream test client for 432 Resonance"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
