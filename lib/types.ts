// Gemeinsame Typen zwischen Backend und Frontend.

export type PriceType = "FIXED" | "VB" | "FREE";

export interface Attribute {
  label: string;
  wert: string;
}

// Von Claude erzeugter Anzeigen-Entwurf.
export interface ListingDraft {
  titel: string;
  marke: string;
  modell: string;
  kategorie: string;
  zustand: string;
  attribute: Attribute[];
  beschreibung: string;
}

// Ein Foto mit seinen aufbereiteten Varianten (als data-URLs).
export interface ProcessedPhoto {
  optimized: string; // data:image/jpeg;base64,...
  cutout: string | null; // null wenn Freisteller fehlgeschlagen ist
}

// Antwort von /api/analyze
export interface AnalyzeResponse {
  listing: ListingDraft;
  photos: ProcessedPhoto[];
}

// Preis-Check-Ergebnis von /api/price
export interface PriceCheckResult {
  count: number;
  minCents: number | null;
  medianCents: number | null;
  maxCents: number | null;
  suggestedCents: number | null;
  suggestedType: PriceType;
  samples: { title: string; priceCents: number | null; url: string }[];
  note?: string;
}

// Was das Frontend an /api/publish schickt
export interface PublishRequest {
  title: string;
  category: string;
  condition: string;
  description: string;
  attributes: Attribute[];
  priceType: PriceType;
  priceCents: number;
  photos: string[]; // ausgewählte data-URLs (eine pro Foto)
}

// SSE-Event-Payload beim Posten
export interface PublishProgress {
  step: string;
  message: string;
  status: "running" | "done" | "error" | "action_required";
  url?: string;
}
