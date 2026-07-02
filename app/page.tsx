"use client";

import { useState } from "react";
import { CaptureStep } from "@/components/CaptureStep";
import { HistoryList } from "@/components/HistoryList";
import { PriceStep } from "@/components/PriceStep";
import { PublishStep } from "@/components/PublishStep";
import { ReviewStep } from "@/components/ReviewStep";
import type {
  AnalyzeResponse,
  ListingDraft,
  PriceType,
  ProcessedPhoto,
  PublishRequest,
} from "@/lib/types";

type Step = "capture" | "review" | "price" | "publish";
type VariantChoice = "optimized" | "cutout";

const STEPS: { key: Step; label: string }[] = [
  { key: "capture", label: "Fotos" },
  { key: "review", label: "Anzeige" },
  { key: "price", label: "Preis" },
  { key: "publish", label: "Einstellen" },
];

export default function Home() {
  const [step, setStep] = useState<Step>("capture");
  const [photos, setPhotos] = useState<ProcessedPhoto[]>([]);
  const [variant, setVariant] = useState<VariantChoice[]>([]);
  const [listing, setListing] = useState<ListingDraft | null>(null);
  const [priceType, setPriceType] = useState<PriceType>("VB");
  const [priceEuros, setPriceEuros] = useState<number>(0);
  const [showHistory, setShowHistory] = useState(false);

  function onAnalyzed(res: AnalyzeResponse) {
    setPhotos(res.photos);
    setVariant(res.photos.map((p) => (p.cutout ? "cutout" : "optimized")));
    setListing(res.listing);
    setStep("review");
  }

  function reset() {
    setPhotos([]);
    setVariant([]);
    setListing(null);
    setPriceType("VB");
    setPriceEuros(0);
    setStep("capture");
  }

  function chosenPhotos(): string[] {
    return photos.map((p, i) => (variant[i] === "cutout" && p.cutout ? p.cutout : p.optimized));
  }

  function buildRequest(): PublishRequest {
    if (!listing) throw new Error("Kein Entwurf.");
    return {
      title: listing.titel,
      category: listing.kategorie,
      condition: listing.zustand,
      description: listing.beschreibung,
      attributes: listing.attribute,
      priceType,
      priceCents: Math.round(priceEuros * 100),
      photos: chosenPhotos(),
    };
  }

  const activeIndex = STEPS.findIndex((s) => s.key === step);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col bg-gray-50">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b bg-white px-4 py-3">
        <button onClick={reset} className="flex items-center gap-2 font-bold text-brand">
          <img src="/icon.svg" alt="" className="h-7 w-7" />
          FastSell
        </button>
        <button
          onClick={() => setShowHistory((v) => !v)}
          className="rounded-full px-3 py-1 text-sm text-gray-600 hover:bg-gray-100"
        >
          {showHistory ? "Zurück" : "Historie"}
        </button>
      </header>

      {showHistory ? (
        <HistoryList />
      ) : (
        <>
          {/* Fortschrittsanzeige */}
          <nav className="flex items-center justify-between px-4 py-3 text-xs">
            {STEPS.map((s, i) => (
              <div key={s.key} className="flex flex-1 items-center">
                <div
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ${
                    i <= activeIndex ? "bg-brand text-white" : "bg-gray-200 text-gray-500"
                  }`}
                >
                  {i + 1}
                </div>
                <span className={`ml-1 ${i === activeIndex ? "font-semibold text-brand" : "text-gray-400"}`}>
                  {s.label}
                </span>
                {i < STEPS.length - 1 && <div className="mx-1 h-px flex-1 bg-gray-200" />}
              </div>
            ))}
          </nav>

          <div className="flex-1 px-4 pb-8">
            {step === "capture" && <CaptureStep onAnalyzed={onAnalyzed} />}

            {step === "review" && listing && (
              <ReviewStep
                photos={photos}
                variant={variant}
                onVariant={(i, v) => setVariant((arr) => arr.map((x, idx) => (idx === i ? v : x)))}
                listing={listing}
                onListing={setListing}
                onBack={reset}
                onNext={() => setStep("price")}
              />
            )}

            {step === "price" && listing && (
              <PriceStep
                listing={listing}
                priceType={priceType}
                onPriceType={setPriceType}
                priceEuros={priceEuros}
                onPriceEuros={setPriceEuros}
                onBack={() => setStep("review")}
                onNext={() => setStep("publish")}
              />
            )}

            {step === "publish" && listing && (
              <PublishStep buildRequest={buildRequest} onNext={reset} onBack={() => setStep("price")} />
            )}
          </div>
        </>
      )}
    </main>
  );
}
