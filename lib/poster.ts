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
// Kanonischer Einstieg zum Anzeigen-Aufgeben (nicht der Legacy-„schritt2"-Deeplink);
// per FASTSELL_NEW_AD_URL überschreibbar, falls Kleinanzeigen die URL ändert.
const NEW_AD_URL = process.env.FASTSELL_NEW_AD_URL || `${BASE_URL}/p-anzeige-aufgeben.html`;
// Felder sollen schnell scheitern (statt 30 s Default zu warten), wenn ein Selektor nicht passt.
const FIELD_TIMEOUT = 8000;
// Titel-Feld = zuverlässigstes Signal „wir sind im Formular". Aktuell #ad-title, früher #postad-title.
const TITLE_SEL = "#ad-title, #postad-title";

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

/** Erkennt Bot-Wall / Captcha grob anhand von URL, Captcha-Selektoren und Seitentext. */
export async function isBlocked(page: Page): Promise<boolean> {
  const url = page.url();
  if (/captcha|challenge|blocked|geoblocked/i.test(url)) return true;
  // Bekannte Captcha-Container / iframes.
  const captcha = await page
    .locator('iframe[src*="captcha"], iframe[title*="captcha" i], #captcha, .g-recaptcha')
    .count()
    .catch(() => 0);
  if (captcha > 0) return true;
  // Akamai Bot Manager / „Access Denied"-Seiten erkennt man am Seitentext.
  const html = await page.content().catch(() => "");
  return /Zugriff verweigert|Access Denied|Reference #\d|Pardon Our Interruption|Bot Manager/i.test(
    html,
  );
}

/**
 * Best-effort-Screenshot der aktuellen Seite als PNG-data-URL (Viewport, nicht Full-Page,
 * damit die Antwort klein bleibt). Gibt undefined zurück, wenn kein Screenshot möglich ist
 * (z. B. Seite bereits geschlossen) – wirft nie.
 */
