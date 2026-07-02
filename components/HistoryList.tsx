"use client";

import { useEffect, useState } from "react";
import type { Listing } from "@/lib/store";

const euro = (cents: number) =>
  (cents / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" });

const STATUS: Record<Listing["status"], { label: string; cls: string }> = {
  draft: { label: "Entwurf", cls: "bg-gray-100 text-gray-600" },
  publishing: { label: "läuft …", cls: "bg-amber-100 text-amber-700" },
  published: { label: "online", cls: "bg-brand-light text-brand-dark" },
  error: { label: "Fehler", cls: "bg-red-100 text-red-700" },
};

export function HistoryList() {
  const [listings, setListings] = useState<Listing[] | null>(null);

  useEffect(() => {
    fetch("/api/listings")
      .then((r) => r.json())
      .then((d) => setListings(d.listings ?? []))
      .catch(() => setListings([]));
  }, []);

  if (listings === null) return <p className="p-6 text-center text-sm text-gray-400">Lade …</p>;
  if (listings.length === 0)
    return <p className="p-6 text-center text-sm text-gray-400">Noch keine Anzeigen eingestellt.</p>;

  return (
    <ul className="divide-y">
      {listings.map((l) => {
        const s = STATUS[l.status];
        return (
          <li key={l.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate font-medium">{l.title}</p>
              <p className="text-xs text-gray-500">
                {l.priceType === "FREE" ? "Verschenken" : `${euro(l.priceCents)} ${l.priceType}`} ·{" "}
                {new Date(l.createdAt).toLocaleDateString("de-DE")}
              </p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${s.cls}`}>
                {s.label}
              </span>
              {l.kleinanzeigenUrl && (
                <a
                  href={l.kleinanzeigenUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-brand underline"
                >
                  öffnen
                </a>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
