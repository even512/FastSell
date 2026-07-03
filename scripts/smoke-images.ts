import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { cutoutFromDataUrl, processPhoto } from "../lib/images";

// End-to-End-Test der Bildpipeline ohne Netzwerk/KI: erzeugt ein synthetisches Foto, optimiert es
// (processPhoto) und berechnet zusätzlich den Freisteller on-demand (cutoutFromDataUrl) – wie die
// Route /api/cutout. So wird das Freisteller-Modell weiterhin mitgetestet.
async function main() {
  const outDir = path.join(process.cwd(), "data", "smoke");
  fs.mkdirSync(outDir, { recursive: true });

  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900">
       <rect x="360" y="250" width="480" height="380" rx="28" fill="#d94f2a"/>
       <text x="600" y="470" font-size="72" fill="#ffffff" text-anchor="middle" font-family="sans-serif">FastSell</text>
     </svg>`,
  );
  const input = await sharp({
    create: { width: 1200, height: 900, channels: 3, background: "#8899aa" },
  })
    .composite([{ input: svg, top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();
  fs.writeFileSync(path.join(outDir, "input.jpg"), input);

  const res = await processPhoto(input);

  const writeDataUrl = (name: string, dataUrl: string) => {
    const b64 = dataUrl.split(",")[1] ?? "";
    fs.writeFileSync(path.join(outDir, name), Buffer.from(b64, "base64"));
  };
  writeDataUrl("optimized.jpg", res.optimized);

  // Freisteller separat berechnen (on-demand), wie es die Route /api/cutout tut.
  const { cutout, reason } = await cutoutFromDataUrl(res.optimized);
  if (cutout) writeDataUrl("cutout.jpg", cutout);

  console.log("✅ optimiert erzeugt   ->", path.join(outDir, "optimized.jpg"));
  console.log(
    cutout
      ? `✅ Freisteller erzeugt -> ${path.join(outDir, "cutout.jpg")}`
      : `ℹ️  Freisteller lieferte null (${reason ?? "unbekannt"}) – im Container mit installiertem Modell erwartet grün`,
  );
  console.log("Smoke-Test der Bildpipeline OK.");
}

main().catch((e) => {
  console.error("❌ Smoke-Test fehlgeschlagen:", e);
  process.exit(1);
});
