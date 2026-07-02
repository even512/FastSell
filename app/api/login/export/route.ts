import { NextResponse } from "next/server";
import { exportStorageState } from "@/lib/session";

export const runtime = "nodejs";

// Lädt die gespeicherte Session als Datei herunter, um sie auf einen anderen (headless) Rechner
// zu übertragen. Nur sinnvoll auf dem Rechner, auf dem eingeloggt wurde (Bildschirm vorhanden).
export async function GET() {
  const json = await exportStorageState("default");
  if (!json) {
    return NextResponse.json(
      { ok: false, reason: "Kein Login gespeichert – hier ist nichts zu exportieren." },
      { status: 404 },
    );
  }
  return new NextResponse(json, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="fastsell-session.json"',
      "Cache-Control": "no-store",
    },
  });
}
