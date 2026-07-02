import { NextResponse } from "next/server";
import { isStorageStateLike, saveStorageState } from "@/lib/session";
import type { LoginResult } from "@/lib/types";

export const runtime = "nodejs";

function bad(reason: string, status = 400): NextResponse {
  const body: LoginResult = { ok: false, reason };
  return NextResponse.json(body, { status });
}

// Nimmt eine per Export erzeugte Session-Datei (Playwright storageState als JSON) entgegen und
// speichert sie serverseitig verschlüsselt. Damit kann ein headless Server posten, ohne dass dort
// je ein sichtbarer Login-Browser laufen muss.
export async function POST(req: Request) {
  try {
    const text = await req.text();
    if (!text.trim()) return bad("Leere Datei erhalten.");
    // Eine Session ist wenige KB groß – so verhindert man eine versehentlich gewählte Riesendatei.
    if (text.length > 5_000_000) {
      return bad("Datei zu groß für eine Session – bitte die exportierte fastsell-session.json wählen.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return bad("Datei ist kein gültiges JSON. Bitte die per Export erzeugte Datei hochladen.");
    }

    if (!isStorageStateLike(parsed)) {
      return bad(
        "Das sieht nicht nach einer FastSell-Session aus (erwartet: Playwright-storageState mit " +
          "einem 'cookies'-Array). Bitte die exportierte fastsell-session.json verwenden.",
      );
    }

    await saveStorageState(parsed, "default");
    const body: LoginResult = { ok: true };
    return NextResponse.json(body);
  } catch (err) {
    return bad((err as Error).message || "Import fehlgeschlagen.", 500);
  }
}
