"use client";

import { useEffect } from "react";

// Registriert den Service Worker (PWA-Installierbarkeit + App-Shell-Cache).
export function RegisterSW() {
  useEffect(() => {
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* im Dev nicht kritisch */
      });
    }
  }, []);
  return null;
}
