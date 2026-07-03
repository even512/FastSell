import { NextRequest, NextResponse } from "next/server";
import { cutoutFromDataUrl } from "@/lib/images";

export const runtime = "nodejs";
export const maxDuration = 60;

// Berechnet den Freisteller (Hintergrund entfernen) on-demand für EIN Foto. Wird erst aufgerufen,
// wenn der Nutzer im Review die Freisteller-Variante wählt – so bleibt die Analyse schnell.
export async function POST(req: NextRequest) {
  try {
    const { image } = (await req.json()) as { image?: string };
    if (!image || !image.startsWith("data:")) {
      return NextResponse.json({ error: "Kein Bild übermittelt." }, { status: 400 });
    }
    // cutout ist eine data-URL oder null (Modell nicht verfügbar / Freisteller fehlgeschlagen).
    const cutout = await cutoutFromDataUrl(image);
    return NextResponse.json({ cutout });
  } catch (err) {
    console.error("[cutout]", err);
    // Kein harter Fehler: die UI fällt sauber auf „Optimiert" zurück.
    return NextResponse.json({ cutout: null });
  }
}
