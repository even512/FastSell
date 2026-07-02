import { NextRequest, NextResponse } from "next/server";
import { parseDataUrl, processPhotos } from "@/lib/images";
import { generateListing } from "@/lib/listing";

export const runtime = "nodejs";
export const maxDuration = 120;

// Nimmt 1–3 Fotos entgegen, erzeugt beide Bildvarianten und einen Anzeigen-Entwurf.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const files = form.getAll("photos").filter((f): f is File => f instanceof File);
    if (files.length === 0) {
      return NextResponse.json({ error: "Keine Fotos übermittelt." }, { status: 400 });
    }
    if (files.length > 5) {
      return NextResponse.json({ error: "Bitte höchstens 5 Fotos." }, { status: 400 });
    }

    const buffers = await Promise.all(
      files.map(async (f) => Buffer.from(await f.arrayBuffer())),
    );

    // Beide Varianten erzeugen (optimiert + Freisteller, falls verfügbar).
    const photos = await processPhotos(buffers);

    // Für die Erkennung die optimierten (heruntergerechneten) Bilder nutzen -> spart Tokens.
    const images = photos.map((p) => parseDataUrl(p.optimized));

    const listing = await generateListing(images);
    return NextResponse.json({ listing, photos });
  } catch (err) {
    console.error("[analyze]", err);
    return NextResponse.json(
      { error: (err as Error).message || "Analyse fehlgeschlagen." },
      { status: 500 },
    );
  }
}
