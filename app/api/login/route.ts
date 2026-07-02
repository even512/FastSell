import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { isBlocked, launchBrowser, screenshotDataUrl } from "@/lib/poster";
import { hasSession, saveStorageState } from "@/lib/session";
import type { LoginResult, LoginStatus } from "@/lib/types";
import type { Page } from "playwright";

export const runtime = "nodejs";
export const maxDuration = 300;

const LOGIN_URL = "https://www.kleinanzeigen.de/m-einloggen.html";
// Server-seitiges Debug-Abbild des letzten Fehlschlags (nicht im Browser nötig).
const DEBUG_SHOT = path.join(process.cwd(), "data", "login-debug.png");

// Playwright-Fehlermeldungen enthalten ANSI-Codes und ein verboses „Call log:" – für die
// Anzeige im Konto-Screen auf die erste, lesbare Zeile reduzieren.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
function cleanError(msg: string): string {
  return (
    msg
      .replace(ANSI, "")
      .split(/\r?\n(?:Call log|Browser logs):/)[0]
      .trim() || "Login fehlgeschlagen."
  );
}

// Status: ist ein Login gespeichert?
export async function GET() {
  const body: LoginStatus = { hasSession: await hasSession("default") };
  return NextResponse.json(body);
}

// Einmaliger Login: öffnet standardmäßig einen sichtbaren Browser, wartet bis der Nutzer
// eingeloggt ist, speichert die Session verschlüsselt. Läuft auf dem Rechner, der das Backend
// betreibt (Deployment-Empfehlung: lokal / im Heimnetz mit eigener IP).
//
// Wichtig: Kleinanzeigen ist Akamai-geschützt. Von Server-IPs / im Rechenzentrum erscheint oft
// eine Bot-Wall statt der Login-Seite. Dieser Handler bricht in *jedem* Fehlerfall sauber ab und
// liefert einen verständlichen Grund + einen Screenshot der Seite zurück (statt zu crashen).
export async function POST() {
  // Login ist per Default headful (der Nutzer loggt sich selbst ein). Auf Servern ohne Display
  // bzw. zum Testen: FASTSELL_LOGIN_HEADLESS=true.
  const headless = process.env.FASTSELL_LOGIN_HEADLESS === "true";
  // Wartezeit auf den manuellen Login (überschreibbar, v. a. für Tests). || fängt NaN/0 ab.
  const loginTimeoutMs = Number(process.env.FASTSELL_LOGIN_TIMEOUT_MS) || 180_000;

  let browser: Awaited<ReturnType<typeof launchBrowser>> | null = null;
  let page: Page | null = null;

  // Sauberer Fehlschlag: best-effort-Screenshot einsammeln, Browser schließen, JSON zurückgeben.
  async function fail(reason: string, status: number): Promise<NextResponse> {
    let screenshot: string | undefined;
    if (page) {
      screenshot = await screenshotDataUrl(page);
      if (screenshot) {
        try {
          fs.mkdirSync(path.dirname(DEBUG_SHOT), { recursive: true });
          fs.writeFileSync(DEBUG_SHOT, Buffer.from(screenshot.split(",")[1], "base64"));
        } catch {
          /* Debug-Abbild ist optional */
        }
      }
    }
    await browser?.close().catch(() => {});
    const body: LoginResult = { ok: false, reason, screenshot };
    return NextResponse.json(body, { status });
  }

  try {
    browser = await launchBrowser(headless);
    const ctx = await browser.newContext({
      locale: "de-DE",
      viewport: { width: 1280, height: 900 },
    });
    page = await ctx.newPage();
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });

    // Direkt auf Bot-Wall / Captcha prüfen – dann sauber mit Screenshot + Grund abbrechen.
    if (await isBlocked(page)) {
      return await fail(
        "Kleinanzeigen zeigt eine Sicherheitsabfrage/Bot-Wall statt der Login-Seite " +
          "(typisch bei Server-/Rechenzentrums-IPs). Bitte den Login lokal im Heimnetz mit " +
          "sichtbarem Browser durchführen. Der Screenshot zeigt, was die Seite gerade anzeigt.",
        409,
      );
    }

    // Auf erfolgreichen Login warten: Login-Cookie oder Nutzer-Menü. Zwischendurch kann eine
    // Bot-Wall auftauchen – auch das wird sauber abgefangen.
    const deadline = Date.now() + loginTimeoutMs;
    let loggedIn = false;
    while (Date.now() < deadline) {
      if (await isBlocked(page)) {
        return await fail(
          "Während des Logins erschien eine Sicherheitsabfrage/Bot-Wall. Bitte im geöffneten " +
            "Browser lösen oder den Login lokal durchführen.",
          409,
        );
      }
      const cookies = await ctx.cookies().catch(() => []);
      if (cookies.some((c) => /access_token|secure|session|login/i.test(c.name))) {
        loggedIn = true;
        break;
      }
      const menu = await page
        .locator("a[href*='m-meine-anzeigen'], #user-my-account, [data-testid='user-menu']")
        .count()
        .catch(() => 0);
      if (menu > 0) {
        loggedIn = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!loggedIn) {
      const mins = Math.round(loginTimeoutMs / 60_000);
      return await fail(
        `Login nicht erkannt (Zeitüberschreitung nach ${mins} Min). Bitte im geöffneten ` +
          "Browser vollständig einloggen und erneut versuchen.",
        408,
      );
    }

    const state = await ctx.storageState();
    await saveStorageState(state, "default");
    await browser.close();
    const body: LoginResult = { ok: true };
    return NextResponse.json(body);
  } catch (err) {
    const rawFull = (err as Error).message || "Login fehlgeschlagen.";
    const raw = cleanError(rawFull);
    // Häufigster Fall auf einem Server: der sichtbare Browser soll auf dem Backend-Host öffnen,
    // der aber kein Display hat. Klar erklären und auf Session-Export/Import verweisen.
    const noDisplay = /display|xserver|x server|missing x|xvfb/i.test(rawFull);
    const friendly = noDisplay
      ? "Der sichtbare Login-Browser öffnet auf dem Rechner, der das Backend ausführt – dieser hat " +
        "kein Display (headless Server/Docker). Logge dich auf einem Rechner mit Bildschirm ein und " +
        "übertrage die Session unten per „Session übertragen“ (Export/Import)."
      : raw;
    return await fail(friendly, 500);
  }
}
