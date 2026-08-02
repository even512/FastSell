import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { chooseCategoryOption, suggestFieldValue, type CategoryProduct } from "./categorize";
import { parseDataUrl } from "./images";
import { loadStorageState } from "./session";
import type { Attribute, MissingField, PriceType, PublishProgress, PublishRequest } from "./types";

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
      // Kleinanzeigen versteckt Radios/Checkboxen hinter gestylten Labels – für die Diagnose sind
      // gerade diese unsichtbaren Controls wichtig (Preisart/Versand), daher mit aufnehmen.
      const relevant = (el: Element) => {
        if (visible(el)) return true;
        const type = el.getAttribute("type") || "";
        return type === "radio" || type === "checkbox" || el.tagName === "SELECT";
      };
      const controls = Array.from(document.querySelectorAll("input, textarea, select, button"));
      const rows = controls
        .filter(relevant)
        .slice(0, 60)
        .map((el) => {
          const type = el.getAttribute("type") || "";
          const id = (el as HTMLElement).id || "";
          const name = el.getAttribute("name") || "";
          const ph = el.getAttribute("placeholder") || "";
          const hidden = visible(el) ? "" : " (versteckt)";
          const label = (el.getAttribute("aria-label") || el.textContent || "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 40);
          return (
            `${el.tagName.toLowerCase()}${type ? `[${type}]` : ""} ` +
            `id=${id || "-"} name=${name || "-"}${ph ? ` ph="${ph}"` : ""}${label ? ` · ${label}` : ""}${hidden}`
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
interface CatLink {
  text: string;
  path: string | null; // z. B. "161/279" aus href …#?path=161/279&…
  isParent: boolean;
  id: string; // z. B. "cat_279" – für robustes Klicken per #id (Text als Fallback)
}

function parseCatPath(href: string): string | null {
  const m = href.match(/[?&]path=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Sammelt sichtbare Kategorie-Links samt Pfad + isParent (aus dem href). */
async function collectCatLinks(page: Page): Promise<CatLink[]> {
  const raw = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('a[href], [role="link"], [role="button"]'));
    return els
      .filter((el) => (el as HTMLElement).offsetParent !== null && (el.textContent || "").trim())
      .map((el) => ({
        text: (el.textContent || "").trim().replace(/\s+/g, " "),
        href: el.getAttribute("href") || "",
        id: (el as HTMLElement).id || "",
      }));
  });
  return raw.map((c) => ({
    text: c.text,
    path: parseCatPath(c.href),
    isParent: /isparent=true/i.test(c.href),
    id: c.id,
  }));
}

/** Klickt eine Kategorie-Verknüpfung robust: bevorzugt per #id, Fallback über den sichtbaren Text. */
async function clickCatLink(page: Page, link: CatLink): Promise<boolean> {
  if (link.id) {
    const byId = page.locator(`[id="${link.id}"]`).first();
    if ((await byId.count().catch(() => 0)) > 0) {
      try {
        await byId.click({ timeout: FIELD_TIMEOUT });
        return true;
      } catch {
        /* Fallback auf Text */
      }
    }
  }
  return clickExactText(page, link.text);
}

/**
 * Direkte Kinder des aktuellen Pfads (zweig-bewusst, dedupliziert nach Pfad). Ohne currentPath =
 * oberste Ebene (Pfad-Tiefe 1). KA zeigt den Baum mehrspaltig – so bekommt jede Ebene nur ihre
 * echten Optionen (kein Abdriften in eine gleichnamige Schwester eines anderen Zweigs).
 */
function childOptions(links: CatLink[], currentPath: string | null): CatLink[] {
  const wantDepth = currentPath ? currentPath.split("/").length + 1 : 1;
  const seen = new Set<string>();
  const out: CatLink[] = [];
  for (const c of links) {
    if (!c.path) continue;
    if (currentPath && !c.path.startsWith(`${currentPath}/`)) continue;
    if (c.path.split("/").length !== wantDepth) continue;
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    out.push(c);
  }
  return out;
}

/**
 * Wählt die am besten passende Kategorie und klickt sie. Zweig-bewusst: bei gesetztem currentPath
 * werden nur direkte Kinder davon berücksichtigt (KA zeigt den Baum mehrspaltig – so landet z. B.
 * „Zubehör" unter der richtigen Elternkategorie statt bei einer gleichnamigen Schwester). Schließt
 * Geklicktes aus, bevorzugt bei Gleichstand den spezifischeren (kürzeren) Namen.
 */
async function clickBestCategory(
  page: Page,
  target: string,
  clicked: Set<string>,
  currentPath: string | null,
): Promise<CatLink | null> {
  const links = await collectCatLinks(page);
  let pool = links;
  if (currentPath) {
    const children = childOptions(links, currentPath);
    if (children.length) pool = children; // nur direkte Kinder des aktuellen Zweigs
  }
  let best: CatLink | null = null;
  let bestScore = 0;
  let bestLenDiff = Number.POSITIVE_INFINITY;
  const tLen = normCat(target).length;
  for (const c of pool) {
    if (clicked.has(c.text)) continue;
    const s = scoreCat(target, c.text);
    if (s < 30) continue;
    const lenDiff = Math.abs(normCat(c.text).length - tLen);
    if (s > bestScore || (s === bestScore && lenDiff < bestLenDiff)) {
      best = c;
      bestScore = s;
      bestLenDiff = lenDiff;
    }
  }
  if (!best) return null;
  const ok = await clickCatLink(page, best);
  if (ok) clicked.add(best.text);
  return ok ? best : null;
}

/** Fallback für die Blatt-Vervollständigung: klickt irgendein Blatt-Kind des aktuellen Zweigs. */
async function clickFirstLeaf(
  page: Page,
  clicked: Set<string>,
  currentPath: string | null,
): Promise<CatLink | null> {
  if (!currentPath) return null;
  const leaf = childOptions(await collectCatLinks(page), currentPath).find(
    (c) => !c.isParent && !clicked.has(c.text),
  );
  if (!leaf) return null;
  const ok = await clickCatLink(page, leaf);
  if (ok) clicked.add(leaf.text);
  return ok ? leaf : null;
}

export type CategoryChooser = (product: CategoryProduct, options: string[]) => Promise<number>;

/**
 * Wählt die Kategorie **dynamisch mit Claude**: navigiert KAs echten (mehrspaltigen) Baum Ebene für
 * Ebene und lässt auf jeder Ebene aus den *tatsächlich vorhandenen* Optionen die passende wählen –
 * unabhängig von Produkt und Kategorietiefe. `chooser` ist injizierbar (für Tests). Fällt auf die
 * Pfad-Heuristik (`selectCategoryByPath`) zurück, wenn kein KI-Zugang besteht (kein API-Key /
 * FASTSELL_MOCK) oder die KI eine Ebene nicht entscheiden kann.
 */
export async function selectCategory(
  page: Page,
  req: PublishRequest,
  onProgress: (p: PublishProgress) => void,
  chooser: CategoryChooser = chooseCategoryOption,
): Promise<void> {
  const product: CategoryProduct = {
    title: req.title,
    description: req.description,
    attributes: req.attributes,
    hint: req.category, // von Claude vermutete Kategorie – nur ein Hinweis
  };
  const fallbackParts = (req.category || "")
    .split(">")
    .map((s) => s.trim())
    .filter(Boolean);
  const formPresent = async () => (await page.locator(TITLE_SEL).count().catch(() => 0)) > 0;

  const clicked = new Set<string>();
  let currentPath: string | null = null;

  for (let level = 0; level < 6; level++) {
    if (await formPresent()) return;
    const links = await collectCatLinks(page);
    const options: CatLink[] = childOptions(links, currentPath).filter((o) => !clicked.has(o.text));
    if (options.length === 0) break; // keine weitere Ebene sichtbar → advanceToForm/Diagnose übernimmt

    // Claude aus den ECHTEN Optionen dieser Ebene wählen lassen.
    let idx = -1;
    try {
      idx = await chooser(
        product,
        options.map((o) => o.text),
      );
    } catch {
      // Kein KI-Zugang o. Ä.: komplett auf die Pfad-Heuristik umschalten (nur am Anfang sinnvoll).
      if (level === 0) {
        onProgress({
          step: "category",
          status: "running",
          message: "KI-Kategorieauswahl nicht verfügbar – nutze Kategorie-Pfad …",
        });
        await selectCategoryByPath(page, req.category || "", onProgress);
        return;
      }
      idx = -1; // mitten im Baum: unten greift die pro-Ebene-Heuristik
    }

    let picked: CatLink | null = null;
    if (idx >= 0 && idx < options.length) {
      const target = options[idx];
      if (await clickCatLink(page, target)) {
        clicked.add(target.text);
        picked = target;
      }
    }

    // KI unsicher (-1) oder Klick misslang → zweig-bewusster Heuristik-Fallback für diese Ebene.
    if (!picked) {
      const part = fallbackParts[level] ?? fallbackParts[fallbackParts.length - 1] ?? "";
      picked =
        (part ? await clickBestCategory(page, part, clicked, currentPath) : null) ??
        (await clickFirstLeaf(page, clicked, currentPath));
    }

    if (!picked) {
      // Nichts wählbar → ehrlicher Abbruch über den Aufrufer (Diagnose zeigt die echten Optionen).
      onProgress({
        step: "category",
        status: "running",
        message: "Keine passende Kategorie gefunden …",
      });
      return;
    }

    onProgress({ step: "category", status: "running", message: `Kategorie: „${picked.text}" …` });
    if (picked.path) currentPath = picked.path;
    if (!picked.isParent) {
      // Blatt erreicht → Kategorie vollständig. Auch hier settlen lassen: die SPA rendert nach
      // der Blatt-Wahl neu und zeigt den „Weiter"-Button erst verzögert (sonst Race in advanceToForm).
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await randomDelay(500, 1200);
      return;
    }
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await randomDelay(500, 1200);
  }
}

/**
 * Fallback: klickt einen vorab geratenen Kategorie-Pfad durch (z. B. „Elektronik > Konsolen >
 * Zubehör") per unscharfem Text-Matching. Wird genutzt, wenn keine KI-Auswahl verfügbar ist.
 * Kleinanzeigen startet das Aufgeben mit einer Kategorie-Auswahl; das Formular erscheint erst nach
 * der Wahl einer Blatt-Kategorie und „Weiter".
 */
async function selectCategoryByPath(
  page: Page,
  categoryPath: string,
  onProgress: (p: PublishProgress) => void,
): Promise<void> {
  const parts = categoryPath
    .split(">")
    .map((s) => s.trim())
    .filter(Boolean);
  const clicked = new Set<string>();
  let currentPath: string | null = null;
  let lastIsParent = true;

  const formPresent = async () => (await page.locator(TITLE_SEL).count().catch(() => 0)) > 0;

  for (const part of parts) {
    if (await formPresent()) return;
    const picked = await clickBestCategory(page, part, clicked, currentPath);
    onProgress({
      step: "category",
      status: "running",
      message: picked ? `Kategorie: „${picked.text}" …` : `Kategorie „${part}" nicht gefunden …`,
    });
    if (!picked) return; // nichts Passendes – der Aufrufer meldet später ehrlich inkl. Diagnose
    if (picked.path) currentPath = picked.path;
    lastIsParent = picked.isParent;
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await randomDelay(500, 1200);
  }

  // Blatt-Vervollständigung: KA braucht eine Blatt-Kategorie. Ist die letzte Wahl noch ein Parent
  // (Claudes Pfad zu kurz), weiter in ein Blatt drillen – passend zum letzten Pfadteil.
  const lastPart = parts[parts.length - 1] ?? "";
  for (let i = 0; i < 3 && lastIsParent; i++) {
    if (await formPresent()) return;
    const picked =
      (await clickBestCategory(page, lastPart, clicked, currentPath)) ??
      (await clickFirstLeaf(page, clicked, currentPath));
    if (!picked) break;
    onProgress({ step: "category", status: "running", message: `Unterkategorie: „${picked.text}" …` });
    if (picked.path) currentPath = picked.path;
    lastIsParent = picked.isParent;
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await randomDelay(500, 1200);
  }
}

/**
 * Nach gewählter Kategorie führt Kleinanzeigen über einen „Weiter"-Button zum eigentlichen
 * Formular (Schritt 2). Klickt „Weiter", bis das Titel-Feld erscheint (max. wenige Zwischenschritte).
 * Wartet pro Runde aktiv auf Formular ODER „Weiter" – die SPA rendert den Button nach der
 * Blatt-Wahl verzögert; ein instantaner count() verpasst ihn (dann bricht der Post fälschlich
 * mit „Titel-Feld nicht gefunden" ab, obwohl „Weiter" sichtbar ist).
 */
async function advanceToForm(page: Page, onProgress: (p: PublishProgress) => void): Promise<void> {
  const form = page.locator(TITLE_SEL).first();
  const weiter = page
    .getByRole("button", { name: /^weiter/i })
    .or(page.locator('button[type="submit"]:has-text("Weiter")'))
    .first();
  for (let i = 0; i < 3; i++) {
    try {
      await form.or(weiter).first().waitFor({ state: "visible", timeout: FIELD_TIMEOUT });
    } catch {
      return; // weder Formular noch „Weiter" → Aufrufer meldet ehrlich inkl. Diagnose
    }
    if ((await form.count().catch(() => 0)) > 0) return; // Formular da
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
 * Klickt ein Control robust: normaler Klick, sonst das zugehörige Label (Kleinanzeigen versteckt
 * Radio-/Checkbox-Inputs hinter gestylten Labels – Playwright kann unsichtbare Inputs nicht
 * klicken), zuletzt JS-Klick direkt am Element. Rückgabe: konnte geklickt werden?
 */
async function clickControl(page: Page, selector: string): Promise<boolean> {
  const el = page.locator(selector).first();
  if ((await el.count().catch(() => 0)) === 0) return false;
  try {
    await el.click({ timeout: FIELD_TIMEOUT });
    return true;
  } catch {
    /* Label / JS versuchen */
  }
  const id = await el.getAttribute("id").catch(() => null);
  if (id) {
    try {
      await page.locator(`label[for="${id}"]`).first().click({ timeout: FIELD_TIMEOUT });
      return true;
    } catch {
      /* JS versuchen */
    }
  }
  try {
    await el.evaluate((node) => (node as HTMLElement).click());
    return true;
  } catch {
    return false;
  }
}

/**
 * Setzt eine Checkbox/einen Switch (per sichtbarem Namen) auf checked und liest den Zustand zurück.
 * Rückgabe: true/false = tatsächlicher Zustand danach, null = Control nicht gefunden.
 */
async function setToggle(page: Page, nameRe: RegExp, checked: boolean): Promise<boolean | null> {
  const box = page
    .getByRole("checkbox", { name: nameRe })
    .or(page.getByRole("switch", { name: nameRe }))
    .first();
  if ((await box.count().catch(() => 0)) === 0) return null;
  try {
    if (checked) await box.check({ timeout: FIELD_TIMEOUT });
    else await box.uncheck({ timeout: FIELD_TIMEOUT });
  } catch {
    /* Zustand trotzdem zurücklesen */
  }
  return box.isChecked().catch(() => null);
}

/**
 * Wählt den Zustand (bei vielen Kategorien Pflicht – ohne ihn scheitert das Absenden). Erst über
 * einen Button mit „Zustand" im Namen, sonst über das Label `for*="condition"` und den darauf
 * folgenden Button (aktuelles Formular); die Option dann per Text oder Radio-Rolle. Best effort.
 */
async function selectCondition(page: Page, condition: string): Promise<boolean> {
  if (await selectFromDropdown(page, /zustand/i, condition)) return true;

  const label = page.locator('label[for*="condition" i]').first();
  if ((await label.count().catch(() => 0)) === 0) return false;
  const trigger = label.locator("xpath=following::button[1]");
  try {
    await trigger.click({ timeout: FIELD_TIMEOUT });
  } catch {
    return false;
  }
  await randomDelay(250, 600);
  if (await clickExactText(page, condition)) return true;
  const radio = page.getByRole("radio", { name: new RegExp(condition, "i") }).first();
  if ((await radio.count().catch(() => 0)) > 0) {
    await radio.check({ timeout: FIELD_TIMEOUT }).catch(() => {});
    if (await radio.isChecked().catch(() => false)) {
      // Auswahl-Dialoge haben oft einen Bestätigen-Button.
      await page
        .getByRole("button", { name: /übernehmen|bestätigen|fertig|ok/i })
        .first()
        .click({ timeout: 2000 })
        .catch(() => {});
      return true;
    }
  }
  await page.keyboard.press("Escape").catch(() => {});
  return false;
}

// Preisart-Mapping auf das Kleinanzeigen-Formular: Menü-Index des #ad-price-type-Dropdowns
// (0=Festpreis, 1=VB, 2=Zu verschenken) und der Formular-Wert für <select>/Legacy-Radios.
const PRICE_TYPES: Record<PriceType, { label: string; menuIdx: number; value: string }> = {
  FIXED: { label: "Festpreis", menuIdx: 0, value: "FIXED" },
  VB: { label: "VB", menuIdx: 1, value: "NEGOTIABLE" },
  FREE: { label: "Zu verschenken", menuIdx: 2, value: "GIVE_AWAY" },
};

/**
 * Setzt die Preisart (Festpreis/VB/Zu verschenken) und **meldet** das Ergebnis. Primär über das
 * aktuelle Custom-Dropdown `#ad-price-type` mit den Optionen `#ad-price-type-menu-option-{0,1,2}`,
 * danach Fallbacks für ältere Formular-Varianten (natives <select>, Radios `name="priceType"`,
 * Text/Toggle). Bei Misserfolg eine sichtbare, nicht-fatale Warnung.
 */
async function setPriceType(
  page: Page,
  type: PriceType,
  onProgress: (p: PublishProgress) => void,
): Promise<void> {
  const { label, menuIdx, value } = PRICE_TYPES[type];
  const done = () =>
    onProgress({ step: "price", status: "running", message: `Preisart: ${label} gesetzt` });
  const warn = () =>
    onProgress({
      step: "price",
      status: "running",
      message: `⚠ Preisart konnte nicht auf ${label} gesetzt werden – bitte in der Anzeige prüfen.`,
    });

  // 1) Aktuelles Formular: #ad-price-type. Meist ein Dropdown-Button mit Menü-Optionen; falls es
  //    doch ein natives <select> ist, direkt darüber wählen.
  const trigger = page.locator("#ad-price-type").first();
  if ((await trigger.count().catch(() => 0)) > 0) {
    const tag = await trigger.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
    if (tag === "select") {
      const picked = await trigger
        .selectOption({ value })
        .catch(() => trigger.selectOption({ label }))
        .catch(() => null);
      if (picked) return done();
    } else {
      try {
        await trigger.click({ timeout: FIELD_TIMEOUT });
        await randomDelay(250, 600);
        const option = page.locator(`#ad-price-type-menu-option-${menuIdx}`).first();
        await option.waitFor({ state: "visible", timeout: FIELD_TIMEOUT });
        await option.click({ timeout: FIELD_TIMEOUT });
        return done();
      } catch {
        await page.keyboard.press("Escape").catch(() => {});
      }
    }
  }

  // 2) Natives <select> unter anderem Namen/ID (ältere Formular-Variante).
  const select = page
    .locator('#priceType, select[name*="priceType" i], select[id*="price-type" i]')
    .first();
  if ((await select.count().catch(() => 0)) > 0) {
    const picked = await select
      .selectOption({ value })
      .catch(() => select.selectOption({ label }))
      .catch(() => null);
    if (picked) return done();
  }

  // 3) Legacy-Radios (verstecktes Input + gestyltes Label).
  const radioSel = `input[name="priceType"][value="${value}"]`;
  if ((await page.locator(radioSel).count().catch(() => 0)) > 0 && (await clickControl(page, radioSel))) {
    const checked = await page.locator(radioSel).first().isChecked().catch(() => null);
    if (checked !== false) return done();
  }

  // 4) Letzte Stufe: Toggle-/Text-Heuristiken (historische Varianten).
  if (type === "FIXED") {
    await setToggle(page, /^vb$|verhandlungsbasis/i, false);
    return done(); // Festpreis ist der KA-Default
  }
  const t = await setToggle(page, type === "VB" ? /^vb$|verhandlungsbasis/i : /zu verschenken|verschenken/i, true);
  if (t === true) return done();
  if (await clickExactText(page, label)) return done();
  if (await selectFromDropdown(page, /preistyp|festpreis|vb/i, label)) return done();
  return warn();
}

/**
 * Setzt die Versandart immer auf „Nur Abholung" und meldet das Ergebnis. Das aktuelle Formular
 * fragt „Versand?" mit Ja/Nein-Radios (`#ad-shipping-enabled-no` = nur Abholung) – der frühere
 * Text „Nur Abholung" existiert dort nicht mehr. Danach Fallbacks für Combobox-/Select-/Legacy-
 * Varianten; best-effort, bricht den Post nicht ab.
 */
async function setShippingPickup(
  page: Page,
  onProgress: (p: PublishProgress) => void,
): Promise<void> {
  const done = () => onProgress({ step: "shipping", status: "running", message: "Versand: Nur Abholung" });

  // 1) Aktuelles Formular: „Versand? Ja/Nein" – Nein = Nur Abholung.
  const pickupNo = page.locator("#ad-shipping-enabled-no").first();
  if ((await pickupNo.count().catch(() => 0)) > 0) {
    if ((await pickupNo.isChecked().catch(() => false)) === true) return done();
    if (await clickControl(page, "#ad-shipping-enabled-no")) {
      // true = verifiziert; null = Zustand nicht lesbar (Button-Variante) -> Klick zählt.
      if ((await pickupNo.isChecked().catch(() => null)) !== false) return done();
    }
  }

  // 2) Versand-Combobox (v. a. gewerbliche Konten): öffnen und „Nur Abholung" wählen.
  const combo = page
    .locator(
      'button[role="combobox"][id="versand"], button[role="combobox"][id$=".versand"], ' +
        'button[role="combobox"][aria-labelledby$="versand-selected-option"]',
    )
    .first();
  if ((await combo.count().catch(() => 0)) > 0) {
    try {
      await combo.click({ timeout: FIELD_TIMEOUT });
      await randomDelay(250, 600);
      if (await clickExactText(page, "Nur Abholung")) return done();
      await page.keyboard.press("Escape").catch(() => {});
    } catch {
      /* nächste Strategie */
    }
  }

  // 3) Versand als Kategorie-Attribut-<select> mit Option „Nur Abholung".
  const attrSelect = page.locator('select:has(option:text-is("Nur Abholung"))').first();
  if ((await attrSelect.count().catch(() => 0)) > 0) {
    if (await attrSelect.selectOption({ label: "Nur Abholung" }).catch(() => null)) return done();
  }

  // 4) Legacy: Radio/Label/Text „Nur Abholung".
  const radio = page.getByRole("radio", { name: /nur abholung|^abholung/i }).first();
  if ((await radio.count().catch(() => 0)) > 0) {
    await radio.check({ timeout: FIELD_TIMEOUT }).catch(() => {});
    if (await radio.isChecked().catch(() => false)) return done();
  }
  if (await clickExactText(page, "Nur Abholung")) return done();

  // 5) „Versand"-Checkbox deaktivieren (falls Versand als opt-in Checkbox umgesetzt ist).
  const versand = await setToggle(page, /versand möglich|^versand$/i, false);
  if (versand === false) return done();

  // Kein Versand-Bereich in dieser Kategorie? Dann gilt ohnehin Abholung -> Info statt Warnung.
  const hasShippingSection =
    (await page
      .locator('#ad-shipping-enabled, [id^="ad-shipping"], [name*="shipping" i]')
      .count()
      .catch(() => 0)) > 0;
  if (!hasShippingSection) {
    onProgress({
      step: "shipping",
      status: "running",
      message: "Kategorie ohne Versandoption – Anzeige ist automatisch nur Abholung.",
    });
    return;
  }

  onProgress({
    step: "shipping",
    status: "running",
    message: `⚠ „Nur Abholung" konnte nicht gesetzt werden – bitte Versandart in der Anzeige prüfen.`,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Kategorie-spezifische Merkmalfelder (Art/Farbe/„Gerät & Zubehör" …)
//
// Diese Felder hängen von der gewählten Kategorie ab und sind nicht fest bekannt.
// Strategie: bekannte Merkmale generisch füllen; nach dem Absenden anhand von
// Kleinanzeigens eigener Validierung ("Bitte gib einen Wert ein.") erkennen,
// welche Pflichtfelder noch offen sind, und diese an die UI zur Rückfrage geben.
// ─────────────────────────────────────────────────────────────────────────────

/** Ein auf der Formularseite erkanntes Merkmal-Control (mit Tag zum Wiederansteuern). */
interface ScannedField {
  fi: number; // via data-fastsell-fi im DOM markiert
  label: string;
  kind: "select" | "custom";
  options: string[]; // native <select>-Optionen (custom: [] – erst beim Öffnen scrapebar)
  empty: boolean; // aktuell kein Wert gewählt
  hasError: boolean; // zeigt eine Pflichtfeld-Fehlermeldung / ist aria-invalid
}

/**
 * Scannt die aktuellen Kategorie-Merkmalfelder (native <select> und Custom-Dropdowns), markiert
 * jedes per `data-fastsell-fi` und liefert Label, Art, Optionen (bei <select>), Leer- und
 * Fehlerzustand. Felder mit eigener Behandlung (Zustand/Preis/Versand …) werden ausgelassen.
 */
async function scanAttributeFields(page: Page): Promise<ScannedField[]> {
  return page.evaluate(() => {
    const ERR = /Bitte gib einen Wert ein|Bitte wähle|Pflichtfeld|ist erforderlich/i;
    const SKIP = /titel|beschreib|preis|zustand|versand|kategorie|standort|plz|\bort\b|telefon|\bname\b|e-?mail/i;
    const PLACEHOLDER = /^\s*$|bitte wählen|bitte auswählen/i;
    const visible = (el: Element) => (el as HTMLElement).offsetParent !== null;

    const findLabel = (el: Element): string => {
      const id = (el as HTMLElement).id;
      if (id) {
        const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (l && (l.textContent || "").trim()) return (l.textContent || "").trim();
      }
      const aria = el.getAttribute("aria-label");
      if (aria && aria.trim()) return aria.trim();
      const labelledby = el.getAttribute("aria-labelledby");
      if (labelledby) {
        const l = document.getElementById(labelledby);
        if (l && (l.textContent || "").trim()) return (l.textContent || "").trim();
      }
      // Nach oben klettern und ein Label/Legend suchen, das das Control NICHT umschließt.
      let n: Element | null = el;
      for (let i = 0; i < 4 && n; i++) {
        const parent: HTMLElement | null = n.parentElement;
        if (parent) {
          for (const c of Array.from(parent.querySelectorAll("label, legend"))) {
            if (!c.contains(el)) {
              const t = (c.textContent || "").trim();
              if (t) return t;
            }
          }
        }
        n = parent;
      }
      return "";
    };

    const cleanLabel = (t: string): string =>
      t.replace(ERR, "").replace(/\(optional\)/gi, "").replace(/\s+/g, " ").trim();

    // Fehler nur in der ENGEN Umgebung des Controls prüfen (sonst färbt ein Fehler eines anderen
    // Felds fälschlich ab). Nur SICHTBARE Fehlermeldungen zählen – ausgeblendete Error-Elemente
    // (display:none) bleiben oft im DOM und würden sonst ein bereits gültiges Feld fälschlich
    // als fehlerhaft markieren.
    const nearError = (el: Element): boolean => {
      if (el.getAttribute("aria-invalid") === "true") return true;
      const scopes: Element[] = [];
      let n: Element | null = el;
      for (let i = 0; i < 3 && n; i++) {
        const p: HTMLElement | null = n.parentElement;
        if (p) {
          const ctrls = p.querySelectorAll("select, input, textarea, button[role], [role='combobox']").length;
          if (ctrls <= 3) scopes.push(p);
        }
        n = p;
      }
      for (const scope of scopes) {
        for (const cand of Array.from(scope.querySelectorAll("*"))) {
          if (cand.contains(el)) continue;
          if ((cand as HTMLElement).offsetParent === null) continue; // unsichtbar → ignorieren
          const own = (cand.textContent || "").trim();
          if (own && own.length < 120 && ERR.test(own)) return true;
        }
      }
      const cls = (el.getAttribute("class") || "") + " " + (el.parentElement?.getAttribute("class") || "");
      return /(^|[^a-z])(error|invalid|has-error)([^a-z]|$)/i.test(cls);
    };

    const candidates: { el: Element; kind: "select" | "custom" }[] = [];
    for (const el of Array.from(document.querySelectorAll("select"))) {
      if (visible(el)) candidates.push({ el, kind: "select" });
    }
    const customSel =
      'button[role="combobox"], [role="combobox"], button[aria-haspopup="listbox"], button[aria-expanded]';
    for (const el of Array.from(document.querySelectorAll(customSel))) {
      if (visible(el)) candidates.push({ el, kind: "custom" });
    }
    for (const el of Array.from(document.querySelectorAll("button"))) {
      if (!visible(el)) continue;
      if (/^bitte (wählen|auswählen)/i.test((el.textContent || "").trim()) && !candidates.some((c) => c.el === el)) {
        candidates.push({ el, kind: "custom" });
      }
    }

    const out: ScannedField[] = [];
    const seen = new Set<Element>();
    let fi = 0;
    for (const { el, kind } of candidates) {
      if (seen.has(el)) continue;
      seen.add(el);
      const label = cleanLabel(findLabel(el));
      if (!label || SKIP.test(label.toLowerCase())) continue;

      let options: string[] = [];
      let empty = false;
      if (kind === "select") {
        const sel = el as HTMLSelectElement;
        options = Array.from(sel.options)
          .map((o) => (o.textContent || "").trim())
          .filter((t) => t && !PLACEHOLDER.test(t));
        const selText = sel.selectedIndex >= 0 ? (sel.options[sel.selectedIndex].textContent || "").trim() : "";
        empty = !sel.value || PLACEHOLDER.test(selText);
      } else {
        empty = PLACEHOLDER.test((el.textContent || "").trim());
      }

      el.setAttribute("data-fastsell-fi", String(fi));
      out.push({ fi, label, kind, options, empty, hasError: nearError(el) });
      fi++;
    }
    return out;
  });
}

/** Ähnlichster Optionstext zu `value` (>=60 Score), sonst null. */
function bestOption(options: string[], value: string): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const o of options) {
    const s = scoreCat(value, o);
    if (s > bestScore) {
      best = o;
      bestScore = s;
    }
  }
  return bestScore >= 60 ? best : null;
}

/** Wählt in einem bereits geöffneten Custom-Dropdown die zu `value` passende Option. */
async function clickBestOption(page: Page, value: string): Promise<boolean> {
  if (await clickExactText(page, value)) return true;
  const opts = await page.evaluate(() => {
    const vis = (el: Element) => (el as HTMLElement).offsetParent !== null;
    return Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], li'))
      .filter(vis)
      .map((el) => (el.textContent || "").trim().replace(/\s+/g, " "))
      .filter((t) => t.length > 0 && t.length < 60);
  });
  const target = bestOption([...new Set(opts)], value);
  return target ? clickExactText(page, target) : false;
}

/** Setzt ein einzelnes Merkmalfeld (per `data-fastsell-fi`-Tag) auf `value`. Best effort. */
async function setAttributeField(page: Page, field: ScannedField, value: string): Promise<boolean> {
  const el = page.locator(`[data-fastsell-fi="${field.fi}"]`).first();
  if ((await el.count().catch(() => 0)) === 0) return false;
  if (field.kind === "select") {
    const target = bestOption(field.options, value);
    if (!target) return false;
    return !!(await el.selectOption({ label: target }).catch(() => null));
  }
  try {
    await el.click({ timeout: FIELD_TIMEOUT });
  } catch {
    return false;
  }
  await randomDelay(200, 500);
  const ok = await clickBestOption(page, value);
  if (!ok) await page.keyboard.press("Escape").catch(() => {});
  return ok;
}

/**
 * Füllt kategorie-spezifische Merkmalfelder (Art/Farbe/…) generisch aus `attributes`, indem das
 * Feld-Label unscharf gegen die Attribut-Labels gematcht wird. Nur bei gutem Treffer (>=60), damit
 * nichts falsch gesetzt wird. Best effort – bricht den Post nie ab.
 */
async function fillCategoryAttributes(
  page: Page,
  attributes: Attribute[],
  onProgress: (p: PublishProgress) => void,
): Promise<void> {
  const attrs = attributes.filter((a) => a.label?.trim() && a.wert?.trim());
  if (!attrs.length) return;
  let fields: ScannedField[];
  try {
    fields = await scanAttributeFields(page);
  } catch {
    return;
  }
  if (!fields.length) return;

  const usedFields = new Set<number>();
  let filledAny = false;
  for (const a of attrs) {
    let best: ScannedField | null = null;
    let bestScore = 0;
    for (const f of fields) {
      if (usedFields.has(f.fi)) continue;
      const s = scoreCat(a.label, f.label);
      if (s > bestScore) {
        best = f;
        bestScore = s;
      }
    }
    if (!best || bestScore < 60) continue;
    if (await setAttributeField(page, best, a.wert)) {
      usedFields.add(best.fi);
      filledAny = true;
    }
    await randomDelay(150, 400);
  }
  if (filledAny) {
    onProgress({ step: "attributes", status: "running", message: "Kategorie-Merkmale werden ausgefüllt …" });
  }
}

/** Öffnet ein Custom-Dropdown (per Tag) und scrapt seine sichtbaren Optionstexte. */
async function scrapeCustomOptions(page: Page, fi: number): Promise<string[]> {
  const trigger = page.locator(`[data-fastsell-fi="${fi}"]`).first();
  if ((await trigger.count().catch(() => 0)) === 0) return [];
  try {
    await trigger.click({ timeout: FIELD_TIMEOUT });
  } catch {
    return [];
  }
  await randomDelay(200, 500);
  const opts = await page
    .evaluate(() => {
      const vis = (el: Element) => (el as HTMLElement).offsetParent !== null;
      return Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], li'))
        .filter(vis)
        .map((el) => (el.textContent || "").trim().replace(/\s+/g, " "))
        .filter((t) => t.length > 0 && t.length < 60 && !/bitte (wählen|auswählen)/i.test(t));
    })
    .catch(() => [] as string[]);
  await page.keyboard.press("Escape").catch(() => {});
  return [...new Set(opts)].slice(0, 60);
}

/**
 * Erkennt nach einem Absende-Versuch die Pflichtfelder, die Kleinanzeigen noch bemängelt
 * („Bitte gib einen Wert ein."). Liefert pro Feld Label + (bei Dropdowns) die echten Optionen,
 * damit die UI gezielt danach fragen kann. So bleibt jeder Post lösbar, auch bei neuen Feldern.
 */
async function findMissingRequiredFields(page: Page): Promise<MissingField[]> {
  let fields: ScannedField[];
  try {
    fields = await scanAttributeFields(page);
  } catch {
    return [];
  }
  const out: MissingField[] = [];
  const seenKeys = new Set<string>();
  for (const f of fields.filter((x) => x.hasError)) {
    const key = normCat(f.label);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    const options = f.kind === "custom" ? await scrapeCustomOptions(page, f.fi) : f.options;
    out.push({
      label: f.label,
      key,
      type: options.length ? "select" : "text",
      options: options.length ? options : undefined,
    });
  }
  return out;
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
    // No-op-Shim für `__name`: manche Transpiler (esbuild/tsx mit keepNames) referenzieren diesen
    // Helfer in Funktionen, die per page.evaluate in den Browser serialisiert werden – dort ist er
    // sonst undefiniert (ReferenceError). Als String eingespielt, damit er selbst nicht transpiliert
    // wird. In Produktion (Next/SWC) schadet der harmlose Shim nicht.
    await context.addInitScript(
      "globalThis.__name = globalThis.__name || function (fn) { return fn; };",
    );
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
    // Claude navigiert den echten Baum dynamisch (Fallback: geratener Pfad aus req.category).
    if ((await page.locator(TITLE_SEL).count().catch(() => 0)) === 0) {
      onProgress({
        step: "category",
        status: "running",
        message: req.category
          ? `Kategorie wird gewählt (Vorschlag: ${req.category}) …`
          : "Kategorie wird gewählt …",
      });
      await selectCategory(page, req, onProgress);
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
      await selectCondition(page, req.condition).catch(() => {});
      await randomDelay(200, 600);
    }

    // Beschreibung (Pflicht) – „Nur Abholung" garantiert erwähnen (auch wenn Modell/Nutzer es weglässt).
    onProgress({ step: "description", status: "running", message: "Beschreibung wird eingetragen …" });
    const descEl = await requireEl(
      page,
      "#ad-description, #pstad-descrptn",
      "description",
      "Beschreibungs-Feld",
    );
    const description = /abhol/i.test(req.description)
      ? req.description
      : `${req.description.trimEnd()}\n\nNur Abholung.`;
    await descEl.fill(description, { timeout: FIELD_TIMEOUT });
    await randomDelay(200, 600);

    // Preis + Preisart (Preisart wird jetzt zuverlässig gesetzt UND gemeldet).
    onProgress({ step: "price", status: "running", message: "Preis wird gesetzt …" });
    if (req.priceType !== "FREE") {
      const euro = Math.round(req.priceCents / 100).toString();
      const priceEl = await requireEl(page, "#ad-price-amount, #pstad-price", "price", "Preis-Feld");
      await priceEl.fill(euro, { timeout: FIELD_TIMEOUT });
      await randomDelay(150, 400);
    }
    await setPriceType(page, req.priceType, onProgress);
    await randomDelay(200, 600);

    // Versandart: immer „Nur Abholung".
    onProgress({ step: "shipping", status: "running", message: "Versandart wird gesetzt …" });
    await setShippingPickup(page, onProgress);
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

    // Kategorie-spezifische Merkmale (Art/Farbe/„Gerät & Zubehör" …) generisch aus den Attributen
    // füllen. Beim Retry stecken hier auch die vom Nutzer nachgetragenen Pflichtfeld-Werte drin.
    await fillCategoryAttributes(page, req.attributes, onProgress).catch(() => {});
    await randomDelay(200, 600);

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

    // Kleinanzeigen zeigt nach dem Absenden evtl. Upsell-Dialoge (aktuell „Effektiver verkaufen"
    // mit „Ohne Hochschieben weiter", früher „Highlight buchen"). Kostenlos fortfahren (best
    // effort) und dabei mehrfach auf die Bestätigungs-URL warten – das ist das sichere
    // Erfolgssignal (…/p-anzeige-aufgeben-bestaetigung.html?adId=…).
    const CONFIRM_RE = /p-anzeige-aufgeben-bestaetigung\.html/i;
    for (let i = 0; i < 3 && !CONFIRM_RE.test(page.url()); i++) {
      const upsell = page
        .getByRole("button", { name: /ohne hochschieben|kostenlos|ohne highlight|^weiter$/i })
        .or(page.locator('dialog[open] button:has-text("Ohne Hochschieben weiter")'))
        .first();
      if ((await upsell.count().catch(() => 0)) > 0) {
        await upsell.click({ timeout: FIELD_TIMEOUT }).catch(() => {});
        await page.waitForLoadState("domcontentloaded").catch(() => {});
      }
      await page.waitForURL(CONFIRM_RE, { timeout: 5000 }).catch(() => {});
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

    // Erfolg VERIFIZIEREN statt behaupten.
    onProgress({ step: "verify", status: "running", message: "Veröffentlichung wird geprüft …" });
    const finalUrl = page.url();
    // Sicherstes Signal: die Bestätigungsseite. Fallback (falls Kleinanzeigen die URL ändert):
    // das Titel-Feld ist weg = wir sind aus dem Formular raus.
    const stillOnForm = await page.locator(TITLE_SEL).count().catch(() => 1);
    const published = CONFIRM_RE.test(finalUrl) || stillOnForm === 0;
    if (!published) {
      // Häufigste Ursache fürs Hängenbleiben: ein kategorie-spezifisches Pflichtfeld, das FastSell
      // (noch) nicht kennt (z. B. „Gerät & Zubehör"). Statt generisch abzubrechen: gezielt erkennen
      // und den Nutzer explizit danach fragen (mit Claude-Vorschlag) – dann Retry mit den Werten.
      const missing = await findMissingRequiredFields(page).catch(() => [] as MissingField[]);
      if (missing.length) {
        const product: CategoryProduct = {
          title: req.title,
          description: req.description,
          attributes: req.attributes,
          hint: req.category,
        };
        for (const f of missing) {
          f.suggestion = await suggestFieldValue(product, f.label, f.options ?? []);
        }
        const names = missing.map((f) => `„${f.label}"`).join(", ");
        const many = missing.length > 1;
        onProgress({
          step: "attributes",
          status: "action_required",
          message:
            `Kleinanzeigen verlangt für diese Kategorie ${many ? "zusätzliche Pflichtfelder" : "ein zusätzliches Pflichtfeld"}: ` +
            `${names}. Bitte ${many ? "die Werte" : "den Wert"} bestätigen – danach stelle ich die Anzeige automatisch fertig ein.`,
          missingFields: missing,
          screenshot: await screenshotDataUrl(page),
        });
        return;
      }
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
