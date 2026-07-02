"use client";

import { useRef, useState } from "react";
import type { AnalyzeResponse } from "@/lib/types";

export function CaptureStep({ onAnalyzed }: { onAnalyzed: (res: AnalyzeResponse) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function addFiles(list: FileList | null) {
    if (!list) return;
    const next = [...files, ...Array.from(list)].slice(0, 5);
    setFiles(next);
    setError(null);
  }

  function removeAt(i: number) {
    setFiles((f) => f.filter((_, idx) => idx !== i));
  }

  async function analyze() {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append("photos", f));
      const res = await fetch("/api/analyze", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analyse fehlgeschlagen.");
      onAnalyzed(data as AnalyzeResponse);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="text-center">
        <h1 className="text-xl font-bold">Artikel fotografieren</h1>
        <p className="mt-1 text-sm text-gray-500">
          2–3 Fotos aus verschiedenen Blickwinkeln reichen. Die App erkennt das Produkt und
          schreibt die Anzeige.
        </p>
      </div>

      {files.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {files.map((f, i) => (
            <div key={i} className="relative aspect-square overflow-hidden rounded-lg border bg-white">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={URL.createObjectURL(f)} alt="" className="h-full w-full object-cover" />
              <button
                onClick={() => removeAt(i)}
                className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-xs text-white"
                aria-label="Entfernen"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="hidden"
        onChange={(e) => addFiles(e.target.files)}
      />

      <button
        onClick={() => inputRef.current?.click()}
        className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 bg-white py-6 text-gray-600"
      >
        <span className="text-2xl">📷</span>
        {files.length === 0 ? "Fotos aufnehmen / auswählen" : "Weitere Fotos hinzufügen"}
      </button>

      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <button
        onClick={analyze}
        disabled={files.length === 0 || busy}
        className="w-full rounded-xl bg-brand py-4 text-center font-semibold text-white disabled:opacity-40"
      >
        {busy ? "Analysiere Fotos …" : `Anzeige erstellen (${files.length})`}
      </button>

      {busy && (
        <p className="text-center text-xs text-gray-400">
          Fotos werden aufbereitet und das Produkt erkannt – einen Moment.
        </p>
      )}
    </div>
  );
}
