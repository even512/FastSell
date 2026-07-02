"use client";

import type { ListingDraft, ProcessedPhoto } from "@/lib/types";

type VariantChoice = "optimized" | "cutout";

const CONDITIONS = ["Neu", "Sehr gut", "Gut", "In Ordnung", "Defekt"];

export function ReviewStep({
  photos,
  variant,
  onVariant,
  listing,
  onListing,
  onBack,
  onNext,
}: {
  photos: ProcessedPhoto[];
  variant: VariantChoice[];
  onVariant: (index: number, v: VariantChoice) => void;
  listing: ListingDraft;
  onListing: (next: ListingDraft) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  function patch(p: Partial<ListingDraft>) {
    onListing({ ...listing, ...p });
  }

  function setAttr(i: number, key: "label" | "wert", value: string) {
    const attribute = listing.attribute.map((a, idx) => (idx === i ? { ...a, [key]: value } : a));
    patch({ attribute });
  }

  function removeAttr(i: number) {
    patch({ attribute: listing.attribute.filter((_, idx) => idx !== i) });
  }

  function addAttr() {
    patch({ attribute: [...listing.attribute, { label: "", wert: "" }] });
  }

  return (
    <div className="space-y-5">
      {/* Fotos + Variantenwahl */}
      <div>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">Fotos</h2>
        <div className="grid grid-cols-2 gap-3">
          {photos.map((p, i) => {
            const src = variant[i] === "cutout" && p.cutout ? p.cutout : p.optimized;
            return (
              <div key={i} className="space-y-1">
                <div className="aspect-square overflow-hidden rounded-lg border bg-white">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={src} alt="" className="h-full w-full object-contain" />
                </div>
                <div className="flex overflow-hidden rounded-md border text-xs">
                  <button
                    onClick={() => onVariant(i, "optimized")}
                    className={`flex-1 py-1 ${variant[i] === "optimized" ? "bg-brand text-white" : "bg-white text-gray-600"}`}
                  >
                    Optimiert
                  </button>
                  <button
                    onClick={() => p.cutout && onVariant(i, "cutout")}
                    disabled={!p.cutout}
                    className={`flex-1 py-1 ${
                      variant[i] === "cutout"
                        ? "bg-brand text-white"
                        : p.cutout
                          ? "bg-white text-gray-600"
                          : "cursor-not-allowed bg-gray-100 text-gray-300"
                    }`}
                  >
                    Freisteller
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {photos.every((p) => !p.cutout) && (
          <p className="mt-1 text-[11px] text-gray-400">
            Freisteller hier nicht verfügbar (Hintergrund-Modell nicht installiert) – es wird die
            optimierte Variante verwendet.
          </p>
        )}
      </div>

      {/* Anzeigenfelder */}
      <Field label="Titel">
        <input
          value={listing.titel}
          onChange={(e) => patch({ titel: e.target.value })}
          className="w-full rounded-lg border px-3 py-2"
          maxLength={70}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Kategorie">
          <input
            value={listing.kategorie}
            onChange={(e) => patch({ kategorie: e.target.value })}
            className="w-full rounded-lg border px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Zustand">
          <select
            value={listing.zustand}
            onChange={(e) => patch({ zustand: e.target.value })}
            className="w-full rounded-lg border bg-white px-3 py-2 text-sm"
          >
            {CONDITIONS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Beschreibung">
        <textarea
          value={listing.beschreibung}
          onChange={(e) => patch({ beschreibung: e.target.value })}
          rows={7}
          className="w-full rounded-lg border px-3 py-2 text-sm leading-relaxed"
        />
      </Field>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-700">Merkmale</span>
          <button onClick={addAttr} className="text-xs text-brand">
            + hinzufügen
          </button>
        </div>
        <div className="space-y-2">
          {listing.attribute.map((a, i) => (
            <div key={i} className="flex gap-2">
              <input
                value={a.label}
                onChange={(e) => setAttr(i, "label", e.target.value)}
                placeholder="Merkmal"
                className="w-1/3 rounded-lg border px-2 py-1 text-sm"
              />
              <input
                value={a.wert}
                onChange={(e) => setAttr(i, "wert", e.target.value)}
                placeholder="Wert"
                className="flex-1 rounded-lg border px-2 py-1 text-sm"
              />
              <button onClick={() => removeAttr(i)} className="px-1 text-gray-400" aria-label="Entfernen">
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-3 pt-2">
        <button onClick={onBack} className="rounded-xl border px-5 py-3 font-medium text-gray-600">
          Zurück
        </button>
        <button
          onClick={onNext}
          disabled={!listing.titel.trim()}
          className="flex-1 rounded-xl bg-brand py-3 font-semibold text-white disabled:opacity-40"
        >
          Weiter zum Preis
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold text-gray-700">{label}</span>
      {children}
    </label>
  );
}
