// Smoke-Test des Posters ohne Kleinanzeigen-Zugriff: fährt publishListing gegen eine lokale
// Mock-Version des Anzeigen-Formulars (scripts/mock-kleinanzeigen/) mit den echten Selektoren
// (#ad-price-type + Menü-Optionen, #ad-shipping-enabled-no als verstecktes Radio hinter einem
// Label). Der Mock schreibt die gewählten Werte in die Bestätigungs-URL – daran wird geprüft,
// dass Preisart (VB/Festpreis/Verschenken) und „Nur Abholung" wirklich ankommen.
//
//   npm run smoke:poster
//
// Läuft in einem temporären Arbeitsverzeichnis, damit data/store.json (echter Login!) unberührt
// bleibt. Chromium: Playwright-Installation oder Pfad via PLAYWRIGHT_CHROMIUM.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { PriceType, PublishProgress, PublishRequest } from "../lib/types";

const MOCK_DIR = path.join(__dirname, "mock-kleinanzeigen");

// 1×1-Pixel-JPEG als Foto-Platzhalter.
const TINY_JPEG =
  "data:image/jpeg;base64," +
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwc" +
  "KDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAA" +
  "AAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

function serveMock(): Promise<{ base: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const file = path.join(MOCK_DIR, (req.url || "/").split("?")[0].replace(/^\//, ""));
    try {
      const body = fs.readFileSync(file);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ base: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
    });
  });
}

async function runCase(
  publishListing: (req: PublishRequest, on: (p: PublishProgress) => void) => Promise<void>,
  priceType: PriceType,
  expectPriceType: string,
) {
  const req: PublishRequest = {
    title: `Testartikel ${priceType}`,
    // Der Mock startet wie das Original mit der Kategorie-Auswahl; ohne API-Key läuft die
    // deterministische Pfad-Heuristik diesen Pfad durch den Mock-Baum.
    category: "Elektronik > PC-Zubehör & Software > Netzwerk & Modem",
    condition: "",
    description: "Testbeschreibung. Nur Abholung.",
    // Merkmal für das Pflicht-Custom-Dropdown „Gerät & Zubehör" mitgeben → wird generisch gefüllt.
    attributes: [{ label: "Gerät & Zubehör", wert: "Mit Zubehör" }],
    priceType,
    priceCents: 2500,
    photos: [TINY_JPEG],
  };
  const events: PublishProgress[] = [];
  await publishListing(req, (p) => {
    events.push(p);
    console.log(`  [${p.step}/${p.status}] ${p.message}${p.url ? ` -> ${p.url}` : ""}`);
  });

  // Der Übergang Kategorie -> Formular muss über den (verzögert erscheinenden) „Weiter"-Button
  // gelaufen sein – Regressionstest für den Bug „Titel-Feld nicht gefunden".
  if (!events.some((e) => e.step === "category" && /weiter zum formular/i.test(e.message)))
    throw new Error(`${priceType}: kein „Weiter zum Formular"-Schritt im Event-Log`);

  const done = events.find((e) => e.status === "done");
  if (!done?.url) throw new Error(`${priceType}: kein done-Event mit URL`);
  const url = new URL(done.url);
  const gotPt = url.searchParams.get("priceType");
  const gotShip = url.searchParams.get("shipping");
  const gotGeraet = url.searchParams.get("geraet");
  if (gotPt !== expectPriceType)
    throw new Error(`${priceType}: Preisart im Formular = ${gotPt}, erwartet ${expectPriceType}`);
  if (gotShip !== "PICKUP")
    throw new Error(`${priceType}: Versand im Formular = ${gotShip}, erwartet PICKUP`);
  // Das Custom-Dropdown-Pflichtfeld muss generisch aus attributes gefüllt worden sein.
  if (gotGeraet !== "Mit Zubehör")
    throw new Error(`${priceType}: „Gerät & Zubehör" im Formular = ${gotGeraet}, erwartet „Mit Zubehör"`);
  const warned = events.filter((e) => e.message.startsWith("⚠"));
  if (warned.length)
    throw new Error(`${priceType}: Warnungen: ${warned.map((w) => w.message).join("; ")}`);
  console.log(`✅ ${priceType}: Preisart=${gotPt}, Versand=${gotShip}, Gerät=${gotGeraet}\n`);
}