export async function screenshotDataUrl(page: Page): Promise<string | undefined> {
  try {
    const buf = await page.screenshot({ type: "png" });
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
}

/** Fehler in einem konkreten Schritt (mit Schritt-Kennung für die UI). */
class StepError extends Error {
  constructor(
    public step: string,
    message: string,
  ) {
    super(message);
  }
}

/** Wartet kurz auf ein Pflicht-Element und wirft bei Fehlen einen klaren StepError. */
async function requireEl(
  page: Page,
  selector: string,
  step: string,
  human: string,
  state: "visible" | "attached" = "visible",
) {
  const el = page.locator(selector).first();
  try {
    await el.waitFor({ state, timeout: FIELD_TIMEOUT });
  } catch {
    throw new StepError(
      step,
      `„${human}" nicht gefunden (Selektor \`${selector}\`). Die Kleinanzeigen-Seite hat sich ` +
        "vermutlich geändert – die technische Diagnose unten zeigt die tatsächlich vorhandenen Felder.",
    );
  }
  return el;
}

/**
 * Kompakte Beschreibung der aktuellen Seite (URL + sichtbare Formularfelder). Damit lassen sich
 * bei einem Fehlschlag die korrekten Selektoren ableiten, ohne die Live-Seite selbst zu sehen.
 */
async function describeForm(page: Page): Promise<string> {
  try {
    const info = await page.evaluate(() => {
      const visible = (el: Element) =>
        (el as HTMLElement).offsetParent !== null || el.getAttribute("type") === "file";
      const controls = Array.from(document.querySelectorAll("input, textarea, select, button"));
      const rows = controls
        .filter(visible)
        .slice(0, 40)
        .map((el) => {
          const type = el.getAttribute("type") || "";
          const id = (el as HTMLElement).id || "";
          const name = el.getAttribute("name") || "";
          const ph = el.getAttribute("placeholder") || "";
          const label = (el.getAttribute("aria-label") || el.textContent || "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 40);
          return (
            `${el.tagName.toLowerCase()}${type ? `[${type}]` : ""} ` +
            `id=${id || "-"} name=${name || "-"}${ph ? ` ph="${ph}"` : ""}${label ? ` · ${label}` : ""}`
          );
        });
      // Klickbares (Links/Kategorien) – Kategorien sind oft <a>, nicht Formularfelder.
      const clickable = Array.from(
        document.querySelectorAll('a[href], [role="link"], [role="button"]'),
      )
        .filter((el) => visible(el) && (el.textContent || "").trim())
        .slice(0, 40)
        .map((el) => {
          const id = (el as HTMLElement).id || "";
          const href = el.getAttribute("href") || "";
          const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
          return `${el.tagName.toLowerCase()} id=${id || "-"}${href ? ` href=${href.slice(0, 50)}` : ""} · ${text}`;
        });
      return { url: location.href, title: document.title, total: controls.length, rows, clickable };
    });
    return [
      `URL: ${info.url}`,
      `Seitentitel: ${info.title}`,
      `Sichtbare Formularelemente (von ${info.total} gesamt):`,
      ...(info.rows.length ? info.rows : ["(keine)"]),
      "Klickbares (Links/Kategorien, Auswahl):",
      ...(info.clickable.length ? info.clickable : ["(keine)"]),
    ].join("\n");
  } catch (e) {
    return `Diagnose nicht möglich: ${(e as Error).message}`;
  }
}

/** Klickt ein Element anhand seines exakten sichtbaren Textes (Link/Button). */
async function clickExactText(page: Page, text: string): Promise<boolean> {
  const tries = [
    page.getByRole("link", { name: text, exact: true }),
    page.getByRole("button", { name: text, exact: true }),
    page.getByText(text, { exact: true }),
  ];
  for (const loc of tries) {
    const el = loc.first();
    if ((await el.count().catch(() => 0)) === 0) continue;
    try {
      await el.click({ timeout: FIELD_TIMEOUT });
      return true;
    } catch {
      /* nächster Kandidat */
    }
  }
  return false;
}

function normCat(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/gi, " ")
    .trim();
}

/** Ähnlichkeit zweier Kategorienamen: exakt > Präfix > enthält > Wort-Überlappung. */
function scoreCat(target: string, candidate: string): number {
  const t = normCat(target);
  const c = normCat(candidate);
  if (!t || !c) return 0;
  if (t === c) return 100;
  if (c.startsWith(t) || t.startsWith(c)) return 80;
  if (c.includes(t) || t.includes(c)) return 60;
  const a = new Set(t.split(" "));
  const b = new Set(c.split(" "));
  const inter = [...a].filter((x) => b.has(x)).length;
  return inter > 0 ? 30 + inter * 5 : 0;
}

/**
 * Wählt die am besten passende Kategorie-Verknüpfung und klickt sie. Schließt bereits Geklicktes
 * (v. a. die Elternkategorie) aus und bevorzugt bei Gleichstand den kürzeren = spezifischeren Namen.
 * Gibt den tatsächlich geklickten Text zurück (oder null).
 */
async function clickBestCategory(
  page: Page,
  target: string,
  clicked: Set<string>,
): Promise<string | null> {
  const cands: string[] = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('a[href], [role="link"], [role="button"]'));
    return els
      .filter((el) => (el as HTMLElement).offsetParent !== null && (el.textContent || "").trim())
      .map((el) => (el.textContent || "").trim().replace(/\s+/g, " "));
  });
  let best: string | null = null;
  let bestScore = 0;
  let bestLenDiff = Number.POSITIVE_INFINITY;
  const tLen = normCat(target).length;
  for (const text of cands) {
    if (clicked.has(text)) continue;
    const s = scoreCat(target, text);
    if (s < 30) continue;
    const lenDiff = Math.abs(normCat(text).length - tLen);
    if (s > bestScore || (s === bestScore && lenDiff < bestLenDiff)) {
      best = text;
      bestScore = s;
      bestLenDiff = lenDiff;
    }
  }
  if (!best) return null;
  const ok = await clickExactText(page, best);
  if (ok) clicked.add(best);
  return ok ? best : null;
}

/**
 * Klickt den Kategorie-Pfad durch (z. B. „Musik, Filme & Bücher > Musik & CDs"). Kleinanzeigen
 * startet das Aufgeben mit einer Kategorie-Auswahl; das Formular erscheint erst nach der Wahl einer
 * Blatt-Kategorie und „Weiter".
 */
async function selectCategory(
  page: Page,
  categoryPath: string,
  onProgress: (p: PublishProgress) => void,
): Promise<void> {
  const parts = categoryPath
    .split(">")
    .map((s) => s.trim())
    .filter(Boolean);
  const clicked = new Set<string>();
  for (const part of parts) {
    // Sind wir schon im Formular? Dann keine Kategorie mehr nötig.
    if ((await page.locator(TITLE_SEL).count().catch(() => 0)) > 0) return;
    const picked = await clickBestCategory(page, part, clicked);
    onProgress({
      step: "category",
      status: "running",
      message: picked ? `Kategorie: „${picked}" …` : `Kategorie „${part}" nicht gefunden …`,
    });
    if (!picked) return; // nichts Passendes – der Aufrufer meldet später ehrlich inkl. Diagnose
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await randomDelay(500, 1200);
  }
}

/**
 * Nach gewählter Kategorie führt Kleinanzeigen über einen „Weiter"-Button zum eigentlichen
 * Formular (Schritt 2). Klickt „Weiter", bis das Titel-Feld erscheint (max. wenige Zwischenschritte).
 */
