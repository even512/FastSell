"use client";

import { useEffect, useRef, useState } from "react";
import type { Attribute, MissingField, PublishProgress, PublishRequest } from "@/lib/types";

/** Merged zwei Attribut-Listen (per Label dedupliziert; `extra` gewinnt). */
function mergeAttributes(base: Attribute[], extra: Attribute[]): Attribute[] {
  const norm = (s: string) => s.toLowerCase().trim();
  const map = new Map<string, Attribute>();
  for (const a of base) map.set(norm(a.label), a);
  for (const a of extra) map.set(norm(a.label), a);
  return [...map.values()];
}

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
  // Vom Nutzer nachgetragene Pflichtfeld-Werte – über mehrere Retry-Runden akkumuliert.
  const [providedAttributes, setProvidedAttributes] = useState<Attribute[]>([]);
  // Vom Backend gemeldete offene Pflichtfelder (bei action_required).
  const [missingFields, setMissingFields] = useState<MissingField[]>([]);
  // Eingaben zu den offenen Feldern (key -> Wert), mit Claude-Vorschlag vorbelegt.
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
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

  async function publish(extraAttributes: Attribute[] = providedAttributes) {
    setEvents([]);
    setState("running");
    setFinalUrl(undefined);
    setMissingFields([]);
    try {
      const base = buildRequest();
      const body: PublishRequest = {
        ...base,
        attributes: mergeAttributes(base.attributes, extraAttributes),
      };
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
      else if (last?.status === "action_required") {
        setState("action_required");
        if (last.missingFields?.length) {
          setMissingFields(last.missingFields);
          // Eingaben mit den Claude-Vorschlägen vorbelegen.
          setFieldValues(
            Object.fromEntries(last.missingFields.map((f) => [f.key, f.suggestion ?? ""])),
          );
        }
      } else if (last?.status === "error") setState("error");
      else setState(last ? "done" : "error");
    } catch (e) {
      setEvents((prev) => [...prev, { step: "error", status: "error", message: (e as Error).message }]);
      setState("error");
    }
  }

  // Nachgetragene Werte übernehmen und die Anzeige erneut (mit diesen Werten) einstellen.
  function retryWithFields() {
    const newAttrs: Attribute[] = missingFields
      .map((f) => ({ label: f.label, wert: (fieldValues[f.key] ?? "").trim() }))
      .filter((a) => a.wert);
    const merged = mergeAttributes(providedAttributes, newAttrs);
    setProvidedAttributes(merged);
    publish(merged);
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

      {/* Neue/unbekannte Pflichtfelder, die Kleinanzeigen für diese Kategorie verlangt. */}
      {state === "action_required" && missingFields.length > 0 && (
        <div className="space-y-4 rounded-xl bg-amber-50 p-4">
          <p className="text-sm text-amber-900">
            Kleinanzeigen verlangt für diese Kategorie {missingFields.length > 1 ? "noch Angaben" : "noch eine Angabe"}.
            Bitte {missingFields.length > 1 ? "die Werte" : "den Wert"} bestätigen oder anpassen – danach
            stelle ich die Anzeige automatisch fertig ein.
          </p>
          <div className="space-y-3">
            {missingFields.map((f) => (
              <div key={f.key} className="space-y-1">
                <label className="block text-sm font-semibold text-gray-700">{f.label}</label>
                {f.options && f.options.length > 0 ? (
                  <select
                    value={fieldValues[f.key] ?? ""}
                    onChange={(e) =>
                      setFieldValues((v) => ({ ...v, [f.key]: e.target.value }))
                    }
                    className="w-full rounded-lg border bg-white px-3 py-2 text-sm"
                  >
                    <option value="">Bitte wählen …</option>
                    {f.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={fieldValues[f.key] ?? ""}
                    onChange={(e) =>
                      setFieldValues((v) => ({ ...v, [f.key]: e.target.value }))
                    }
                    placeholder="Wert eingeben"
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                  />
                )}
                {f.suggestion && (
                  <p className="text-xs text-amber-700">Vorschlag von Claude: {f.suggestion}</p>
                )}
              </div>
            ))}
          </div>
          <button
            onClick={retryWithFields}
            className="w-full rounded-xl bg-brand py-3 font-semibold text-white"
          >
            Mit diesen Angaben erneut einstellen
          </button>
        </div>
      )}

      {/* Login-/Captcha-Fall: keine Feldabfrage, sondern Aktion im geöffneten Browser. */}
      {state === "action_required" && missingFields.length === 0 && (
        <div className="space-y-3 rounded-xl bg-amber-50 p-4">
          <p className="text-sm text-amber-800">
            Es ist eine Aktion nötig (Login oder Sicherheitsabfrage). Bitte im geöffneten Browser
            abschließen und danach erneut versuchen.
          </p>
          <button onClick={() => publish()} className="w-full rounded-xl bg-brand py-3 font-semibold text-white">
            Erneut versuchen
          </button>
        </div>
      )}

      {state === "error" && (
        <div className="space-y-3">
          <button onClick={() => publish()} className="w-full rounded-xl bg-brand py-3 font-semibold text-white">
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
