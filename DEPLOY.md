# FastSell – Self-Hosting hinter nginx

FastSell ist eine Next.js-App: Sie läuft als **Node-Prozess** (Standard-Port `3000`), vor den du
deinen **nginx als Reverse-Proxy** setzt. Der API-Key wird **serverseitig** genutzt und ist im Browser
**nie** sichtbar.

```
Internet ── (dein gesicherter Reverse-Proxy / TLS) ──▶ nginx ──▶ 127.0.0.1:3000 (next start, FastSell)
```

---

## Docker (empfohlen – am einfachsten)

Alles (Node, Build, Chromium, Key-Handling) ist gekapselt. Auf dem Server:

```bash
# 1. Projekt auf den Server bringen (git clone ODER Ordner per rsync/scp)
#    Hinweis: fastsell.env & data/ sind gitignored -> kommen NICHT per git mit.
cp fastsell.env.example fastsell.env      # entfällt, wenn du den Ordner mit fastsell.env rüberkopierst
nano fastsell.env                          # ANTHROPIC_API_KEY eintragen

# 2. Bauen & starten
docker compose up -d --build

# App läuft jetzt auf 127.0.0.1:3000  ->  nginx (unten) proxyt darauf
docker compose logs -f
```

- **Key**: liegt in `fastsell.env` (gitignored, NICHT im Image – kommt zur Laufzeit via `env_file`).
- **Persistenz**: `./data` ist als Volume gemountet (Historie + verschlüsselte Login-Session bleiben
  über Neustarts erhalten).
- **Port**: `127.0.0.1:3000` – nur lokal, davor dein nginx (Abschnitt 4).
- **Login fürs Posten**: headful-Login geht im Container nicht (kein Display). Führe den Login einmal
  lokal aus (`/api/login`) und kopiere den erzeugten `data/`-Inhalt ins Server-`data/`-Volume
  (siehe Abschnitt 5).

Update später: `git pull` (bzw. Ordner neu rsyncen) → `docker compose up -d --build`.

Wer **kein** Docker will, nimmt den manuellen Weg unten.

---

## Unraid (Docker Hub + Template)

FastSell kann automatisch als Image zu Docker Hub gebaut und auf Unraid per Template installiert werden.

### A) Image zu Docker Hub bauen (GitHub Actions)

Die Pipeline `.github/workflows/docker-publish.yml` baut & pusht das Image (GitHub-Runner haben Netz).

1. Docker-Hub Access-Token erstellen: Docker Hub → **Account Settings → Security → New Access Token**.
2. In GitHub: **Repo → Settings → Secrets and variables → Actions** anlegen:
   - `DOCKERHUB_USERNAME` = dein Docker-Hub-Benutzername
   - `DOCKERHUB_TOKEN` = das Access-Token
3. Auf Docker Hub das Repo `<user>/fastsell` anlegen und auf **Private** stellen.
4. Pipeline auslösen: **Actions → „Docker Publish" → Run workflow** (Branch wählen), **oder** einen
   Tag `vX.Y.Z` pushen. Ergebnis: `docker.io/<user>/fastsell:latest` (+ SHA-/Versions-Tags).

### B) Auf Unraid installieren

1. **Privates Image freigeben:** einmal per Unraid-Terminal einloggen, damit Unraid das private Image
   ziehen darf:
   ```bash
   docker login -u <dein-dockerhub-user>
   ```
2. **Template einspielen:** `unraid/fastsell.xml` nach
   `/boot/config/plugins/dockerMan/templates-user/my-FastSell.xml` kopieren
   (im XML `YOURDOCKERHUBUSER` durch deinen Docker-Hub-User ersetzen). Dann in Unraid:
   **Docker → Add Container →** oben unter „Template" **FastSell** wählen.
3. **Werte prüfen/setzen:**
   - `ANTHROPIC_API_KEY` (maskiert, Pflicht) – wird nur serverseitig genutzt.
   - `App-Daten` → `/mnt/user/appdata/fastsell` (Historie + verschlüsselte Login-Session).
   - `WebUI Port` → z. B. `3000`. Davor gehört dein Reverse-Proxy (SWAG / Nginx Proxy Manager) mit
     TLS/Zugriffsschutz; für den SSE-Stream dort **`proxy_buffering off`** setzen.
4. **Apply** → Container startet, WebUI unter `http://<unraid-ip>:3000/`.

> **Login fürs Auto-Posting:** Der einmalige, sichtbare Login geht im Container nicht (kein Display).
> Führe `/api/login` **einmal lokal** aus und kopiere den erzeugten `data/`-Inhalt nach
> `/mnt/user/appdata/fastsell/`. Danach postet der Container mit dieser Session (headless).

Der API-Key liegt nur in der Unraid-Container-Config (Env-Variable), **nicht** im Image und **nicht**
in Git.

---

## 1. Build & Start (ohne Docker)

```bash
git clone <dein-repo> fastsell && cd fastsell
npm ci
npm run build          # Produktions-Build
npm run start          # startet auf Port 3000 (PORT=... zum Ändern)
```

Playwright-Browser (für Preis-Check & Auto-Posting) einmalig installieren:

