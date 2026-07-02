"use client";

import { useEffect, useState } from "react";
import type { LoginResult, LoginStatus } from "@/lib/types";

// „Konto"-Screen: zeigt den Login-Status und startet den einmaligen Kleinanzeigen-Login.
// Der Login öffnet auf dem Backend-Rechner einen sichtbaren Browser. Schlägt er fehl (z. B.
// Bot-Wall auf einer Server-IP), wird der Grund + ein Screenshot der Seite angezeigt.
export function AccountPanel() {
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [result, setResult] = useState<LoginResult | null>(null);

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
    </div>
  );
}
