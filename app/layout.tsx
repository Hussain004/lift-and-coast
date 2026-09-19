import type { Metadata } from "next";
import { Archivo, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Display face for the hero and section headings: a tight, italic grotesk
// with a motorsport-poster voice. Body and data keep Geist Sans/Mono so
// the HUD-adjacent panels stay legible at small sizes.
const display = Archivo({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["600", "700", "800", "900"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "LIFT & COAST",
  description: "A 2026-regulation formula racing game for the browser.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${display.variable}`}>
      <body>{children}</body>
    </html>
  );
}
