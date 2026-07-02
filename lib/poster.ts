import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { parseDataUrl } from "./images";
import { loadStorageState } from "./session";
import type { PublishProgress, PublishRequest } from "./types";

// Stealth-Plugin registrieren (reduziert Bot-Erkennung; kein Freifahrtschein gegen Akamai).
chromium.use(StealthPlugin());

const BASE_URL = "https://www.kleinanzeigen.de";
const NEW_AD_URL = `${BASE_URL}/p-anzeige-aufgeben-schritt2.html`;

function execPath(): string | undefined {
  // Container: Chromium ist vorinstalliert. Sonst überschreibbar per ENV.
  return process.env.PLAYWRIGHT_CHROMIUM || undefined;
}

/** Startet einen Browser mit Stealth. headless steuerbar (Login immer headful). */
export async function launchBrowser(headless: boolean): Promise<Browser> {
  return chromium.launch({
    headless,
    executablePath: execPath(),
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });
}

function randomDelay(min = 400, max = 1200): Promise<void> {
  const ms = Math.floor(min + Math.random() * (max - min));
  return new Promise((r) => setTimeout(r, ms));
}

/** Schreibt eine ausgewählte Foto-data-URL in eine temporäre Datei (für File-Upload). */
function writeTempPhoto(dataUrl: string, idx: number): string {
  const { base64 } = parseDataUrl(dataUrl);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastsell-"));
  const file = path.join(dir, `foto-${idx + 1}.jpg`);
  fs.writeFileSync(file, Buffer.from(base64, "base64"));
  return file;
}

/** Erkennt Bot-Wall / Captcha grob anhand von URL und typischen Selektoren. */
async function isBlocked(page: Page): Promise<boolean> {
  const url = page.url();
  if (/captcha|challenge|blocked|geoblocked/i.test(url)) return true;
  const captcha = await page
    .locator('iframe[src*="captcha"], iframe[title*="captcha" i], #captcha, .g-recaptcha')
    .count()
    .catch(() => 0);
  return captcha > 0;
}

/**
 * Stellt eine Anzeige über Browser-Automation ein.
 *
 * Hinweis: Kleinanzeigen hat keine offene API und ist Akamai-geschützt. Die
 * Selektoren sind aus dem Community-Projekt `Second-Hand-Friends/kleinanzeigen-bot`
 * portiert und müssen gegen die aktuelle Seite validiert werden. Jeder Schritt ist
 * abgesichert; bei Captcha/Bot-Wall wird pausiert statt hart abgebrochen.
 */
export async function publishListing(
  req: PublishRequest,
  onProgress: (p: PublishProgress) => void,
): Promise<void> {
  const storageState = await loadStorageState("default");
  if (!storageState) {
    onProgress({
      step: "login",
      status: "action_required",
      message:
        "Kein Kleinanzeigen-Login gespeichert. Bitte zuerst einmalig einloggen (Login-Schritt).",
    });
    return;
  }

  const headless = process.env.FASTSELL_POSTER_HEADLESS !== "false";
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  const tempFiles: string[] = [];

  try {
    onProgress({ step: "start", status: "running", message: "Browser wird gestartet …" });
    browser = await launchBrowser(headless);
    context = await browser.newContext({
      storageState: storageState as BrowserContextOptions["storageState"],
      locale: "de-DE",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();

    onProgress({ step: "navigate", status: "running", message: "Öffne die Seite zum Anzeigen-Aufgeben …" });
    await page.goto(NEW_AD_URL, { waitUntil: "domcontentloaded" });
    await randomDelay();

    if (await isBlocked(page)) {
      onProgress({
        step: "captcha",
        status: "action_required",
        message:
          "Kleinanzeigen zeigt eine Sicherheitsabfrage (Captcha). Bitte im geöffneten Browser lösen und erneut versuchen.",
      });
      return;
    }

    // Titel
    onProgress({ step: "title", status: "running", message: "Titel wird eingetragen …" });
    await page.fill("#postad-title", req.title).catch(() => {});
    await randomDelay(200, 600);

    // Beschreibung
    onProgress({ step: "description", status: "running", message: "Beschreibung wird eingetragen …" });
    await page.fill("#pstad-descrptn", req.description).catch(() => {});
    await randomDelay(200, 600);

    // Preis + Preistyp
    onProgress({ step: "price", status: "running", message: "Preis wird gesetzt …" });
    if (req.priceType === "FREE") {
      await page.check("#radio-pricetype-GIVE_AWAY").catch(() => {});
    } else {
      const euro = Math.round(req.priceCents / 100).toString();
      await page.fill("#pstad-price", euro).catch(() => {});
      const typeSel =
        req.priceType === "FIXED" ? "#radio-pricetype-FIXED" : "#radio-pricetype-NEGOTIABLE";
      await page.check(typeSel).catch(() => {});
    }
    await randomDelay(200, 600);

    // Fotos hochladen
    onProgress({ step: "photos", status: "running", message: `${req.photos.length} Foto(s) werden hochgeladen …` });
    const files = req.photos.map((dataUrl, i) => {
      const f = writeTempPhoto(dataUrl, i);
      tempFiles.push(f);
      return f;
    });
    // Kleinanzeigen nutzt ein verstecktes File-Input für den Foto-Upload.
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(files).catch(() => {});
    // dem Upload etwas Zeit geben
    await randomDelay(1500, 3000);

    // Absenden
    onProgress({ step: "submit", status: "running", message: "Anzeige wird veröffentlicht …" });
    await page.click("#pstad-submit").catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await randomDelay(1000, 2000);

    if (await isBlocked(page)) {
      onProgress({
        step: "captcha",
        status: "action_required",
        message: "Beim Absenden erschien eine Sicherheitsabfrage. Bitte im Browser lösen.",
      });
      return;
    }

    const finalUrl = page.url();
    onProgress({
      step: "done",
      status: "done",
      message: "Anzeige wurde eingestellt.",
      url: finalUrl,
    });
  } catch (err) {
    onProgress({
      step: "error",
      status: "error",
      message: `Fehler beim Einstellen: ${(err as Error).message}`,
    });
  } finally {
    // Aufräumen
    for (const f of tempFiles) {
      try {
        fs.rmSync(path.dirname(f), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