async function advanceToForm(page: Page, onProgress: (p: PublishProgress) => void): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if ((await page.locator(TITLE_SEL).count().catch(() => 0)) > 0) return; // Formular da
    const weiter = page.getByRole("button", { name: /^weiter/i }).first();
    if ((await weiter.count().catch(() => 0)) === 0) return; // kein „Weiter" → Aufrufer meldet ehrlich
    onProgress({ step: "category", status: "running", message: "Weiter zum Formular …" });
    await weiter.click({ timeout: FIELD_TIMEOUT }).catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await randomDelay(800, 1800);
  }
}

/**
 * Best-effort: öffnet ein Custom-Dropdown (Button, dessen Name triggerRe matcht) und wählt die
 * Option optionText. Kleinanzeigen nutzt für Zustand/Preistyp keine <select>, sondern Buttons+Menüs.
 */
async function selectFromDropdown(page: Page, triggerRe: RegExp, optionText: string): Promise<boolean> {
  const trigger = page.getByRole("button", { name: triggerRe }).first();
  if ((await trigger.count().catch(() => 0)) === 0) return false;
  try {
    await trigger.click({ timeout: FIELD_TIMEOUT });
  } catch {
    return false;
  }
  await randomDelay(300, 800);
  const ok = await clickExactText(page, optionText);
  if (!ok) await page.keyboard.press("Escape").catch(() => {});
  return ok;
}

