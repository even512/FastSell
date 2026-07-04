import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import type { ProcessedPhoto } from "./types";

const MAX_EDGE = 1024; // lange Kante -> begrenzt zugleich die Vision-Tokens
const NEUTRAL_BG = "#f4f1ea"; // ruhiger, neutraler Hintergrund für Freisteller

/**
 * Modell-Dateien von @imgly/background-removal-node liegen in dessen dist/-Ordner. Den Pfad
 * explizit auflösen (statt den fragilen Default der Lib zu nutzen) und vorab prüfen, damit ein
 * fehlendes Modell eine klare Meldung ergibt. (Kein createRequire: das kann Webpack beim
 * Bundlen der Route nicht statisch parsen.)
 */
function imglyPublicPath(): string | undefined {
  const dist = path.join(process.cwd(), "node_modules", "@imgly", "background-removal-node", "dist");
  if (!fs.existsSync(path.join(dist, "resources.json"))) return undefined; // Lib-Default versuchen
  return pathToFileURL(dist + path.sep).href;
}

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
 * Freisteller: Hintergrund entfernen, auf Objekt zuschneiden, auf neutralem Hintergrund platzieren.
 * Wirft bei Fehler (z. B. Modell nicht installiert) – der Aufrufer `cutoutFromDataUrl` fängt das und
 * meldet den Grund an die UI/Diagnose zurück (statt still null zu liefern).
 */
export async function cutoutPhoto(input: Buffer): Promise<Buffer> {
  // Lazy-Import mit statischem Literal: Webpack kann den Import so der serverExternalPackages-
  // Ausnahme zuordnen. Ein variabler `import(modName)` schlug im Produktions-Build zur Laufzeit
  // mit „Cannot find module" fehl (im Dev-Server dagegen nicht).
  const { removeBackground } = (await import("@imgly/background-removal-node")) as unknown as {
    removeBackground: (
      input: Blob,
      config?: { publicPath?: string; model?: "small" | "medium" },
    ) => Promise<Blob>;
  };
  // Ausrichtung vorab normalisieren, damit der Freisteller nicht auf dem Kopf steht.
  const oriented = await sharp(input).rotate().png().toBuffer();
  const model = process.env.FASTSELL_CUTOUT_MODEL === "small" ? "small" : "medium";
  // WICHTIG: als Blob MIT MIME-Type übergeben. Bei einem rohen Buffer erzeugt die Lib intern ein
  // Blob ohne Type und wirft dann „Unsupported format:" – der Freisteller schlug so immer fehl.
  const inputBlob = new Blob([new Uint8Array(oriented)], { type: "image/png" });
  const blob = await removeBackground(inputBlob, { publicPath: imglyPublicPath(), model });
  const png = Buffer.from(await blob.arrayBuffer());

  return sharp(png)
    .trim() // transparenten Rand entfernen -> Auto-Crop aufs Objekt
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: NEUTRAL_BG }) // Transparenz mit neutralem BG füllen
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
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

export interface CutoutResult {
  cutout: string | null; // Freisteller als data-URL, oder null bei Fehlschlag
  reason?: string; // Kurzgrund bei Fehlschlag (für UI + Diagnose)
}

/**
 * Erzeugt den Freisteller für ein bereits optimiertes Foto (data-URL rein). Grundlage der
 * on-demand-Berechnung: der Freisteller wird erst gerechnet, wenn der Nutzer ihn wählt. Wirft nicht –
 * bei fehlendem Modell / Fehler kommt `{ cutout: null, reason }` zurück (Grund landet in der UI).
 */
export async function cutoutFromDataUrl(dataUrl: string): Promise<CutoutResult> {
  const { base64 } = parseDataUrl(dataUrl);
  try {
    const buf = await cutoutPhoto(Buffer.from(base64, "base64"));
    return { cutout: toDataUrl(buf) };
  } catch (err) {
    const message = (err as Error).message || String(err);
    console.warn("[images] Freisteller fehlgeschlagen:", message);
    // Erste NICHT-leere Zeile als Kurzgrund (mehrzeilige Fehler beginnen sonst mit "" in der UI).
    const reason =
      message
        .split("\n")
        .map((l) => l.trim())
        .find(Boolean)
        ?.slice(0, 160) || "Unbekannter Fehler";
    return { cutout: null, reason };
  }
}

/** Zerlegt eine data-URL in mediaType + base64 (für Claude Vision + zum Speichern). */
export function parseDataUrl(dataUrl: string): { mediaType: string; base64: string } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("Ungültige data-URL");
  return { mediaType: match[1], base64: match[2] };
}
