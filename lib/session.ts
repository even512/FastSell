import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getSession, setSession } from "./store";

// AES-256-GCM Verschlüsselung des gespeicherten Kleinanzeigen-Logins (storageState).
// Der Key kommt aus FASTSELL_ENC_KEY (hex, 64 Zeichen) oder wird lokal generiert.

const KEY_FILE = path.join(process.cwd(), "data", "session.key");

function loadKey(): Buffer {
  const fromEnv = process.env.FASTSELL_ENC_KEY?.trim();
  if (fromEnv) {
    const key = Buffer.from(fromEnv, "hex");
    if (key.length !== 32) throw new Error("FASTSELL_ENC_KEY muss 32 Byte (64 hex-Zeichen) sein.");
    return key;
  }
  // lokal generieren & persistieren
  try {
    if (fs.existsSync(KEY_FILE)) return Buffer.from(fs.readFileSync(KEY_FILE, "utf8").trim(), "hex");
  } catch {
    /* ignore */
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, key.toString("hex"), { mode: 0o600 });
  return key;
}

export function encrypt(plaintext: string): string {
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext (alles hex)
  return [iv.toString("hex"), tag.toString("hex"), enc.toString("hex")].join(":");
}

export function decrypt(blob: string): string {
  const key = loadKey();
  const [ivHex, tagHex, dataHex] = blob.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("Beschädigter Session-Datensatz.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString(
    "utf8",
  );
}

/** Speichert den Playwright storageState verschlüsselt (upsert auf label). */
export async function saveStorageState(storageState: unknown, label = "default"): Promise<void> {
  const enc = encrypt(JSON.stringify(storageState));
  setSession(label, enc);
}

/** Lädt den entschlüsselten storageState oder null, wenn kein Login gespeichert ist. */
export async function loadStorageState(label = "default"): Promise<unknown | null> {
  const row = getSession(label);
  if (!row) return null;
  try {
    return JSON.parse(decrypt(row.storageState));
  } catch {
    return null;
  }
}

export async function hasSession(label = "default"): Promise<boolean> {
  return getSession(label) !== null;
}

/**
 * Exportiert den entschlüsselten storageState als JSON-String (oder null, wenn kein Login
 * gespeichert ist). Für die Übertragung von einem Rechner mit Bildschirm (dort einloggen)
 * auf einen headless Server. Achtung: enthält die Login-Cookies im Klartext – wie ein Passwort
 * behandeln.
 */
export async function exportStorageState(label = "default"): Promise<string | null> {
  const state = await loadStorageState(label);
  return state ? JSON.stringify(state) : null;
}

/** Grobe Plausibilitätsprüfung: sieht das nach einem Playwright-storageState aus? */
export function isStorageStateLike(value: unknown): value is { cookies: unknown[] } {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as { cookies?: unknown }).cookies)
  );
}
