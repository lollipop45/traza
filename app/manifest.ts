import type { MetadataRoute } from "next";

// The installable-app description of TRAZA (served at /manifest.webmanifest, public: the install
// flow may start before signing in). Local, static icons only (public/icons, generated from the
// official mark public/brand/traza-mark.svg by scripts/generate-icons.mjs). No orientation lock: TRAZA also runs on tablets and
// desktops, and landscape must keep working.

const PWA_BACKGROUND = "#F4F2ED";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "TRAZA",
    short_name: "TRAZA",
    description: "Tareas, calendario, proyectos y entregas de la universidad, en un solo lugar.",
    lang: "es",
    dir: "ltr",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: PWA_BACKGROUND,
    theme_color: PWA_BACKGROUND,
    categories: ["productivity", "education"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
