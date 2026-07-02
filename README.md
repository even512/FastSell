# FastSell

**Blitzschnell Artikel auf [Kleinanzeigen.de](https://www.kleinanzeigen.de) einstellen.**
Foto machen → App erkennt das Produkt, bereitet die Fotos auf und schreibt eine natürlich
klingende Verkaufsanzeige → Preis (Festpreis/VB) mit grobem Preis-Check festlegen → Anzeige wird
per Browser-Automation **automatisch** eingestellt → direkt weiter zum nächsten Artikel.

Mobile-first PWA + Node-Backend (Next.js), Produkterkennung & Verkaufstext mit **Claude Opus 4.8**.

> ⚠️ **Wichtig / Rechtliches:** Kleinanzeigen bietet keine offene API zum Einstellen und ist per
> Akamai Bot Manager gegen Automatisierung geschützt. Das Auto-Posting läuft über Browser-Automation
> (Playwright) und bewegt sich in einem ToS-Graubereich mit realem Sperr-Risiko. Nutzung auf eigene
> Verantwortung. Empfehlung: Backend **lokal / im Heimnetz** betreiben (eigene IP, eine persistente
> Login-Session) und maßvoll einsetzen.

---

## Workflow

1. **Fotos** – 2–3 Fotos des Artikels aufnehmen/hochladen.
2. **Anzeige** – Titel, Kategorie, Zustand, Merkmale und Verkaufstext werden generiert (alles
   editierbar). Pro Foto zwischen **optimiert** (Original-Hintergrund, aufgehellt) und **Freisteller**
   (neutraler Hintergrund) wählen.
3. **Preis** – Festpreis / VB / Verschenken. „Vergleichen" schätzt anhand ähnlicher Anzeigen eine
   Preisspanne und macht einen Vorschlag.
4. **Einstellen** – Live-Fortschritt; danach „Nächster Artikel".

---

## Setup

```bash
npm install
cp .env.example .env       # ANTHROPIC_API_KEY eintragen (oder `ant auth login`)
npm run dev                # http://localhost:3000
```

Auf dem Handy: im selben Netz die LAN-IP des Rechners öffnen (z. B. `http://192.168.x.y:3000`) und
über „Zum Homescreen hinzufügen" als App installieren.

### Umgebungsvariablen (`.env`)

| Variable | Zweck | Default |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Claude für Erkennung + Text | – (erforderlich) |
| `FASTSELL_MODEL` | Modell-Override | `claude-opus-4-8` |
| `FASTSELL_ENC_KEY` | 32-Byte-Hex-Key für Login-Verschlüsselung | auto in `data/session.key` |
| `FASTSELL_POSTER_HEADLESS` | Poster headless (`true`/`false`) | `false` |
| `PLAYWRIGHT_CHROMIUM` | Pfad zu Chromium (optional) | Playwright-Default |
| `FASTSELL_MOCK` | `1` = Demo ohne KI (Platzhalter-Entwurf, kein API-Key nötig) | – |

> **Demo ohne API-Key:** `FASTSELL_MOCK=1 npm run dev` lässt den kompletten Flow (Fotos →
> Bildaufbereitung → Entwurf → Preis → Einstellen) durchklicken, ohne Claude aufzurufen – nützlich
> zum Ausprobieren der Oberfläche. Für echte Produkterkennung `FASTSELL_MOCK` weglassen und
> `ANTHROPIC_API_KEY` setzen.

---

## Self-Hosting (nginx)

Für den Betrieb hinter deinem nginx-Reverse-Proxy siehe **[DEPLOY.md](./DEPLOY.md)**.

**Am einfachsten mit Docker:** `cp fastsell.env.example fastsell.env` (Key eintragen) →
`docker compose up -d --build`. App läuft auf `127.0.0.1:3000`, nginx proxyt darauf. Ohne Docker geht
es per `npm run build` + systemd-Service (ebenfalls in DEPLOY.md).

Der `ANTHROPIC_API_KEY` wird **nur serverseitig** benutzt (nie im Browser) und gehört in eine
gitignorierte Datei (`fastsell.env` bzw. `.env.production.local`) oder ein systemd-`EnvironmentFile` –
**nicht** in committeten Code (sonst GitHub-Secret-Scanning → Widerruf).

## Auto-Posting (einmaliger Login)

Das Einstellen braucht einen gespeicherten Kleinanzeigen-Login. `POST /api/login` öffnet einen
sichtbaren Browser; dort einmal einloggen (inkl. evtl. Sicherheitsabfrage). Die Session wird
**AES-256-GCM-verschlüsselt** lokal gespeichert (kein Passwort im Klartext). Danach postet
`/api/publish` mit dieser Session.

Playwright-Browser (falls nicht vorhanden):

```bash
npx playwright install chromium
```

---

## Struktur

```
app/
  page.tsx                 Schritt-Flow (Fotos → Anzeige → Preis → Einstellen)
  api/analyze/route.ts     Fotos -> Bildpipeline + Claude -> Anzeigen-Entwurf
  api/price/route.ts       Preis-Check (Vergleichs-Listings)
  api/publish/route.ts     Auto-Posting (SSE-Fortschritt)
  api/login/route.ts       Einmaliger Login -> verschlüsselte Session
  api/listings/route.ts    Anzeigen-Historie
components/                CaptureStep, ReviewStep, PriceStep, PublishStep, HistoryList
lib/
  images.ts                sharp-Optimierung + Freisteller (optional @imgly)
  listing.ts               Claude Vision (beta.messages.parse + Zod)
  price.ts                 Preis-Check via Playwright-Suche
  poster.ts                Kleinanzeigen-Posting (Playwright + Stealth)
  session.ts / store.ts    Verschlüsselte Session + JSON-Store (Historie)
scripts/smoke-images.ts    Bildpipeline offline testen
```

Selektoren/Flow des Posters sind aus dem Community-Projekt
[`Second-Hand-Friends/kleinanzeigen-bot`](https://github.com/Second-Hand-Friends/kleinanzeigen-bot)
portiert und sollten gegen die aktuelle Seite validiert werden.

---

## Freisteller (Hintergrund-Entfernung)

Der Freisteller nutzt das optionale Paket `@imgly/background-removal-node`. Es lädt bei der
Installation ein Modell/`libvips` nach; hinter restriktiven Proxys kann das fehlschlagen – dann läuft
die App ohne Freisteller (nur „optimiert"), der Rest funktioniert normal. Auf einem üblichen Rechner
installiert es voll und der Freisteller ist aktiv.

---

## Skripte

```bash
npm run dev            # Entwicklung
npm run build          # Produktions-Build
npm run start          # Produktion starten
npm run typecheck      # tsc --noEmit
npm run smoke:images   # Bildpipeline offline testen (-> data/smoke/)
```

---

## Kosten (Claude)

`claude-opus-4-8`: $5 / $25 pro 1M Token. Fotos werden auf ~1024 px heruntergerechnet → grob
**~0,03–0,05 € pro Anzeige**. Bei hohem Volumen ist `claude-sonnet-5` ein Kostenhebel
(`FASTSELL_MODEL=claude-sonnet-5`).
