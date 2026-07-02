# FastSell – Self-Hosting hinter nginx

FastSell ist eine Next.js-App: Sie läuft als **Node-Prozess** (Standard-Port `3000`), vor den du
deinen **nginx als Reverse-Proxy** setzt. Der API-Key wird **serverseitig** genutzt und ist im Browser
**nie** sichtbar.

```
Internet ── (dein gesicherter Reverse-Proxy / TLS) ──▶ nginx ──▶ 127.0.0.1:3000 (next start, FastSell)
```

---

## 1. Build & Start

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

`POST /api/login` öffnet einen **sichtbaren** Browser zum einmaligen Einloggen. Auf einem
Server ohne Desktop dafür entweder:

- den Login **einmal lokal** (mit Desktop) durchführen und die erzeugte `data/`-Session auf den
  Server kopieren, oder
- auf dem Server ein virtuelles Display nutzen (`xvfb-run`), falls dort ein Captcha lösbar ist.

Die Session liegt AES-256-GCM-verschlüsselt unter `data/` (Key in `data/session.key` oder
`FASTSELL_ENC_KEY`). `data/` gehört gesichert und **nicht** ins Git.

---

## 6. Checkliste

- [ ] `npm ci && npm run build` fehlerfrei
- [ ] Key in `.env.production.local` **oder** `EnvironmentFile` (chmod 600), nicht in Git
- [ ] `npx playwright install chromium` + `install-deps`
- [ ] nginx: `client_max_body_size`, SSE-`location` mit `proxy_buffering off`
- [ ] `data/` gesichert, aus Git ausgeschlossen
- [ ] Reverse-Proxy/TLS davor (Auth/Zugriffsschutz)
