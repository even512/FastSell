"use client";

import { type ChangeEvent, useEffect, useState } from "react";
import type { LoginResult, LoginStatus } from "@/lib/types";

// „Konto"-Screen: zeigt den Login-Status und startet den einmaligen Kleinanzeigen-Login.
// Der Login öffnet auf dem Backend-Rechner einen sichtbaren Browser. Schlägt er fehl (z. B.
// Bot-Wall auf einer Server-IP), wird der Grund + ein Screenshot der Seite angezeigt.
export function AccountPanel() {
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [result, setResult] = useState<LoginResult | null>(null);
  const [importState, setImportState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [importMsg, setImportMsg] = useState<string | null>(null);

  async function refresh() {
    try {
      const res = await fetch("/api/login");
      const data = (await res.json()) as LoginStatus;
      setHasSession(!!data.hasSession);
    } catch {
      setHasSession(null);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function login() {
    setState("running");
    setResult(null);
    try {
      const res = await fetch("/api/login", { method: "POST" });
      const data = (await res.json()) as LoginResult;
      setResult(data);
      if (data.ok) {
        setState("done");
        refresh();
      } else {
        setState("error");
      }
    } catch (e) {
      setResult({ ok: false, reason: (e as Error).message });
      setState("error");
    }
  }

  async function onImportFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // erlaubt, dieselbe Datei erneut zu wählen
    if (!file) return;
    setImportState("running");
    setImportMsg(null);
    try {
      const text = await file.text();
      const res = await fetch("/api/login/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: text,
      });
      const data = (await res.json()) as LoginResult;
      if (data.ok) {
        setImportState("done");
        setImportMsg("Session importiert – der Server kann jetzt Anzeigen einstellen.");
        refresh();
      } else {
        setImportState("error");
        setImportMsg(data.reason || "Import fehlgeschlagen.");
      }
    } catch (err) {
      setImportState("error");
      setImportMsg((err as Error).message);
    }
  }

  return (
    <div className="flex-1 space-y-5 px-4 pb-8 pt-4">
      <h2 className="text-lg font-bold">Konto</h2>

      {/* Status-Badge */}
      <div className="flex items-center gap-2">
        <span
          className={`h-2.5 w-2.5 rounded-full ${
            hasSession === null ? "bg-gray-300" : hasSession ? "bg-green-500" : "bg-amber-500"
          }`}
        />
        <span className="text-sm font-medium text-gray-700">
          {hasSession === null
            ? "Status wird geprüft …"
            : hasSession
              ? "Kleinanzeigen-Login gespeichert"
              : "Kein Login gespeichert"}
        </span>
      </div>

      <p className="text-sm text-gray-500">
        Zum automatischen Einstellen ist ein einmaliger Kleinanzeigen-Login nötig. „Einloggen"
        öffnet auf dem Backend-Rechner einen <strong>sichtbaren</strong> Browser – dort einmal
        einloggen (inkl. evtl. Sicherheitsabfrage). Die Session wird verschlüsselt lokal
        gespeichert. Empfehlung: Backend lokal / im Heimnetz betreiben.
      </p>

      {state !== "running" && (
        <button
          onClick={login}
          className="w-full rounded-xl bg-brand py-3 font-semibold text-white"
        >
          {hasSession ? "Erneut einloggen" : "Jetzt einloggen"}
        </button>
      )}

      {state === "running" && (
        <div className="flex items-center gap-2 rounded-xl bg-gray-100 p-4 text-sm text-gray-600">
          <span className="animate-pulse">⏳</span>
          Browser wird geöffnet – bitte im geöffneten Fenster einloggen …
        </div>
      )}

      {state === "done" && (
        <div className="rounded-xl bg-brand-light p-4 text-sm font-medium text-brand-dark">
          Login gespeichert. 🎉 Du kannst jetzt Anzeigen automatisch einstellen.
        </div>
      )}

      {state === "error" && result && (
        <div className="space-y-3 rounded-xl bg-red-50 p-4">
          <p className="text-sm font-medium text-red-800">Login fehlgeschlagen</p>
          {result.reason && <p className="text-sm text-red-700">{result.reason}</p>}
          {result.screenshot && (
            <div className="space-y-1">
              <p className="text-xs text-gray-500">Screenshot der Seite:</p>
              <img
                src={result.screenshot}
                alt="Screenshot der Login-Seite beim Fehlschlag"
                className="w-full rounded-lg border"
              />
            </div>
          )}
          <button
            onClick={login}
            className="w-full rounded-xl bg-brand py-3 font-semibold text-white"
          >
            Erneut versuchen
          </button>
        </div>
      )}

      {/* Session zwischen Rechnern übertragen (für headless Server ohne Bildschirm) */}
      <div className="space-y-3 border-t pt-5">
        <h3 className="text-sm font-semibold text-gray-700">Session übertragen</h3>
        <p className="text-sm text-gray-500">
          Läuft das Backend headless (Server/Docker, kein Bildschirm)? Dann logge dich einmal auf
          einem Rechner <strong>mit Bildschirm</strong> ein (dort öffnet sich ein echtes
          Browserfenster), <strong>exportiere</strong> die Session und <strong>importiere</strong>{" "}
          sie hier auf dem Server.
        </p>

        {hasSession && (
          <a
            href="/api/login/export"
            download="fastsell-session.json"
            className="block w-full rounded-xl border border-brand py-3 text-center font-semibold text-brand"
          >
            Session exportieren
          </a>
        )}

        <label className="block w-full cursor-pointer rounded-xl border py-3 text-center font-medium text-gray-600 hover:bg-gray-50">
          {importState === "running" ? "Importiere …" : "Session-Datei importieren"}
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={onImportFile}
          />
        </label>

        {importMsg && (
          <p className={`text-sm ${importState === "error" ? "text-red-700" : "text-brand-dark"}`}>
            {importMsg}
          </p>
        )}

        <p className="text-xs text-gray-400">
          Die Datei enthält deine Login-Cookies – wie ein Passwort behandeln, nur über einen sicheren
          Weg übertragen und danach löschen.
        </p>
      </div>
    </div>
  );
}
