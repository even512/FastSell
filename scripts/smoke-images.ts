import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { processPhoto } from "../lib/images";

// End-to-End-Test der Bildpipeline ohne Netzwerk/KI:
// erzeugt ein synthetisches Foto, jagt es durch processPhoto und schreibt beide Varianten raus.
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
  if (res.cutout) writeDataUrl("cutout.jpg", res.cutout);

  console.log("✅ optimiert erzeugt   ->", path.join(outDir, "optimized.jpg"));
  console.log(
    res.cutout
      ? `✅ Freisteller erzeugt -> ${path.join(outDir, "cutout.jpg")}`
      : "ℹ️  Freisteller übersprungen (optionales @imgly-Modell nicht installiert – auf normalem Rechner verfügbar)",
  );
  console.log("Smoke-Test der Bildpipeline OK.");
}

main().catch((e) => {
  console.error("❌ Smoke-Test fehlgeschlagen:", e);
  process.exit(1);
});
