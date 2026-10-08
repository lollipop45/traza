import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { PwaRegistrar } from "@/components/pwa/PwaRegistrar";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// app/manifest.ts adds <link rel="manifest">. Icons are local static files (public/icons).
export const metadata: Metadata = {
  title: "TRAZA",
  applicationName: "TRAZA",
  description: "Tareas, calendario, proyectos y entregas de la universidad, en un solo lugar.",
  // iPhone/iPad Home Screen app: its own window, titled TRAZA. "default" keeps a normal status bar
  // (dark text on light), so the sand header stays legible; content starts below it.
  appleWebApp: { capable: true, title: "TRAZA", statusBarStyle: "default" },
  formatDetection: { telephone: false },
  // app/favicon.ico is linked automatically by Next.js.
  icons: {
    icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

// viewport-fit=cover lets TRAZA draw under the notch / home indicator; the layout pads with
// env(safe-area-inset-*). Pinch zoom stays enabled (no maximum-scale / user-scalable).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#F4F2ED",
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="es"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-dvh bg-sand font-sans text-charcoal">
        {children}
        <PwaRegistrar />
      </body>
    </html>
  );
}
