import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Attribute } from "./types";

// Schnelles Klassifikationsmodell (mehrfach pro Post aufgerufen). Überschreibbar.
const CATEGORY_MODEL = process.env.FASTSELL_CATEGORY_MODEL || "claude-haiku-4-5";

// Nur .describe() – Struktur-Outputs unterstützen keine min/max-Constraints.
const ChoiceSchema = z.object({
  index: z
    .number()
    .describe(
      "0-basierter Index der am besten passenden Kategorie-Option, oder -1 wenn keine passt.",
    ),
  reason: z.string().optional().describe("Kurze Begründung (optional)."),
});

export interface CategoryProduct {
  title: string;
  description: string;
  attributes?: Attribute[];
  hint?: string; // von Claude vermutete Kategorie (aus der Foto-Analyse) – nur als Hinweis
}

const SYSTEM_PROMPT = `Du ordnest einen gebrauchten Artikel auf kleinanzeigen.de in den Kategoriebaum ein.
Du bekommst den Artikel und die aktuell wählbaren Kategorie-Optionen EINER Ebene des Baums.
Wähle die EINE Option, die den Artikel am besten Richtung passender Unterkategorie führt.
Antworte nur mit dem 0-basierten Index der besten Option. Passt keine Option wirklich, antworte -1.`;

/**
 * Lässt Claude aus den *tatsächlich* auf der Seite vorhandenen Optionen einer Ebene die passende
 * wählen (statt vorab einen Pfad zu raten). Gibt den 0-basierten Index zurück, oder -1.
 * Wirft, wenn kein API-Zugang besteht – der Aufrufer fällt dann auf die Pfad-Heuristik zurück.
 */
export async function chooseCategoryOption(
  product: CategoryProduct,
  options: string[],
): Promise<number> {
  if (options.length === 0) return -1;

  const attrs = (product.attributes ?? []).map((a) => `${a.label}: ${a.wert}`).join(", ");
  const userText = [
    `Artikel: ${product.title}`,
    product.hint ? `Vermutete Kategorie (Hinweis): ${product.hint}` : "",
    attrs ? `Merkmale: ${attrs}` : "",
    `Beschreibung: ${product.description}`,
    "",
    "Wählbare Kategorie-Optionen dieser Ebene:",
    options.map((o, i) => `${i}: ${o}`).join("\n"),
    "",
    "Antworte mit dem Index der besten Option (oder -1).",
  ]
    .filter(Boolean)
    .join("\n");

  const client = new Anthropic();
  const response = await client.beta.messages.parse({
    model: CATEGORY_MODEL,
    max_tokens: 200,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userText }],
    output_format: betaZodOutputFormat(ChoiceSchema),
  });

  const idx = response.parsed_output?.index;
  if (typeof idx !== "number" || !Number.isInteger(idx)) return -1;
  return idx >= 0 && idx < options.length ? idx : -1;
}
