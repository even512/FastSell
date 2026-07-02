import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FastSell – Kleinanzeigen im Sekundentakt",
    short_name: "FastSell",
    description: "Fotos rein, verkaufsfertige Kleinanzeigen-Anzeige raus.",
    start_url: "/",
    display: "standalone",
    background_color: "#f9fafb",
    theme_color: "#1f7a4d",
    orientation: "portrait",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
