"use client";

import { useEffect, useRef, useState } from "react";
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
  const [state, setState] = useState<"running" | "done" | "error" | "action_required">("running");
  const [finalUrl, setFinalUrl] = useState<string | undefined>();
  const autoStarted = useRef(false);

  // Direkt lospublishen, sobald der Schritt erscheint – die Bestätigung war schon der
  // „Anzeige einstellen"-Button im Preis-Schritt. useRef-Guard: React StrictMode (Dev) führt
  // Effekte doppelt aus, ohne Guard würde die Anzeige doppelt gepostet.
  useEffect(() => {
    if (autoStarted.current) return;
    autoStarted.current = true;
    void publish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

      {(() => {
        const shot = [...events].reverse().find((e) => e.screenshot)?.screenshot;
        const details = [...events].reverse().find((e) => e.details)?.details;
        if (!shot && !details) return null;
        return (
          <div className="space-y-2">
            {shot && (
              <div className="space-y-1">
                <p className="text-xs text-gray-500">Screenshot beim Abbruch:</p>
                <img
                  src={shot}
                  alt="Screenshot der Seite beim Abbruch"
                  className="w-full rounded-lg border"
                />
              </div>
            )}
            {details && (
              <details className="rounded-lg border bg-gray-50 p-3">
                <summary className="cursor-pointer text-xs font-medium text-gray-600">
                  Technische Diagnose (zum Kopieren &amp; Schicken)
                </summary>
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-gray-700">
                  {details}
                </pre>
              </details>
            )}
          </div>
        );
      })()}

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
