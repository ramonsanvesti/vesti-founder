import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://www.dresz.io"),
  title: {
    default: "DRESZI — personal style intelligence system",
    template: "%s — DRESZI",
  },
  description:
    "DRESZI is a personal style intelligence system. A guide that brings clarity, intention, and calm to the daily ritual of getting dressed.",
  applicationName: "DRESZI",
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
    },
  },
  openGraph: {
    type: "website",
    url: "https://www.dresz.io/",
    siteName: "DRESZI",
    title: "DRESZI — personal style intelligence system",
    description:
      "DRESZI is a personal style intelligence system. A guide that brings clarity, intention, and calm to the daily ritual of getting dressed.",
  },
  twitter: {
    card: "summary_large_image",
    title: "DRESZI — personal style intelligence system",
    description:
      "DRESZI is a personal style intelligence system. A guide that brings clarity, intention, and calm to the daily ritual of getting dressed.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
