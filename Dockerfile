# FastSell – Container-Image (Next.js + Chromium für den Poster)
FROM node:22-bookworm-slim

WORKDIR /app

# System-Bibliothek für das Freisteller-Modell: onnxruntime-node (via @imgly/background-removal-node)
# linkt zur Laufzeit gegen libgomp (OpenMP). Ohne die Lib schlägt das Laden des Modells fehl.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libgomp1 \
  && rm -rf /var/lib/apt/lists/*

# Nur Manifeste zuerst -> Docker-Layer-Cache für Dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Sicherstellen, dass das Freisteller-Modell wirklich installiert wurde. Bricht den Build sonst hart
# ab, statt ein Image auszuliefern, in dem der Freisteller zur Laufzeit still fehlt ("Cannot find
# module"). Fängt auch den Fall, dass ein alter, gecachter npm-ci-Layer wiederverwendet wurde.
RUN test -d node_modules/@imgly/background-removal-node && test -d node_modules/onnxruntime-node \
  || (echo "FEHLER: Freisteller-Modell (@imgly/background-removal-node / onnxruntime-node) fehlt nach 'npm ci'. Build mit --no-cache neu bauen und Netzzugriff der Build-Maschine prüfen." && exit 1)

# Chromium + System-Bibliotheken für Playwright (versionsgleich zum installierten playwright).
# Läuft auf der Build-Maschine (dort ist GitHub/CDN erreichbar).
RUN npx playwright install --with-deps chromium

# App-Code kopieren (Secrets/Daten sind via .dockerignore ausgeschlossen) und bauen
COPY . .
RUN npm run build

# Smoke-Test durch den ECHTEN Produktions-Build: Server kurz starten und /api/cutout aufrufen.
# Fängt Bundling-Fehler im Webpack-Output (z. B. „Cannot find module"), die der reine
# Verzeichnis-Check oben nicht sieht – lieber Build-Abbruch als ein Image mit kaputtem Freisteller.
RUN node scripts/smoke-build.mjs

# Laufzeit
ENV NODE_ENV=production
ENV FASTSELL_POSTER_HEADLESS=true
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "run", "start"]
