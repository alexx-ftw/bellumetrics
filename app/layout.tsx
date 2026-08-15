import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "../components/site-header";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const faviconPath = process.env.GITHUB_PAGES === "1"
  ? "/bellumetrics/favicon.svg"
  : "/favicon.svg";

export const metadata: Metadata = {
  title: "Bellumetrics",
  description: "Military history, measured. Datos, rankings y conexiones entre comandantes históricos.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: faviconPath,
    shortcut: faviconPath,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body className={`${geistSans.variable} antialiased`}>
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}
