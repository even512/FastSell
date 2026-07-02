import { NextRequest } from "next/server";
import { publishListing } from "@/lib/poster";
import { addListing, updateListing } from "@/lib/store";
import type { PublishProgress, PublishRequest } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

// Stellt die Anzeige per Browser-Automation ein und streamt den Fortschritt als SSE.
export async function POST(req: NextRequest) {
  const body = (await req.json()) as PublishRequest;

  // Historien-Eintrag anlegen (ohne die schweren Foto-Daten zu persistieren).
  const listing = addListing({
    title: body.title,
    category: body.category,
    condition: body.condition,
    description: body.description,
    attributes: body.attributes ?? [],
    photos: [],
    priceType: body.priceType,
    priceCents: body.priceCents,
    status: "publishing",
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (p: PublishProgress) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(p)}\n\n`));

      try {
        await publishListing(body, (p) => {
          send(p);
          if (p.status === "done") {
            updateListing(listing.id, { status: "published", kleinanzeigenUrl: p.url });
          } else if (p.status === "error") {
            updateListing(listing.id, { status: "error", errorMessage: p.message });
          }
        });
      } catch (err) {
        send({ step: "error", status: "error", message: (err as Error).message });
        updateListing(listing.id, { status: "error", errorMessage: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
