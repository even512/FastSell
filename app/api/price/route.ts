import { NextRequest, NextResponse } from "next/server";
import { checkPrice } from "@/lib/price";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { query } = (await req.json()) as { query?: string };
    if (!query || !query.trim()) {
      return NextResponse.json({ error: "Kein Suchbegriff." }, { status: 400 });
    }
    const result = await checkPrice(query.trim());
    return NextResponse.json(result);
  } catch (err) {
    console.error("[price]", err);
    return NextResponse.json(
      { error: (err as Error).message || "Preis-Check fehlgeschlagen." },
      { status: 500 },
    );
  }
}