```bash
npx playwright install chromium
npx playwright install-deps chromium   # System-Bibliotheken (Debian/Ubuntu)
```

---

## 2. API-Key „gebacken" hinterlegen (server-only, nicht in Git)

Der Key darf **nicht ins Git-Repo** (GitHub-Secret-Scanning würde ihn widerrufen). Zwei erprobte Wege –
beide sind für App-Nutzer unsichtbar (nur serverseitig):

**A) `.env.production.local` (Next.js lädt sie automatisch bei `next start`)**

```bash
cat > .env.production.local <<'EOF'
ANTHROPIC_API_KEY=sk-ant-...        # dein Key
FASTSELL_MODEL=claude-opus-4-8
FASTSELL_POSTER_HEADLESS=true
EOF
chmod 600 .env.production.local
```

Diese Datei ist ge-`.gitignore`-t. Sie kommt **nicht** per `git pull` mit – nach einem Deploy per
`git` liegt sie also nur, wenn du sie einmal auf dem Server anlegst (oder das Verzeichnis per
`rsync/scp` statt `git` überträgst).

**B) systemd `EnvironmentFile` (empfohlen für Dauerbetrieb)** – siehe Service unten. Key liegt in
`/etc/fastsell/fastsell.env` (chmod 600), komplett getrennt vom Code.

---

## 3. systemd-Service

`/etc/fastsell/fastsell.env` (chmod 600, gehört dem Service-User):

```ini
ANTHROPIC_API_KEY=sk-ant-...
FASTSELL_MODEL=claude-opus-4-8
FASTSELL_POSTER_HEADLESS=true
PORT=3000
NODE_ENV=production
```

`/etc/systemd/system/fastsell.service`:

```ini
[Unit]
Description=FastSell (Next.js)
After=network.target

[Service]
Type=simple
User=fastsell
WorkingDirectory=/opt/fastsell
EnvironmentFile=/etc/fastsell/fastsell.env
ExecStart=/usr/bin/npm run start
Restart=on-failure
RestartSec=3
# Playwright/Chromium braucht etwas RAM & /tmp
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now fastsell
sudo systemctl status fastsell
```

---

## 4. nginx-Reverse-Proxy

Wichtig: **SSE** (Live-Fortschritt beim Einstellen) darf **nicht gepuffert** werden, Foto-Uploads
brauchen mehr Body-Größe, und `/api/publish` kann bis ~5 min laufen.

```nginx
server {
    listen 80;                      # TLS/Absicherung macht dein vorgelagerter Proxy
    server_name fastsell.example.internal;

    client_max_body_size 25m;       # mehrere Fotos pro Upload

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "";
    }

    # SSE-Stream fürs Einstellen: Buffering aus, langer Timeout
    location /api/publish {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 320s;
        chunked_transfer_encoding on;
    }
}
```

Die App sendet zusätzlich `X-Accel-Buffering: no` auf dem SSE-Stream, damit nginx auch ohne die
`location`-Sonderregel nicht puffert.

---

## 5. Login fürs Auto-Posting

`POST /api/login` öffnet einen **sichtbaren** Browser **auf dem Rechner, der das Backend ausführt**
(nicht in deinem Browser). Auf einem Server ohne Desktop kann dort kein Login-Fenster aufgehen –
Fehler `Looks like you launched a headed browser without having a XServer running`.

**Empfohlen – Login per Cookie-Import (im „Konto"-Screen, keine Shell/kein Display nötig):**

1. Auf deinem Desktop bei kleinanzeigen.de ganz normal einloggen.
2. Cookies mit der Erweiterung [Cookie-Editor](https://cookie-editor.com) exportieren (Export → JSON).
3. Im „Konto"-Screen **„Cookie-/Session-Datei importieren"** (`POST /api/login/import`) – fertig. Der
   Import akzeptiert das Cookie-Editor-Format **und** eine exportierte `fastsell-session.json`.

Alternativen: FastSell einmal auf einem Rechner **mit** Bildschirm laufen lassen, dort per „Jetzt
einloggen" anmelden und per **„Session exportieren"** (`GET /api/login/export`) übertragen; die
`data/`-Session (inkl. `session.key`) direkt auf den Server kopieren; oder dort `xvfb-run` + VNC nutzen.

Die Session liegt AES-256-GCM-verschlüsselt unter `data/` (Key in `data/session.key` oder
`FASTSELL_ENC_KEY`). `data/` und die exportierte `fastsell-session.json` enthalten die Login-Cookies
(≈ Passwort) – gesichert behandeln und **nicht** ins Git.

---

## 6. Checkliste

- [ ] `npm ci && npm run build` fehlerfrei
- [ ] Key in `.env.production.local` **oder** `EnvironmentFile` (chmod 600), nicht in Git
- [ ] `npx playwright install chromium` + `install-deps`
- [ ] nginx: `client_max_body_size`, SSE-`location` mit `proxy_buffering off`
- [ ] `data/` gesichert, aus Git ausgeschlossen
- [ ] Reverse-Proxy/TLS davor (Auth/Zugriffsschutz)
