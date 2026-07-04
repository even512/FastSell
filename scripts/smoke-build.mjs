// Smoke-Test durch den ECHTEN Produktions-Build (läuft im Docker-Build): startet `next start`
// und ruft /api/cutout mit einem synthetischen Foto auf. Schlägt der Freisteller fehl (z. B.
// Bundling-/Modell-Problem), bricht der Image-Build hart ab statt ein kaputtes Image zu liefern.
// Hintergrund: `npm run smoke:images` testet via tsx nur den Quellcode – der Webpack-Fehler
// „Cannot find module @imgly/background-removal-node" rutschte daran vorbei.
import { spawn } from "node:child_process";
import sharp from "sharp";

const PORT = process.env.SMOKE_PORT || "3777";
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn("npx", ["next", "start", "-p", PORT], { stdio: "inherit" });

function fail(msg) {
  console.error(`❌ Build-Smoke-Test fehlgeschlagen: ${msg}`);
  server.kill();
  process.exit(1);
}

async function waitReady(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE, { redirect: "manual" });
      if (res.status < 500) return;
    } catch {
      /* Server startet noch */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  fail("Server wurde nicht rechtzeitig bereit.");
}

async function main() {
  await waitReady();

  // Synthetisches „Produktfoto": Objekt auf ruhigem Hintergrund (wie scripts/smoke-images.ts).
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">
       <rect x="240" y="170" width="320" height="260" rx="24" fill="#d94f2a"/>
     </svg>`,
  );
  const input = await sharp({
    create: { width: 800, height: 600, channels: 3, background: "#8899aa" },
  })
    .composite([{ input: svg }])
    .jpeg({ quality: 90 })
    .toBuffer();

  const res = await fetch(`${BASE}/api/cutout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: `data:image/jpeg;base64,${input.toString("base64")}` }),
    // Modell-Inferenz auf CI-CPUs kann dauern.
    signal: AbortSignal.timeout(180_000),
  });
  const json = await res.json();
  if (!json.cutout) {
    fail(`/api/cutout lieferte keinen Freisteller (reason: ${json.reason ?? "unbekannt"})`);
  }

  console.log("✅ Build-Smoke-Test OK: Freisteller über den Produktions-Build erzeugt.");
  server.kill();
  process.exit(0);
}

main().catch((e) => fail(e.message));
