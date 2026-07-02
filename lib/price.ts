import type { Browser } from "playwright";
import { launchBrowser } from "./poster";
import type { PriceCheckResult, PriceType } from "./types";

// Grober Preis-Check über vergleichbare Kleinanzeigen-Suchergebnisse.
// Kein Login nötig. Akamai-geschützt -> best-effort mit sauberem Fallback.

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function buildSearchUrl(query: string): string {
  const slug = query
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
  return `https://www.kleinanzeigen.de/s-${slug || "artikel"}/k0`;
}

/**
 * Fragt vergleichbare Anzeigen ab und leitet eine Preisspanne + Empfehlung ab.
 * @param query z. B. "Marke Modell" oder der Anzeigentitel
 */
export async function checkPrice(query: string): Promise<PriceCheckResult> {
  const empty: PriceCheckResult = {
    count: 0,
    minCents: null,
    medianCents: null,
    maxCents: null,
    suggestedCents: null,
    suggestedType: "VB",
    samples: [],
  };

  let browser: Browser | null = null;
  try {
    browser = await launchBrowser(true);
    const context = await browser.newContext({
      locale: "de-DE",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(buildSearchUrl(query), { waitUntil: "domcontentloaded", timeout: 20000 });

    if (/captcha|challenge|blocked/i.test(page.url())) {
      return { ...empty, note: "Preis-Check nicht möglich (Sicherheitsabfrage)." };
    }

    // Ergebnis-Karten auslesen. Selektoren aus der öffentlichen Ergebnisliste;
    // ggf. an aktuelle Seite anpassen.
    const items = await page.evaluate(() => {
      const out: { title: string; price: string; url: string }[] = [];
      const cards = document.querySelectorAll("article.aditem, li.ad-listitem article");
      cards.forEach((card) => {
        const title = card.querySelector(".text-module-begin, h2 a")?.textContent?.trim() ?? "";
        const price =
          card
            .querySelector(".aditem-main--middle--price-shipping--price, .aditem-main--middle--price")
            ?.textContent?.trim() ?? "";
        const href = (card.querySelector("a[href]") as HTMLAnchorElement | null)?.href ?? "";
        if (title) out.push({ title, price, url: href });
      });
      return out.slice(0, 20);
    });

    const parsed = items.map((it) => {
      const m = it.price.replace(/\./g, "").match(/(\d+)\s*€/);
      const cents = m ? parseInt(m[1], 10) * 100 : null;
      return { title: it.title, priceCents: cents, url: it.url };
    });

    const prices = parsed
      .map((p) => p.priceCents)
      .filter((c): c is number => c !== null && c > 0);

    if (prices.length === 0) {
      return { ...empty, samples: parsed.slice(0, 6), note: "Keine Vergleichspreise gefunden." };
    }

    const med = median(prices)!;
    const suggested = Math.round((med * 0.95) / 100) * 100; // knapp unter Median, auf Euro gerundet
    const suggestedType: PriceType = "VB";

    return {
      count: prices.length,
      minCents: Math.min(...prices),
      medianCents: med,
      maxCents: Math.max(...prices),
      suggestedCents: suggested,
      suggestedType,
      samples: parsed.slice(0, 6),
    };
  } catch (err) {
    return { ...empty, note: `Preis-Check fehlgeschlagen: ${(err as Error).message}` };
  } finally {
    await browser?.close().catch(() => {});
  }
}
