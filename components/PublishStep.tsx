"use client";

import { useState } from "react";
import type { PublishProgress, PublishRequest } from "@/lib/types";

export function PublishStep({
  buildRequest,
  onNext,
  onBack,
}: {
  buildRequest: () => PublishRequest;
  onNext: () => void;
  onBack: () => void;
}) {
  const [events, setEvents] = useState<PublishProgress[]>([]);
  const [state, setState] = useState<"idle" | "running" | "done" | "error" | "action_required">(
    "idle",
  );
  const [finalUrl, setFinalUrl] = useState<string | undefined>();

  async function publish() {
    setEvents([]);
    setState("running");
    setFinalUrl(undefined);
    try {
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildRequest()),
      });
      if (!res.body) throw new Error("Kein Antwort-Stream.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let last: PublishProgress | null = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          try {
            const evt = JSON.parse(line.slice(5).trim()) as PublishProgress;
            last = evt;
            setEvents((prev) => [...prev, evt]);
            if (evt.url) setFinalUrl(evt.url);
          } catch {
            /* ignore malformed */
          }
        }
      }

      if (last?.status === "done") setState("done");
      else if (last?.status === "action_required") setState("action_required");
      else if (last?.status === "error") setState("error");
      else setState(last ? "done" : "error");
    } catch (e) {
      setEvents((prev) => [...prev, { step: "error", status: "error", message: (e as Error).message }]);
      setState("error");
    }
  }

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-bold">Anzeige einstellen</h2>

      {state === "idle" && (
        <div className="space-y-4">
          <p className="text-sm text-gray-500">
            Die Anzeige wird per Browser-Automation auf Kleinanzeigen veröffentlicht. Voraussetzung:
            einmaliger Login (Login-Schritt in der Anleitung). Bei einer Sicherheitsabfrage öffnet
            sich der Browser zum Lösen.
          </p>
          <div className="flex gap-3">
            <button onClick={onBack} className="rounded-xl border px-5 py-3 font-medium text-gray-600">
              Zurück
            </button>
            <button onClick={publish} className="flex-1 rounded-xl bg-brand py-3 font-semibold text-white">
              Jetzt einstellen
            </button>
          </div>
        </div>
      )}

      {state !== "idle" && (
        <ol className="space-y-2">
          {events.map((e, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <span className="mt-0.5">
                {e.status === "done"
                  ? "✅"
                  : e.status === "error"
                    ? "❌"
                    : e.status === "action_required"
                      ? "⏸️"
                      : "⏳"}
              </span>
              <span className={e.status === "error" ? "text-red-700" : "text-gray-700"}>
                {e.message}
              </span>
            </li>
          ))}
        </ol>
      )}

      {state === "done" && (
        <div className="space-y-3 rounded-xl bg-brand-light p-4">
          <p className="font-semibold text-brand-dark">Anzeige wurde eingestellt. 🎉</p>
          {finalUrl && (
            <a href={finalUrl} target="_blank" rel="noreferrer" className="block text-sm text-brand underline">
              Anzeige öffnen
            </a>
          )}
          <button onClick={onNext} className="w-full rounded-xl bg-brand py-3 font-semibold text-white">
            Nächster Artikel →
          </button>
        </div>
      )}

      {state === "action_required" && (
        <div className="space-y-3 rounded-xl bg-amber-50 p-4">
          <p className="text-sm text-amber-800">
            Es ist eine Aktion nötig (Login oder Sicherheitsabfrage). Bitte im geöffneten Browser
            abschließen und danach erneut versuchen.
          </p>
          <button onClick={publish} className="w-full rounded-xl bg-brand py-3 font-semibold text-white">
            Erneut versuchen
          </button>
        </div>
      )}

      {state === "error" && (
        <div className="space-y-3">
          <button onClick={publish} className="w-full rounded-xl bg-brand py-3 font-semibold text-white">
            Erneut versuchen
          </button>
          <button onClick={onBack} className="w-full rounded-xl border py-3 font-medium text-gray-600">
            Zurück
          </button>
        </div>
      )}
    </div>
  );
}