/**
 * Prüft die Erkennung neuer/unbekannter Pflichtfelder: 1. Versuch OHNE Wert für „Gerät & Zubehör"
 * → der Poster muss `action_required` mit dem fehlenden Feld + gescrapten Optionen melden (statt
 * generisch abzubrechen). 2. Versuch MIT nachgetragenem Wert → Anzeige wird eingestellt.
 */
async function runMissingFieldCase(
  publishListing: (req: PublishRequest, on: (p: PublishProgress) => void) => Promise<void>,
) {
  const base: PublishRequest = {
    title: "Testartikel Pflichtfeld",
    category: "Elektronik > PC-Zubehör & Software > Netzwerk & Modem",
    condition: "",
    description: "Testbeschreibung. Nur Abholung.",
    attributes: [],
    priceType: "VB",
    priceCents: 2500,
    photos: [TINY_JPEG],
  };

  // 1. Versuch: ohne Merkmal → Rückfrage erwartet.
  const ev1: PublishProgress[] = [];
  await publishListing(base, (p) => {
    ev1.push(p);
    console.log(`  [1][${p.step}/${p.status}] ${p.message}`);
  });
  const ar = ev1.find((e) => e.status === "action_required" && (e.missingFields?.length ?? 0) > 0);
  if (!ar) throw new Error("Pflichtfeld: kein action_required mit missingFields im Event-Log");
  const mf = ar.missingFields!.find((f) => /gerät|geraet|zubehör|zubehor/i.test(f.label));
  if (!mf) throw new Error(`Pflichtfeld: „Gerät & Zubehör" nicht erkannt (Felder: ${ar.missingFields!.map((f) => f.label).join(", ")})`);
  if (!mf.options?.includes("Mit Zubehör"))
    throw new Error(`Pflichtfeld: Optionen nicht gescraped (bekam: ${JSON.stringify(mf.options)})`);
  if (ev1.some((e) => e.status === "done"))
    throw new Error("Pflichtfeld: fälschlich als veröffentlicht gemeldet, obwohl Pflichtfeld fehlte");

  // 2. Versuch: Wert nachtragen → muss veröffentlichen (Retry-from-scratch).
  const ev2: PublishProgress[] = [];
  await publishListing({ ...base, attributes: [{ label: mf.label, wert: "Mit Zubehör" }] }, (p) => {
    ev2.push(p);
    console.log(`  [2][${p.step}/${p.status}] ${p.message}`);
  });
  const done = ev2.find((e) => e.status === "done");
  if (!done?.url) throw new Error("Pflichtfeld: 2. Versuch nicht veröffentlicht");
  if (new URL(done.url).searchParams.get("geraet") !== "Mit Zubehör")
    throw new Error("Pflichtfeld: nachgetragener Wert kam im Formular nicht an");
  console.log(`✅ Pflichtfeld-Erkennung: erkannt „${mf.label}" + Optionen; Retry veröffentlicht\n`);
}

async function main() {
  const { base, close } = await serveMock();

  // Isoliertes Arbeitsverzeichnis, damit der Dummy-Login NICHT data/store.json (echten
  // Kleinanzeigen-Login) überschreibt. Muss vor den Poster-/Session-Imports passieren –
  // die Module lesen cwd/env beim Laden.
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "fastsell-poster-smoke-")));
  process.env.FASTSELL_NEW_AD_URL = `${base}/p-anzeige-aufgeben.html`;
  process.env.FASTSELL_POSTER_HEADLESS = "true";
  // Ohne API-Key wirft die KI-Kategorieauswahl -> deterministischer Pfad-Heuristik-Fallback.
  delete process.env.ANTHROPIC_API_KEY;

  const { publishListing } = await import("../lib/poster");
  const { saveStorageState } = await import("../lib/session");
  await saveStorageState({ cookies: [], origins: [] }, "default");

  try {
    await runCase(publishListing, "VB", "NEGOTIABLE");
    await runCase(publishListing, "FIXED", "FIXED");
    await runCase(publishListing, "FREE", "GIVE_AWAY");
    await runMissingFieldCase(publishListing);
    console.log("✅ Poster-Smoke-Test komplett OK");
    process.exit(0);
  } finally {
    close();
  }
}

main().catch((e) => {
  console.error("❌ Poster-Smoke-Test fehlgeschlagen:", (e as Error).message);
  process.exit(1);
});
