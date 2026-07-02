"use client";

import { useState } from "react";
import type { ListingDraft, PriceCheckResult, PriceType } from "@/lib/types";

const euro = (cents: number | null) =>
  cents == null ? "–" : (cents / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" });

export function PriceStep({
  listing,
  priceType,
  onPriceType,
  priceEuros,
  onPriceEuros,
  onBack,
  onNext,
}: {
  listing: ListingDraft;
  priceType: PriceType;
  onPriceType: (t: PriceType) => void;
  priceEuros: number;
  onPriceEuros: (v: number) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [check, setCheck] = useState<PriceCheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runCheck() {
    setBusy(true);
    setError(null);
    try {
      const query = [listing.marke, listing.modell].filter(Boolean).join(" ") || listing.titel;
      const res = await fetch("/api/price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Preis-Check fehlgeschlagen.");
      setCheck(data as PriceCheckResult);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const canContinue = priceType === "FREE" || priceEuros > 0;

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-bold">Preis festlegen</h2>

      <div className="flex overflow-hidden rounded-xl border">
        {(
          [
            ["VB", "VB"],
            ["FIXED", "Festpreis"],
            ["FREE", "Verschenken"],
          ] as [PriceType, string][]
        ).map(([val, label]) => (
          <button
            key={val}
            onClick={() => onPriceType(val)}
            className={`flex-1 py-2 text-sm font-medium ${priceType === val ? "bg-brand text-white" : "bg-white text-gray-600"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {priceType !== "FREE" && (
        <div className="relative">
          <input
            type="number"
            inputMode="decimal"
            min={0}
            value={priceEuros || ""}
            onChange={(e) => onPriceEuros(Number(e.target.value))}
            placeholder="0"
            className="w-full rounded-xl border px-4 py-4 pr-10 text-2xl font-semibold"
          />
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-2xl text-gray-400">€</span>
        </div>
      )}

      {/* Preis-Check */}
      <div className="rounded-xl border bg-white p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-700">Preis-Check</span>
          <button onClick={runCheck} disabled={busy} className="text-sm text-brand disabled:opacity-40">
            {busy ? "Suche …" : "Vergleichen"}
          </button>
        </div>

        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

        {check && (
          <div className="mt-3 space-y-2 text-sm">
            {check.count > 0 ? (
              <>
                <div className="flex justify-between text-gray-600">
                  <span>Spanne ({check.count} Anzeigen)</span>
                  <span className="font-medium text-gray-900">
                    {euro(check.minCents)} – {euro(check.maxCents)}
                  </span>
                </div>
                <div className="flex justify-between text-gray-600">
                  <span>Median</span>
                  <span className="font-medium text-gray-900">{euro(check.medianCents)}</span>
                </div>
                {check.suggestedCents != null && (
                  <button
                    onClick={() => {
                      onPriceEuros(Math.round(check.suggestedCents! / 100));
                      onPriceType(check.suggestedType);
                    }}
                    className="mt-1 w-full rounded-lg bg-brand-light py-2 text-brand-dark"
                  >
                    Vorschlag übernehmen: {euro(check.suggestedCents)} ({check.suggestedType})
                  </button>
                )}
              </>
            ) : (
              <p className="text-gray-500">{check.note || "Keine Vergleichsdaten gefunden."}</p>
            )}
          </div>
        )}
        {!check && !error && (
          <p className="mt-2 text-xs text-gray-400">
            Sucht ähnliche Anzeigen auf Kleinanzeigen und schätzt eine Preisspanne.
          </p>
        )}
      </div>

      <div className="flex gap-3 pt-2">
        <button onClick={onBack} className="rounded-xl border px-5 py-3 font-medium text-gray-600">
          Zurück
        </button>
        <button
          onClick={onNext}
          disabled={!canContinue}
          className="flex-1 rounded-xl bg-brand py-3 font-semibold text-white disabled:opacity-40"
        >
          Anzeige einstellen
        </button>
      </div>
    </div>
  );
}