/**
 * Stellt eine Anzeige über Browser-Automation ein.
 *
 * Kleinanzeigen hat keine offene API und ist Akamai-geschützt; das Formular ändert sich zudem
 * regelmäßig. Darum bricht der Poster bei fehlenden Pflichtfeldern **schnell und ehrlich** ab
 * (statt still weiterzulaufen und fälschlich „veröffentlicht" zu melden) und liefert einen
 * Screenshot + eine Feld-Diagnose, mit der sich die Selektoren nachziehen lassen.
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
        "Kein Kleinanzeigen-Login gespeichert. Bitte zuerst einmalig einloggen (Konto-Screen).",
    });
    return;
  }

  const headless = process.env.FASTSELL_POSTER_HEADLESS !== "false";
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  const tempFiles: string[] = [];

  // Ehrlicher Fehlschlag inkl. Screenshot + Formular-Diagnose.
  async function reportFailure(step: string, message: string): Promise<void> {
    const screenshot = page ? await screenshotDataUrl(page) : undefined;
    const details = page ? await describeForm(page) : undefined;
    onProgress({ step, status: "error", message, screenshot, details });
  }

  try {
    onProgress({ step: "start", status: "running", message: "Browser wird gestartet …" });
    browser = await launchBrowser(headless);
    context = await browser.newContext({
      storageState: storageState as BrowserContextOptions["storageState"],
      locale: "de-DE",
      viewport: { width: 1280, height: 900 },
    });
    page = await context.newPage();

    onProgress({ step: "navigate", status: "running", message: "Öffne die Seite zum Anzeigen-Aufgeben …" });
    await page.goto(NEW_AD_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await randomDelay();

    if (await isBlocked(page)) {
      const screenshot = await screenshotDataUrl(page);
      onProgress({
        step: "captcha",
        status: "action_required",
        message:
          "Kleinanzeigen zeigt eine Sicherheitsabfrage/Bot-Wall (Screenshot unten). Automatisches " +
          "Einstellen ist dann nicht möglich – ggf. später erneut oder mit weniger Automatisierung.",
        screenshot,
      });
      return;
    }

    // Kategorie-Auswahl: Kleinanzeigen zeigt zuerst eine Kategorieseite; das Formular kommt danach.
    if ((await page.locator(TITLE_SEL).count().catch(() => 0)) === 0 && req.category) {
      onProgress({
        step: "category",
        status: "running",
        message: `Kategorie wird gewählt: ${req.category} …`,
      });
      await selectCategory(page, req.category, onProgress);
      // Nach der Kategorie via „Weiter" zum eigentlichen Formular (Schritt 2).
      await advanceToForm(page, onProgress);
      await randomDelay(400, 1000);
    }

    // Titel (Pflicht) – zugleich der Check, ob wir überhaupt im Formular gelandet sind.
    onProgress({ step: "title", status: "running", message: "Titel wird eingetragen …" });
    const titleEl = await requireEl(page, TITLE_SEL, "title", "Titel-Feld");
    await titleEl.fill(req.title, { timeout: FIELD_TIMEOUT });
    await randomDelay(200, 600);

    // Zustand (bei vielen Kategorien Pflicht) – Custom-Dropdown, best effort.
    if (req.condition) {
      await selectFromDropdown(page, /zustand/i, req.condition).catch(() => {});
      await randomDelay(200, 600);
    }

    // Beschreibung (Pflicht)
    onProgress({ step: "description", status: "running", message: "Beschreibung wird eingetragen …" });
    const descEl = await requireEl(
      page,
      "#ad-description, #pstad-descrptn",
      "description",
      "Beschreibungs-Feld",
    );
    await descEl.fill(req.description, { timeout: FIELD_TIMEOUT });
    await randomDelay(200, 600);

    // Preis + Preistyp
    onProgress({ step: "price", status: "running", message: "Preis wird gesetzt …" });
    if (req.priceType === "FREE") {
      // Preistyp-Dropdown auf „Zu verschenken" (best effort).
      await selectFromDropdown(page, /preistyp|festpreis|vb/i, "Zu verschenken").catch(() => {});
    } else {
      const euro = Math.round(req.priceCents / 100).toString();
      const priceEl = await requireEl(page, "#ad-price-amount, #pstad-price", "price", "Preis-Feld");
      await priceEl.fill(euro, { timeout: FIELD_TIMEOUT });
      // „Festpreis" ist KA-Default; für VB best effort umstellen.
      if (req.priceType === "VB") {
        await selectFromDropdown(page, /preistyp|festpreis/i, "VB").catch(() => {});
      }
    }
    await randomDelay(200, 600);

    // Fotos hochladen (verstecktes File-Input → auf "attached" statt "visible" warten)
    onProgress({ step: "photos", status: "running", message: `${req.photos.length} Foto(s) werden hochgeladen …` });
    const files = req.photos.map((dataUrl, i) => {
      const f = writeTempPhoto(dataUrl, i);
      tempFiles.push(f);
      return f;
    });
    const fileInput = await requireEl(page, 'input[type="file"]', "photos", "Foto-Upload-Feld", "attached");
    await fileInput.setInputFiles(files, { timeout: FIELD_TIMEOUT });
    await randomDelay(1500, 3000);

    // Absenden – Button „Anzeige aufgeben" (früher #pstad-submit).
    onProgress({ step: "submit", status: "running", message: "Anzeige wird veröffentlicht …" });
    const submitBtn = page
      .getByRole("button", { name: "Anzeige aufgeben", exact: true })
      .or(page.locator("#pstad-submit"))
      .first();
    if ((await submitBtn.count().catch(() => 0)) === 0) {
      throw new StepError("submit", "Veröffentlichen-Button „Anzeige aufgeben“ nicht gefunden.");
    }
    await submitBtn.click({ timeout: FIELD_TIMEOUT });
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await randomDelay(1500, 3000);

    // Kleinanzeigen zeigt nach dem Absenden evtl. ein Upsell-Modal („Highlight buchen?"). Die
    // kostenlose Variante bestätigen (best effort), damit die Anzeige wirklich rausgeht.
    const upsell = page.getByRole("button", { name: /kostenlos|ohne highlight|^weiter$/i }).first();
    if ((await upsell.count().catch(() => 0)) > 0) {
      await upsell.click({ timeout: FIELD_TIMEOUT }).catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await randomDelay(1000, 2000);
    }

    if (await isBlocked(page)) {
      const screenshot = await screenshotDataUrl(page);
      onProgress({
        step: "captcha",
        status: "action_required",
        message: "Beim Absenden erschien eine Sicherheitsabfrage/Bot-Wall (Screenshot unten).",
        screenshot,
      });
      return;
    }

    // Erfolg VERIFIZIEREN statt behaupten: sind wir aus dem Formular raus?
    onProgress({ step: "verify", status: "running", message: "Veröffentlichung wird geprüft …" });
    // Das Formular selbst liegt unter …/p-anzeige-aufgeben-schritt2.html – die URL taugt daher nicht
    // als Erfolgssignal. Zuverlässig: das Titel-Feld ist weg = wir sind aus dem Formular raus.
    const stillOnForm = await page.locator(TITLE_SEL).count().catch(() => 1);
    const finalUrl = page.url();
    const published = stillOnForm === 0;
    if (!published) {
      await reportFailure(
        "verify",
        "Das Absenden wurde ausgelöst, aber die Veröffentlichung ließ sich nicht bestätigen (die " +
          "Seite blieb im Formular). Es wurde vermutlich nichts eingestellt – Screenshot + Diagnose " +
          "unten. Falls die Anzeige doch erscheint, sag Bescheid, dann justiere ich die Erfolgsprüfung.",
      );
      return;
    }

    onProgress({ step: "done", status: "done", message: "Anzeige wurde eingestellt.", url: finalUrl });
  } catch (err) {
    if (err instanceof StepError) {
      await reportFailure(err.step, err.message);
    } else {
      await reportFailure("error", `Unerwarteter Fehler beim Einstellen: ${(err as Error).message}`);
    }
  } finally {
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
