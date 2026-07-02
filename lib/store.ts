import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Attribute, PriceType } from "./types";

// Schlanker JSON-Datei-Store (keine native Abhängigkeit, kein Binär-Download).
// Reicht für den Einzelnutzer-Workflow: gespeicherter Login + Anzeigen-Historie.

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");

export interface StoredSession {
  label: string;
  storageState: string; // AES-256-GCM verschlüsselter storageState-JSON
  updatedAt: string;
}

export interface Listing {
  id: string;
  title: string;
  category: string;
  condition: string;
  description: string;
  attributes: Attribute[];
  photos: string[]; // gespeicherte Foto-Dateipfade (unter data/photos) oder data-URLs
  priceType: PriceType;
  priceCents: number;
  status: "draft" | "publishing" | "published" | "error";
  kleinanzeigenUrl?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

interface StoreData {
  sessions: StoredSession[];
  listings: Listing[];
}

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function read(): StoreData {
  try {
    const raw = fs.readFileSync(STORE_FILE, "utf8");
    const data = JSON.parse(raw) as Partial<StoreData>;
    return { sessions: data.sessions ?? [], listings: data.listings ?? [] };
  } catch {
    return { sessions: [], listings: [] };
  }
}

function write(data: StoreData) {
  ensureDir();
  // atomar: erst in temporäre Datei, dann umbenennen
  const tmp = `${STORE_FILE}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

// --- Sessions ---

export function getSession(label = "default"): StoredSession | null {
  return read().sessions.find((s) => s.label === label) ?? null;
}

export function setSession(label: string, storageState: string): void {
  const data = read();
  const now = new Date().toISOString();
  const existing = data.sessions.find((s) => s.label === label);
  if (existing) {
    existing.storageState = storageState;
    existing.updatedAt = now;
  } else {
    data.sessions.push({ label, storageState, updatedAt: now });
  }
  write(data);
}

// --- Listings ---

export function addListing(
  input: Omit<Listing, "id" | "createdAt" | "updatedAt">,
): Listing {
  const data = read();
  const now = new Date().toISOString();
  const listing: Listing = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
  data.listings.unshift(listing);
  write(data);
  return listing;
}

export function updateListing(id: string, patch: Partial<Listing>): Listing | null {
  const data = read();
  const listing = data.listings.find((l) => l.id === id);
  if (!listing) return null;
  Object.assign(listing, patch, { updatedAt: new Date().toISOString() });
  write(data);
  return listing;
}

export function listListings(): Listing[] {
  return read().listings;
}
