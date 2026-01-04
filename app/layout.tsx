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
    default: "DRESZI — Dress better. Think less.",
    template: "%s — DRESZI",
  },
  description:
    "Personal style intelligence that learns your wardrobe and your rhythm, then gives you clear outfits in seconds.",
  applicationName: "DRESZI",
  alternates: {
    canonical: "/",
  },
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
    url: "/",
    siteName: "DRESZI",
    title: "DRESZI — Dress better. Think less.",
    description:
      "Personal style intelligence that learns your wardrobe and your rhythm, then gives you clear outfits in seconds.",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "DRESZI — Dress better. Think less.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "DRESZI — Dress better. Think less.",
    description:
      "Personal style intelligence that learns your wardrobe and your rhythm, then gives you clear outfits in seconds.",
    images: ["/og.png"],
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
