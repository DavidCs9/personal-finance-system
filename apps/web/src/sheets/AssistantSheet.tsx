import { FormEvent, useCallback, useEffect, useState } from "react";
import { ledgerApi, type AgentChatEvent, type AssistantMemory } from "../api/client";
import { Amt } from "../components/Amt";
import { Sheet } from "../components/Sheet";
import { AssistantMarkdown } from "../lib/assistant-markdown";
import { money } from "../lib/format";

const EXAMPLES = [
  "¿Cuánto gasté en restaurantes el mes pasado?",
  "¿Cómo cierro el mes a este ritmo?",
  "¿Cuánto tengo neto?",
] as const;

const tagChangeLabel = (change: Extract<AgentChatEvent, { type: "mutation" }>["change"]): string => {
  const parts = [
    ...(change.addTags?.length ? [`Agregar ${change.addTags.join(", ")}`] : []),
    ...(change.removeTags?.length ? [`Quitar ${change.removeTags.join(", ")}`] : []),
  ];
  return parts.join(" · ") || "Etiquetas sin cambios";
};

type ToolActivity = {
  readonly toolUseId: string;
  readonly name: string;
  readonly label: string;
  readonly attempt: number;
  readonly state: "running" | "complete" | "failed";
  readonly durationMs?: number;
  readonly startedAt?: number;
  readonly summary?: string;
  readonly material?: boolean;
  readonly message?: string;
};

type ReasoningActivity = {
  readonly reasoningId: string;
  readonly label: string;
  readonly state: "running" | "complete" | "stopped";
  readonly startedAt?: number;
  readonly durationMs?: number;
};

type AssistantPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly activity: ToolActivity }
  | { readonly kind: "reasoning"; readonly activity: ReasoningActivity };

type ChatMessage = {
  readonly role: "user" | "assistant";
  readonly text?: string;
  readonly parts?: readonly AssistantPart[];
  readonly citations?: readonly { readonly kind: string; readonly id?: string; readonly label: string }[];
  readonly proposal?: { readonly kind: "recategorize"; readonly eventId: string; readonly categoryId: string; readonly message: string };
  readonly mutation?: Extract<AgentChatEvent, { type: "mutation" }>;
  readonly requestId?: string;
};

