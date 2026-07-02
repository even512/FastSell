import { NextResponse } from "next/server";
import { listListings } from "@/lib/store";

export const runtime = "nodejs";

// Anzeigen-Historie (ohne Foto-Daten – die werden nicht persistiert).
export async function GET() {
  return NextResponse.json({ listings: listListings() });
}
