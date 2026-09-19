import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "432 Resonance Remote Player",
  description: "Remote player for processed 432 Hz audio from 432 Resonance"
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