export function AssistantSheet({
  month,
  idToken,
  demoMode,
  onClose,
  onMonthChanged,
  onMutated,
}: {
  month: string;
  idToken: string;
  demoMode: boolean;
  onClose(): void;
  /** Bumps when parent month changes so the sheet clears. */
  onMonthChanged: number;
  onMutated(): void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [requestId, setRequestId] = useState<string>();
  const [sessionId, setSessionId] = useState<string>();
  const [memories, setMemories] = useState<readonly AssistantMemory[]>([]);
  const [memoriesOpen, setMemoriesOpen] = useState(false);
  const [memoriesLoading, setMemoriesLoading] = useState(false);
  const [memoriesError, setMemoriesError] = useState<string>();
  const [deletingMemoryId, setDeletingMemoryId] = useState<string>();

  useEffect(() => {
    setMessages([]);
    setDraft("");
    setError(undefined);
    setRequestId(undefined);
    setSessionId(undefined);
  }, [onMonthChanged, month]);

  const loadMemories = useCallback(async () => {
    if (demoMode) return;
    setMemoriesLoading(true);
    setMemoriesError(undefined);
    try {
      const result = await ledgerApi.listAssistantMemories(idToken);
      setMemories(result.memories);
    } catch (err) {
      setMemoriesError(err instanceof Error ? err.message : "No pude cargar tus memorias.");
    } finally {
      setMemoriesLoading(false);
    }
  }, [demoMode, idToken]);

  useEffect(() => {
    if (!memoriesOpen) return;
    void loadMemories();
  }, [loadMemories, memoriesOpen]);

  const deleteMemory = async (memoryId: string) => {
    setDeletingMemoryId(memoryId);
    setMemoriesError(undefined);
    try {
      await ledgerApi.deleteAssistantMemory(memoryId, idToken);
      setMemories((current) => current.filter((memory) => memory.id !== memoryId));
    } catch (err) {
      setMemoriesError(err instanceof Error ? err.message : "No se pudo borrar la memoria.");
      throw err;
    } finally {
      setDeletingMemoryId(undefined);
    }
  };

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(undefined);
    setRequestId(undefined);
    setMessages((current) => [...current, { role: "user", text: message }, { role: "assistant", parts: [] }]);
    setDraft("");

    if (demoMode) {
      setMessages((current) => {
        const next = [...current];
        next[next.length - 1] = {
          role: "assistant",
          parts: [
            {
              kind: "reasoning",
              activity: {
                reasoningId: "demo-reasoning",
                label: "Analizando contexto y restricciones",
                state: "complete",
                durationMs: 1_240,
              },
            },
            { kind: "text", text: "Voy a revisar el resumen del mes.\n\n" },
            {
              kind: "tool",
              activity: {
                toolUseId: "demo-month-snapshot",
                name: "month_snapshot",
                label: "Revisando el resumen del mes",
                attempt: 1,
                state: "complete",
                durationMs: 180,
                summary: `Resumen de ${month} consultado.`,
                material: true,
              },
            },
            { kind: "text", text: "\nTambién revisé los movimientos.\n\n" },
            {
              kind: "tool",
              activity: {
                toolUseId: "demo-movements",
                name: "list_movements",
                label: "Revisando movimientos",
                attempt: 1,
                state: "complete",
                durationMs: 340,
                summary: "Revisé 8 movimientos.",
                material: true,
              },
            },
            { kind: "text", text: "\nEn modo mock el asistente no consulta Bedrock. Despliega el proxy para preguntar con datos reales." },
          ],
        };
        return next;
      });
      setBusy(false);
      return;
    }

    const parts: AssistantPart[] = [];
    const citations: { kind: string; id?: string; label: string }[] = [];
    let proposal: ChatMessage["proposal"];
    let mutation: ChatMessage["mutation"];
    let latestRequestId: string | undefined;
    const receivedMutations = new Set<string>();

    const publish = () => {
      setMessages((current) => {
        const next = [...current];
        next[next.length - 1] = {
          role: "assistant",
          parts: [...parts],
          citations: [...citations],
          proposal,
          mutation,
          requestId: latestRequestId,
        };
        return next;
      });
    };

    const updateTool = (toolUseId: string, activity: ToolActivity) => {
      const index = parts.findIndex((part) => part.kind === "tool" && part.activity.toolUseId === toolUseId);
      if (index >= 0) parts[index] = { kind: "tool", activity };
      else parts.push({ kind: "tool", activity });
    };

    const updateReasoning = (reasoningId: string, activity: ReasoningActivity) => {
      const index = parts.findIndex((part) => part.kind === "reasoning" && part.activity.reasoningId === reasoningId);
      if (index >= 0) parts[index] = { kind: "reasoning", activity };
      else parts.push({ kind: "reasoning", activity });
    };

    const markRunningActivityUnavailable = () => {
      const now = Date.now();
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (part?.kind === "tool" && part.activity.state === "running") {
          parts[index] = {
            kind: "tool",
            activity: {
              ...part.activity,
              state: "failed",
              durationMs: part.activity.startedAt === undefined ? undefined : Math.max(0, now - part.activity.startedAt),
              message: `No se pudo completar: ${part.activity.label.toLowerCase()}.`,
            },
          };
        }
        if (part?.kind === "reasoning" && part.activity.state === "running") {
          parts[index] = {
            kind: "reasoning",
            activity: {
              ...part.activity,
              state: "stopped",
              durationMs: part.activity.startedAt === undefined ? undefined : Math.max(0, now - part.activity.startedAt),
            },
          };
        }
      }
    };

    try {
      const nextSession = await ledgerApi.streamAgentChat(
        { message, month, sessionId },
        idToken,
        (event: AgentChatEvent) => {
          if (event.type === "token") {
            const last = parts[parts.length - 1];
            if (last?.kind === "text") parts[parts.length - 1] = { kind: "text", text: last.text + event.text };
            else parts.push({ kind: "text", text: event.text });
            publish();
          }
          if (event.type === "reasoning_start") {
            updateReasoning(event.reasoningId, {
              reasoningId: event.reasoningId,
              label: event.label,
              state: "running",
              startedAt: Date.now(),
            });
            publish();
          }
          if (event.type === "reasoning_complete") {
            const current = parts.find((part) => part.kind === "reasoning" && part.activity.reasoningId === event.reasoningId);
            updateReasoning(event.reasoningId, {
              reasoningId: event.reasoningId,
              label: current?.kind === "reasoning" ? current.activity.label : "Analizando contexto y restricciones",
              state: "complete",
              durationMs: event.durationMs,
            });
            publish();
          }
          if (event.type === "tool_start") {
            updateTool(event.toolUseId, {
              toolUseId: event.toolUseId,
              name: event.name,
              label: event.label,
              attempt: event.attempt,
              state: "running",
              startedAt: Date.now(),
            });
            publish();
          }
          if (event.type === "tool_complete") {
            updateTool(event.toolUseId, {
              toolUseId: event.toolUseId,
              name: event.name,
              label: event.label,
              attempt: event.attempt,
              state: "complete",
              durationMs: event.durationMs,
              summary: event.summary,
              material: event.material,
            });
            publish();
          }
          if (event.type === "tool_failed") {
            updateTool(event.toolUseId, {
              toolUseId: event.toolUseId,
              name: event.name,
              label: event.label,
              attempt: event.attempt,
              state: "failed",
              durationMs: event.durationMs,
              message: event.message,
            });
            publish();
          }
          if (event.type === "citation") {
            citations.push({ kind: event.kind, id: event.id, label: event.label });
            publish();
          }
          if (event.type === "proposal") {
            proposal = {
              kind: "recategorize",
              eventId: event.eventId,
              categoryId: event.categoryId,
              message: event.message,
            };
            publish();
          }
          if (event.type === "mutation") {
            mutation = event;
            const mutationKey = `${event.action}:${event.operationId}`;
            if (!receivedMutations.has(mutationKey)) {
              receivedMutations.add(mutationKey);
              onMutated();
            }
            publish();
          }
          if (event.type === "done") {
            setSessionId(event.sessionId);
            setRequestId(event.requestId);
            latestRequestId = event.requestId;
            publish();
          }
          if (event.type === "error") {
            markRunningActivityUnavailable();
            setError(event.message);
            setRequestId(event.requestId);
            latestRequestId = event.requestId;
            publish();
          }
        },
      );
      setSessionId(nextSession);
      if (parts.length === 0) parts.push({ kind: "text", text: "Listo." });
      publish();
    } catch (err) {
      const messageText = err instanceof Error ? err.message : "No pude consultar tus datos. Reintenta.";
      markRunningActivityUnavailable();
      if (parts.length === 0) parts.push({ kind: "text", text: "No pude terminar la consulta." });
      setError(messageText);
      publish();
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
        { role: "assistant", parts: [{ kind: "text", text: `Listo: categoría ${proposal.categoryId} confirmada.` }] },
      ]);
      onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo confirmar el cambio.");
    } finally {
      setBusy(false);
    }
  };

  if (memoriesOpen) {
    return (
      <AssistantMemoriesSheet
        memories={memories}
        loading={memoriesLoading}
        error={memoriesError}
        deletingMemoryId={deletingMemoryId}
        onClose={() => setMemoriesOpen(false)}
        onRetry={loadMemories}
        onDelete={deleteMemory}
      />
    );
  }

  return (
    <Sheet eyebrow="ASISTENTE" title={`Pregunta · ${month}`} onClose={onClose}>
      <div className="assistant-sheet">
        <p className="assistant-month-chip">Mes activo: {month}</p>
        <button type="button" className="assistant-memory-link" onClick={() => setMemoriesOpen(true)}>
          Gestionar memoria
        </button>
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
              {message.role === "assistant" ? (
                message.parts && message.parts.length > 0 ? (
                  message.parts.map((part, partIndex) => {
                    if (part.kind === "text") {
                      return <AssistantMarkdown key={`text-${partIndex}`} text={part.text} />;
                    }
                    if (part.kind === "reasoning") {
                      return <AssistantReasoningActivity key={part.activity.reasoningId} activity={part.activity} />;
                    }
                    return <AssistantToolActivity key={part.activity.toolUseId} activity={part.activity} />;
                  })
                ) : (
                  <p className="assistant-md-p">{busy && index === messages.length - 1 ? "…" : ""}</p>
                )
              ) : (
                <p>{message.text}</p>
              )}
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
              {message.mutation && (
                <div className="assistant-proposal">
                  <p>
                    {message.mutation.action === "applied" ? "Etiquetas actualizadas" : "Edición deshecha"}
                    {" · "}{message.mutation.movementCount} movimientos · <Amt>{money(message.mutation.amountMinor)}</Amt>
                  </p>
                  <small>{message.mutation.fromDay}–{message.mutation.toDay} · {tagChangeLabel(message.mutation.change)}</small>
                  <small>Puedes pedir “deshaz ese cambio” en el chat.</small>
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

function AssistantMemoriesSheet({
  memories,
  loading,
  error,
  deletingMemoryId,
  onClose,
  onRetry,
  onDelete,
}: {
  readonly memories: readonly AssistantMemory[];
  readonly loading: boolean;
  readonly error?: string;
  readonly deletingMemoryId?: string;
  onClose(): void;
  onRetry(): Promise<void>;
  onDelete(memoryId: string): Promise<void>;
}) {
  const [pendingDeleteId, setPendingDeleteId] = useState<string>();

  return (
    <Sheet
      eyebrow="ASISTENTE"
      title="Lo que recuerdo"
      onClose={onClose}
      className="assistant-memories-sheet"
      closeLabel="Volver al chat"
      closeIcon="←"
    >
      <div className="assistant-memories">
        <p className="assistant-memories-intro">
          Contexto que Olbia conserva entre conversaciones. Nunca cambia tus cifras ni movimientos.
        </p>
        {error && (
          <div className="assistant-memories-error" role="alert">
            <p>{error}</p>
            <button type="button" className="text-button" onClick={() => void onRetry()} disabled={loading}>
              Reintentar
            </button>
          </div>
        )}
        {loading ? (
          <p className="assistant-memories-state" role="status">Cargando memorias…</p>
        ) : memories.length === 0 && !error ? (
          <div className="assistant-memories-empty">
            <strong>Aún no hay nada guardado.</strong>
            <p>Cuando le pidas a Olbia recordar algo, aparecerá aquí.</p>
          </div>
        ) : memories.length > 0 ? (
          <ul className="assistant-memories-list">
            {memories.map((memory) => (
              <li key={memory.id} className={pendingDeleteId === memory.id ? "confirming" : undefined}>
                <p>{memory.text}</p>
                {pendingDeleteId === memory.id ? (
                  <div className="assistant-memory-confirm">
                    <span>Esta acción no se puede deshacer.</span>
                    <div>
                      <button
                        type="button"
                        className="assistant-memory-cancel"
                        onClick={() => setPendingDeleteId(undefined)}
                        disabled={deletingMemoryId === memory.id}
                      >
                        Cancelar
                      </button>
                      <button
                        type="button"
                        className="assistant-memory-delete confirm"
                        onClick={() => void onDelete(memory.id).then(() => setPendingDeleteId(undefined)).catch(() => undefined)}
                        disabled={deletingMemoryId === memory.id}
                      >
                        {deletingMemoryId === memory.id ? "Borrando…" : "Confirmar borrar"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="assistant-memory-delete"
                    onClick={() => setPendingDeleteId(memory.id)}
                  >
                    Borrar
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Sheet>
  );
}

function AssistantReasoningActivity({ activity }: { readonly activity: ReasoningActivity }) {
  const duration = activity.durationMs === undefined
    ? undefined
    : `${Math.max(0.1, activity.durationMs / 1000).toFixed(activity.durationMs < 1000 ? 1 : 0)} s`;
  return (
    <div className={`assistant-reasoning ${activity.state}`} role="status">
      <span className="assistant-reasoning-mark" aria-hidden="true" />
      <span>{activity.state === "running"
        ? activity.label
        : activity.state === "complete"
          ? "Razonamiento completado"
          : "Razonamiento interrumpido"}</span>
      {duration && <span className="assistant-reasoning-duration">{duration}</span>}
    </div>
  );
}

function AssistantToolActivity({ activity }: { readonly activity: ToolActivity }) {
  const duration = activity.durationMs === undefined
    ? undefined
    : `${Math.max(0.1, activity.durationMs / 1000).toFixed(activity.durationMs < 1000 ? 1 : 0)} s`;
  const status = activity.state === "running" ? "En curso" : activity.state === "failed" ? "No disponible" : "Listo";
  const metadata = <span className="assistant-tool-meta">{activity.state === "running" ? status : duration ?? status}</span>;

  return (
    <details className={`assistant-tool ${activity.state}`}>
      <summary>
        <span className="assistant-tool-summary">
          <ToolIcon name={activity.name} />
          <span className="assistant-tool-label">{activity.label}</span>
        </span>
        {metadata}
      </summary>
      <div className="assistant-tool-detail">
        <p className="assistant-tool-status">{status} · intento {activity.attempt}{duration ? ` · ${duration}` : ""}</p>
        <code>{activity.name}</code>
        {activity.summary && <p>{activity.summary}</p>}
        {activity.message && <p className="assistant-tool-problem">{activity.message}</p>}
      </div>
    </details>
  );
}

function ToolIcon({ name }: { readonly name: string }) {
  const props = {
    className: "assistant-tool-icon",
    viewBox: "0 0 24 24",
    fill: "none",
    "aria-hidden": true,
  } as const;

  switch (name) {
    case "month_snapshot":
      return <svg {...props}><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4m8-4v4M4 10h16" /></svg>;
    case "spend_by_category":
      return <svg {...props}><path d="M4 5h9l7 7-8 8-7-7V5Z" /><circle cx="8.5" cy="9.5" r="1" /></svg>;
    case "spend_by_merchant":
      return <svg {...props}><path d="M4 10h16v9H4zM3 10l2-5h14l2 5M7 14h3m4 5v-5h3" /></svg>;
    case "list_movements":
      return <svg {...props}><path d="M7 6h13M7 12h13M7 18h13" /><circle cx="4" cy="6" r=".8" fill="currentColor" /><circle cx="4" cy="12" r=".8" fill="currentColor" /><circle cx="4" cy="18" r=".8" fill="currentColor" /></svg>;
    case "compare_months":
      return <svg {...props}><path d="M4 8h13m0 0-3-3m3 3-3 3M20 16H7m0 0 3-3m-3 3 3 3" /></svg>;
    case "wealth_snapshot":
      return <svg {...props}><path d="M3 5h18M12 5v15M7 9l-3 5h6L7 9Zm10 0-3 5h6l-3-5ZM8 20h8" /></svg>;
    case "propose_recategorize":
      return <svg {...props}><path d="m5 18 1-4L16.5 3.5a2.1 2.1 0 0 1 3 3L9 17l-4 1Z" /><path d="m14.5 5.5 4 4" /></svg>;
    default:
      return <svg {...props}><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4 4" /></svg>;
  }
}
