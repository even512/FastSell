import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { ListingDraft } from "./types";

const MODEL = process.env.FASTSELL_MODEL || "claude-opus-4-8";

// Strukturiertes Ausgabe-Schema. Nur `.describe()` verwenden – Struktur-Outputs
// unterstützen keine minLength/maxLength/min/max-Constraints.
const AttributeSchema = z.object({
  label: z.string().describe('Merkmalname, z. B. "Marke", "Größe", "Farbe", "Speicher".'),
  wert: z.string().describe("Merkmalwert."),
});

const ListingSchema = z.object({
  titel: z
    .string()
    .describe("Prägnanter Anzeigentitel, ca. 50–65 Zeichen, ohne Preis, ohne Ausrufezeichen."),
  marke: z.string().describe('Marke/Hersteller. Leerer String "" wenn nicht erkennbar.'),
  modell: z.string().describe('Modell/Produktbezeichnung. Leerer String "" wenn nicht erkennbar.'),
  kategorie: z
    .string()
    .describe(
      'Passende Kleinanzeigen-Kategorie als Pfad, z. B. "Elektronik > Handys & Telefone" oder "Mode & Beauty > Damenmode".',
    ),
  zustand: z
    .string()
    .describe(
      'Zustand des Artikels anhand der Fotos. Genau einer von: "Neu", "Sehr gut", "Gut", "In Ordnung", "Defekt".',
    ),
  attribute: z
    .array(AttributeSchema)
    .describe("2–6 wichtige, aus den Fotos ersichtliche Produktmerkmale."),
  beschreibung: z
    .string()
    .describe(
      "Der Verkaufstext (siehe System-Anweisung zum Stil). Mehrere kurze Absätze, natürlich und ehrlich.",
    ),
});

const SYSTEM_PROMPT = `Du hilfst einer Privatperson, gebrauchte Gegenstände auf kleinanzeigen.de zu verkaufen.
Du bekommst 1–3 Fotos EINES Artikels. Erkenne das Produkt so genau wie möglich und erstelle daraus eine verkaufsfertige Anzeige.

Regeln für die Beschreibung – das ist das Wichtigste:
- Klinge wie ein normaler privater Verkäufer, NICHT wie Werbung oder ein Online-Shop.
- Keine Hochglanz-Floskeln ("Ergreifen Sie diese einmalige Gelegenheit", "Top-Qualität zum Bestpreis").
- Keine typischen KI-Formulierungen, keine übertriebenen Adjektive, keine Emoji-Flut.
- Kurze, ehrliche Sätze. Leichte Ich-Perspektive ist ok ("Verkaufe hier ...", "Habe ich selten benutzt").
- Nenne konkret, was man sieht: Zustand, sichtbare Gebrauchsspuren, Besonderheiten, Zubehör.
- Erfinde KEINE Fakten (keine Maße/Baujahre/technischen Daten, die nicht erkennbar sind). Im Zweifel weglassen.
- 3–6 kurze Sätze bzw. 1–2 knappe Absätze reichen. Am Ende ein schlichter Hinweis (z. B. "Abholung oder Versand möglich."), keine aggressive Verhandlungsansage.

Fülle alle Felder aus. Antworte ausschließlich im geforderten strukturierten Format.`;

type MediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/**
 * Erzeugt aus den Produktfotos einen strukturierten Anzeigen-Entwurf.
 * @param images optimierte (heruntergerechnete) Bilder als base64 + mediaType
 */
export async function generateListing(
  images: { mediaType: string; base64: string }[],
): Promise<ListingDraft> {
  if (images.length === 0) throw new Error("Keine Bilder übergeben.");

  // Demo-/Dev-Modus ohne API-Key: deterministischer Platzhalter-Entwurf,
  // damit der komplette Flow ohne Claude durchklickbar/testbar ist.
  if (process.env.FASTSELL_MOCK === "1") {
    return {
      titel: "Beispielartikel (Demo-Modus)",
      marke: "",
      modell: "",
      kategorie: "Sonstiges > Weitere Kategorien",
      zustand: "Gut",
      attribute: [
        { label: "Zustand", wert: "Gut" },
        { label: "Hinweis", wert: "Demo ohne KI" },
      ],
      beschreibung:
        "Dies ist ein Demo-Entwurf ohne Produkterkennung. Trage einen ANTHROPIC_API_KEY in .env ein, damit die App das Produkt aus den Fotos erkennt und einen echten Verkaufstext schreibt.",
    };
  }

  const client = new Anthropic(); // liest ANTHROPIC_API_KEY / ant-Profil aus der Umgebung

  const imageBlocks = images.map((img) => ({
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: (img.mediaType || "image/jpeg") as MediaType,
      data: img.base64,
    },
  }));

  // client.beta.messages.parse: strukturierte Zod-Ausgabe (Struktur-Outputs, beta).
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [
          ...imageBlocks,
          {
            type: "text" as const,
            text: "Erstelle die verkaufsfertige Anzeige für den abgebildeten Artikel.",
          },
        ],
      },
    ],
    output_format: betaZodOutputFormat(ListingSchema),
  });

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error(
      response.stop_reason === "refusal"
        ? "Die KI hat die Anfrage abgelehnt."
        : "Konnte aus den Fotos keine Anzeige erzeugen.",
    );
  }
  return parsed;
}
