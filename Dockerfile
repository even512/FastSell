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

# Chromium + System-Bibliotheken für Playwright (versionsgleich zum installierten playwright).
# Läuft auf der Build-Maschine (dort ist GitHub/CDN erreichbar).
RUN npx playwright install --with-deps chromium

# App-Code kopieren (Secrets/Daten sind via .dockerignore ausgeschlossen) und bauen
COPY . .
RUN npm run build

# Laufzeit
ENV NODE_ENV=production
ENV FASTSELL_POSTER_HEADLESS=true
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "run", "start"]
