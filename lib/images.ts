import sharp from "sharp";
import type { ProcessedPhoto } from "./types";

const MAX_EDGE = 1024; // lange Kante -> begrenzt zugleich die Vision-Tokens
const NEUTRAL_BG = "#f4f1ea"; // ruhiger, neutraler Hintergrund für Freisteller

/**
 * Leichte Optimierung: EXIF-Ausrichtung, Downscale, Belichtung/Weißabgleich.
 * Original-Hintergrund bleibt erhalten (wirkt authentisch/privat).
 */
export async function optimizePhoto(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .rotate() // Auto-Orient anhand EXIF
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .modulate({ brightness: 1.03, saturation: 1.04 })
    .normalize() // Kontrast/Belichtung strecken
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
}

/**
 * Freisteller: Hintergrund entfernen, auf Objekt zuschneiden, auf neutralem
 * Hintergrund platzieren. Best-effort – wirft nicht, gibt bei Fehler null zurück.
 */
export async function cutoutPhoto(input: Buffer): Promise<Buffer | null> {
  try {
    // Lazy-Import: großes Modell wird nur geladen, wenn wirklich gebraucht.
    // Nicht-literaler Specifier -> optionales Paket, TS erzwingt es nicht zur Build-Zeit.
    const modName = "@imgly/background-removal-node";
    const { removeBackground } = (await import(modName)) as {
      removeBackground: (input: Buffer) => Promise<Blob>;
    };
    // Ausrichtung vorab normalisieren, damit der Freisteller nicht auf dem Kopf steht.
    const oriented = await sharp(input).rotate().png().toBuffer();
    const blob = await removeBackground(oriented);
    const png = Buffer.from(await blob.arrayBuffer());

    return await sharp(png)
      .trim() // transparenten Rand entfernen -> Auto-Crop aufs Objekt
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .flatten({ background: NEUTRAL_BG }) // Transparenz mit neutralem BG füllen
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
  } catch (err) {
    console.warn("[images] Freisteller fehlgeschlagen:", (err as Error).message);
    return null;
  }
}

function toDataUrl(buf: Buffer): string {
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

/**
 * Verarbeitet ein Foto zur optimierten Variante (als data-URL für die UI). Der Freisteller wird
 * NICHT mehr eager berechnet (spart CPU/Zeit auf dem Server) – er entsteht on-demand über
 * `cutoutFromDataUrl` bzw. die Route `/api/cutout`, sobald der Nutzer die Variante wählt.
 */
export async function processPhoto(input: Buffer): Promise<ProcessedPhoto> {
  const optimized = await optimizePhoto(input);
  return { optimized: toDataUrl(optimized), cutout: null };
}

/**
 * Verarbeitet mehrere Fotos parallel.
 */
export async function processPhotos(inputs: Buffer[]): Promise<ProcessedPhoto[]> {
  return Promise.all(inputs.map(processPhoto));
}

/**
 * Erzeugt den Freisteller für ein bereits optimiertes Foto (data-URL rein, data-URL oder null raus).
 * Grundlage der on-demand-Berechnung: der Freisteller wird erst gerechnet, wenn der Nutzer ihn wählt.
 * Wirft nicht – bei fehlendem Modell / Fehler liefert `cutoutPhoto` null zurück.
 */
export async function cutoutFromDataUrl(dataUrl: string): Promise<string | null> {
  const { base64 } = parseDataUrl(dataUrl);
  const cutout = await cutoutPhoto(Buffer.from(base64, "base64"));
  return cutout ? toDataUrl(cutout) : null;
}

/** Zerlegt eine data-URL in mediaType + base64 (für Claude Vision + zum Speichern). */
export function parseDataUrl(dataUrl: string): { mediaType: string; base64: string } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("Ungültige data-URL");
  return { mediaType: match[1], base64: match[2] };
}
