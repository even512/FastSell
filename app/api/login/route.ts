import { NextResponse } from "next/server";
import { launchBrowser } from "@/lib/poster";
import { hasSession, saveStorageState } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 300;

// Status: ist ein Login gespeichert?
export async function GET() {
  return NextResponse.json({ hasSession: await hasSession("default") });
}

// Einmaliger Login: öffnet einen sichtbaren Browser, wartet bis der Nutzer
// eingeloggt ist, speichert die Session verschlüsselt.
// Läuft auf dem Rechner, der das Backend betreibt (Deployment-Empfehlung: lokal).
export async function POST() {
  let browser = null;
  try {
    browser = await launchBrowser(false); // headful – der Nutzer loggt sich selbst ein
    const ctx = await browser.newContext({ locale: "de-DE" });
    const page = await ctx.newPage();
    await page.goto("https://www.kleinanzeigen.de/m-einloggen.html", {
      waitUntil: "domcontentloaded",
    });

    // Auf erfolgreichen Login warten (max. 3 Minuten): Login-Cookie oder Nutzer-Menü.
    const deadline = Date.now() + 180_000;
    let loggedIn = false;
    while (Date.now() < deadline) {
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
      await browser.close();
      return NextResponse.json(
        { ok: false, error: "Login nicht erkannt (Zeitüberschreitung)." },
        { status: 408 },
      );
    }

    const state = await ctx.storageState();
    await saveStorageState(state, "default");
    await browser.close();
    return NextResponse.json({ ok: true });
  } catch (err) {
    await browser?.close().catch(() => {});
    return NextResponse.json(
      { ok: false, error: (err as Error).message || "Login fehlgeschlagen." },
      { status: 500 },
    );
  }
}
