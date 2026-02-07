import type { Metadata } from "next";
import { Space_Grotesk, Bebas_Neue } from "next/font/google";
import "./globals.css";

const space = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-sans",
  weight: ["400", "500", "600", "700"]
});

const bebas = Bebas_Neue({
  subsets: ["latin"],
  variable: "--font-display",
  weight: "400"
});

export const metadata: Metadata = {
  title: "F*ck Botters",
  description:
    "Real-time Twitch chat and viewer analytics to spot suspicious activity fast.",
  keywords: [
    "Twitch analytics",
    "viewer bot detection",
    "chat analytics",
    "live viewers",
    "stream health"
  ],
  openGraph: {
    title: "F*ck Botters",
    description:
      "Real-time Twitch chat and viewer analytics to spot suspicious activity fast.",
    type: "website"
  },
  twitter: {
    card: "summary",
    title: "F*ck Botters",
    description:
      "Real-time Twitch chat and viewer analytics to spot suspicious activity fast."
  },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }]
  }
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${space.variable} ${bebas.variable}`}>
      <body>{children}</body>
    </html>
  );
}
