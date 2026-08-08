import { FormEvent, useEffect, useState } from "react";
import { ledgerApi, type AgentChatEvent } from "../api/client";
import { Sheet } from "../components/Sheet";

const EXAMPLES = [
  "¿Cuánto gasté en restaurantes el mes pasado?",
  "¿Cómo cierro el mes a este ritmo?",
  "¿Cuánto tengo neto?",
] as const;

type ChatMessage = {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly citations?: readonly { readonly kind: string; readonly id?: string; readonly label: string }[];
  readonly proposal?: { readonly eventId: string; readonly categoryId: string; readonly message: string };
  readonly requestId?: string;
};

export function AssistantSheet({
  month,
  idToken,
  demoMode,
  onClose,
  onMonthChanged,
}: {
  month: string;
  idToken: string;
  demoMode: boolean;
  onClose(): void;
  /** Bumps when parent month changes so the sheet clears. */
  onMonthChanged: number;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [requestId, setRequestId] = useState<string>();
  const [sessionId, setSessionId] = useState<string>();

  useEffect(() => {
    setMessages([]);
    setDraft("");
    setError(undefined);
    setRequestId(undefined);
    setSessionId(undefined);
  }, [onMonthChanged, month]);

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(undefined);
    setRequestId(undefined);
    setMessages((current) => [...current, { role: "user", text: message }, { role: "assistant", text: "" }]);
    setDraft("");

    if (demoMode) {
      setMessages((current) => {
        const next = [...current];
        next[next.length - 1] = {
          role: "assistant",
          text: "En modo mock el asistente no consulta Bedrock. Despliega el proxy para preguntar con datos reales.",
        };
        return next;
      });
      setBusy(false);
      return;
    }

    let assistantText = "";
    const citations: { kind: string; id?: string; label: string }[] = [];
    let proposal: ChatMessage["proposal"];

    try {
      const nextSession = await ledgerApi.streamAgentChat(
        { message, month, sessionId },
        idToken,
        (event: AgentChatEvent) => {
          if (event.type === "token") {
            assistantText += event.text;
            setMessages((current) => {
              const next = [...current];
              next[next.length - 1] = {
                role: "assistant",
                text: assistantText,
                citations: [...citations],
                proposal,
              };
              return next;
            });
          }
          if (event.type === "citation") {
            citations.push({ kind: event.kind, id: event.id, label: event.label });
          }
          if (event.type === "proposal") {
            proposal = {
              eventId: event.eventId,
              categoryId: event.categoryId,
              message: event.message,
            };
          }
          if (event.type === "done") {
            setSessionId(event.sessionId);
            setRequestId(event.requestId);
          }
          if (event.type === "error") {
            setError(event.message);
            setRequestId(event.requestId);
          }
        },
      );
      setSessionId(nextSession);
      setMessages((current) => {
        const next = [...current];
        next[next.length - 1] = {
          role: "assistant",
          text: assistantText || (error ? "" : "Listo."),
          citations: [...citations],
          proposal,
          requestId,
        };
        return next;
      });
    } catch (err) {
      const messageText = err instanceof Error ? err.message : "No pude consultar tus datos. Reintenta.";
      setError(messageText);
      setMessages((current) => current.slice(0, -1));
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void send(draft);
  };

  const confirmProposal = async (proposal: NonNullable<ChatMessage["proposal"]>) => {
    if (demoMode) return;
    setBusy(true);
    try {
      await ledgerApi.setEventCategory(
        proposal.eventId,
        { categoryId: proposal.categoryId, updateRule: true },
        idToken,
      );
      setMessages((current) => [
        ...current,
        { role: "assistant", text: `Listo: categoría ${proposal.categoryId} confirmada.` },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo confirmar la categoría.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet eyebrow="ASISTENTE" title={`Pregunta · ${month}`} onClose={onClose}>
      <div className="assistant-sheet">
        <p className="assistant-month-chip">Mes activo: {month}</p>
        {messages.length === 0 && (
          <div className="assistant-examples">
            <p>Ejemplos</p>
            {EXAMPLES.map((example) => (
              <button key={example} type="button" className="assistant-example" onClick={() => void send(example)}>
                {example}
              </button>
            ))}
          </div>
        )}
        <div className="assistant-thread">
          {messages.map((message, index) => (
            <div key={`${message.role}-${index}`} className={`assistant-bubble ${message.role}`}>
              <p>
                {message.role === "assistant" ? (
                  <span className="amt">{message.text || (busy && index === messages.length - 1 ? "…" : "")}</span>
                ) : (
                  message.text
                )}
              </p>
              {message.citations && message.citations.length > 0 && (
                <div className="assistant-citations">
                  {message.citations.map((citation) => (
                    <span key={`${citation.kind}-${citation.id ?? citation.label}`} className="assistant-citation">
                      {citation.label}
                    </span>
                  ))}
                </div>
              )}
              {message.proposal && (
                <div className="assistant-proposal">
                  <p>{message.proposal.message}</p>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy}
                    onClick={() => void confirmProposal(message.proposal!)}
                  >
                    Confirmar categoría
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        {error && (
          <p className="form-error">
            {error}
            {requestId ? (
              <>
                {" "}
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void navigator.clipboard.writeText(requestId)}
                >
                  Copiar request id
                </button>
              </>
            ) : null}
          </p>
        )}
        <form className="assistant-composer" onSubmit={onSubmit}>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Pregunta sobre tu mes…"
            disabled={busy}
            aria-label="Pregunta al asistente"
          />
          <button type="submit" disabled={busy || !draft.trim()}>
            Enviar
          </button>
        </form>
      </div>
    </Sheet>
  );
}
