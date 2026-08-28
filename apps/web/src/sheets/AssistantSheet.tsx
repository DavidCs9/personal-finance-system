import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  ledgerApi,
  type AgentChatEvent,
  type AssistantMemory,
  type AssistantThread,
} from "../api/client";
import { Amt } from "../components/Amt";
import { Sheet } from "../components/Sheet";
import { AssistantMarkdown } from "../lib/assistant-markdown";
import { money } from "../lib/format";

const EXAMPLES = [
  "¿Cuánto gasté en restaurantes el mes pasado?",
  "¿Cómo cierro el mes a este ritmo?",
  "¿Cuánto tengo neto?",
] as const;

const assistantMonthLabel = (month: string): string => new Intl.DateTimeFormat("es-MX", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
}).format(new Date(`${month}-01T00:00:00Z`));

const mutationChangeLabel = (mutation: Extract<AgentChatEvent, { type: "mutation" }>): string => {
  if (mutation.kind === "category_edit") return `Categoría ${mutation.change.categoryId ?? "sin categoría"}`;
  const { change } = mutation;
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
  readonly mutations?: readonly Extract<AgentChatEvent, { type: "mutation" }>[];
  readonly requestId?: string;
};

export function AssistantSheet({
  month,
  idToken,
  demoMode,
  onClose,
  onMutated,
}: {
  month: string;
  idToken: string;
  demoMode: boolean;
  onClose(): void;
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
  const [threads, setThreads] = useState<readonly AssistantThread[]>([]);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [threadsLoading, setThreadsLoading] = useState(!demoMode);
  const [threadsError, setThreadsError] = useState<string>();
  const [deletingThreadId, setDeletingThreadId] = useState<string>();

  const openThread = useCallback(async (threadId: string, activate = true) => {
    if (demoMode) return;
    setThreadsLoading(true);
    setThreadsError(undefined);
    try {
      const result = await ledgerApi.getAssistantThread(threadId, idToken);
      setMessages(result.messages.map((message): ChatMessage => message.role === "assistant"
        ? { role: "assistant", parts: [{ kind: "text", text: message.text }] }
        : { role: "user", text: message.text }));
      setSessionId(result.thread.id);
      setThreads((current) => current.some((thread) => thread.id === result.thread.id)
        ? current.map((thread) => thread.id === result.thread.id ? result.thread : thread)
        : [result.thread, ...current]);
      if (activate) await ledgerApi.setActiveAssistantThread(result.thread.id, idToken);
      setThreadsOpen(false);
      setError(undefined);
      setRequestId(undefined);
    } catch (err) {
      setThreadsError(err instanceof Error ? err.message : "No pude abrir la conversación.");
      throw err;
    } finally {
      setThreadsLoading(false);
    }
  }, [demoMode, idToken]);

  const loadThreads = useCallback(async () => {
    if (demoMode) {
      setThreadsLoading(false);
      return;
    }
    setThreadsLoading(true);
    setThreadsError(undefined);
    try {
      const result = await ledgerApi.listAssistantThreads(idToken);
      setThreads(result.threads);
      if (result.activeThreadId) await openThread(result.activeThreadId, false);
    } catch (err) {
      setThreadsError(err instanceof Error ? err.message : "No pude cargar tus conversaciones.");
    } finally {
      setThreadsLoading(false);
    }
  }, [demoMode, idToken, openThread]);

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

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

  const startNewConversation = async () => {
    if (busy) return;
    setMessages([]);
    setDraft("");
    setError(undefined);
    setRequestId(undefined);
    setSessionId(undefined);
    setThreadsOpen(false);
    if (!demoMode) {
      try {
        await ledgerApi.setActiveAssistantThread(undefined, idToken);
      } catch (err) {
        setThreadsError(err instanceof Error ? err.message : "No pude iniciar una conversación nueva.");
      }
    }
  };

  const deleteThread = async (threadId: string) => {
    if (demoMode) return;
    setDeletingThreadId(threadId);
    setThreadsError(undefined);
    try {
      await ledgerApi.deleteAssistantThread(threadId, idToken);
      setThreads((current) => current.filter((thread) => thread.id !== threadId));
      if (sessionId === threadId) {
        setMessages([]);
        setSessionId(undefined);
        setRequestId(undefined);
      }
    } catch (err) {
      setThreadsError(err instanceof Error ? err.message : "No se pudo borrar la conversación.");
      throw err;
    } finally {
      setDeletingThreadId(undefined);
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
    const mutations: Extract<AgentChatEvent, { type: "mutation" }>[] = [];
    let latestRequestId: string | undefined;
    const receivedMutations = new Set<string>();

    const publish = () => {
      setMessages((current) => {
        const next = [...current];
        next[next.length - 1] = {
          role: "assistant",
          parts: [...parts],
          citations: [...citations],
          mutations: [...mutations],
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
          if (event.type === "mutation") {
            const mutationKey = `${event.action}:${event.operationId}`;
            if (!receivedMutations.has(mutationKey)) {
              receivedMutations.add(mutationKey);
              mutations.push(event);
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
      if (nextSession) {
        const now = new Date().toISOString();
        const normalizedTitle = message.replace(/\s+/g, " ");
        const title = normalizedTitle.length <= 72
          ? normalizedTitle
          : `${normalizedTitle.slice(0, 69).trimEnd()}…`;
        setThreads((current) => {
          const existing = current.find((thread) => thread.id === nextSession);
          const updated: AssistantThread = existing
            ? { ...existing, updatedAt: now }
            : {
                id: nextSession,
                title,
                firstMonth: month,
                createdAt: now,
                updatedAt: now,
              };
          return [updated, ...current.filter((thread) => thread.id !== nextSession)].slice(0, 20);
        });
      }
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

  if (threadsOpen) {
    return (
      <AssistantThreadsSheet
        threads={threads}
        activeThreadId={sessionId}
        loading={threadsLoading}
        error={threadsError}
        deletingThreadId={deletingThreadId}
        onClose={() => setThreadsOpen(false)}
        onRetry={loadThreads}
        onOpen={openThread}
        onDelete={deleteThread}
        onNew={startNewConversation}
      />
    );
  }

  return (
    <Sheet eyebrow="ASISTENTE" title="Conversación" onClose={onClose}>
      <div className="assistant-sheet">
        <div className="assistant-context-row">
          <p className="assistant-month-chip">Contexto: {assistantMonthLabel(month)}</p>
          {messages.length > 0 && (
            <button type="button" className="assistant-new-thread" onClick={() => void startNewConversation()} disabled={busy}>
              Nueva conversación
            </button>
          )}
        </div>
        <div className="assistant-nav-links">
          <button type="button" className="assistant-memory-link" onClick={() => setThreadsOpen(true)}>
            Conversaciones{threads.length > 0 ? ` · ${threads.length}` : ""}
          </button>
          <button type="button" className="assistant-memory-link" onClick={() => setMemoriesOpen(true)}>
            Gestionar memoria
          </button>
        </div>
        {threadsLoading && messages.length === 0 && (
          <p className="assistant-history-state" role="status">Recuperando conversación…</p>
        )}
        {threadsError && messages.length === 0 && !threadsLoading && (
          <div className="assistant-history-error" role="alert">
            <p>{threadsError}</p>
            <button type="button" className="text-button" onClick={() => void loadThreads()}>Reintentar</button>
          </div>
        )}
        {messages.length === 0 && !threadsLoading && (
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
            <div key={`${message.role}-${index}`} className={`assistant-bubble private-sensitive ${message.role}`}>
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
              {message.mutations?.map((mutation) => (
                <div key={`${mutation.action}-${mutation.operationId}`} className="assistant-proposal">
                  <p>
                    {mutation.action === "applied"
                      ? mutation.kind === "category_edit" ? "Categoría actualizada" : "Etiquetas actualizadas"
                      : "Edición deshecha"}
                    {" · "}{mutation.movementCount} movimientos · <Amt>{money(mutation.amountMinor)}</Amt>
                  </p>
                  <small>{mutation.fromDay}–{mutation.toDay} · {mutationChangeLabel(mutation)}</small>
                  <small>Puedes pedir “deshaz ese cambio” en el chat.</small>
                </div>
              ))}
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

const threadDate = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric" }).format(date);
};

function AssistantThreadsSheet({
  threads,
  activeThreadId,
  loading,
  error,
  deletingThreadId,
  onClose,
  onRetry,
  onOpen,
  onDelete,
  onNew,
}: {
  readonly threads: readonly AssistantThread[];
  readonly activeThreadId?: string;
  readonly loading: boolean;
  readonly error?: string;
  readonly deletingThreadId?: string;
  onClose(): void;
  onRetry(): Promise<void>;
  onOpen(threadId: string): Promise<void>;
  onDelete(threadId: string): Promise<void>;
  onNew(): Promise<void>;
}) {
  const [pendingDeleteId, setPendingDeleteId] = useState<string>();

  return (
    <Sheet
      eyebrow="ASISTENTE"
      title="Conversaciones"
      onClose={onClose}
      className="assistant-memories-sheet assistant-threads-sheet"
      closeLabel="Volver al chat"
      closeIcon="←"
    >
      <div className="assistant-memories">
        <div className="assistant-threads-intro">
          <p>Retoma una conversación o empieza otra sin perder las anteriores.</p>
          <button type="button" className="secondary-button" onClick={() => void onNew()}>
            Nueva conversación
          </button>
        </div>
        {error && (
          <div className="assistant-memories-error" role="alert">
            <p>{error}</p>
            <button type="button" className="text-button" onClick={() => void onRetry()} disabled={loading}>
              Reintentar
            </button>
          </div>
        )}
        {loading && threads.length === 0 ? (
          <p className="assistant-memories-state" role="status">Cargando conversaciones…</p>
        ) : threads.length === 0 && !error ? (
          <div className="assistant-memories-empty">
            <strong>Aún no hay conversaciones.</strong>
            <p>La primera aparecerá aquí después de que Olbia responda.</p>
          </div>
        ) : (
          <ul className="assistant-memories-list assistant-threads-list">
            {threads.map((thread) => (
              <li
                key={thread.id}
                className={[
                  thread.id === activeThreadId ? "active" : "",
                  pendingDeleteId === thread.id ? "confirming" : "",
                ].filter(Boolean).join(" ") || undefined}
              >
                <button
                  type="button"
                  className="assistant-thread-open"
                  onClick={() => void onOpen(thread.id).catch(() => undefined)}
                  disabled={loading || deletingThreadId === thread.id}
                >
                  <span className="private-sensitive">{thread.title}</span>
                  <small>
                    {thread.id === activeThreadId ? "Actual · " : ""}
                    {/^\d{4}-\d{2}$/.test(thread.firstMonth) ? `${thread.firstMonth} · ` : ""}
                    {threadDate(thread.updatedAt)}
                  </small>
                </button>
                {pendingDeleteId === thread.id ? (
                  <div className="assistant-memory-confirm">
                    <span>Se borrará esta conversación y no podrás retomarla.</span>
                    <div>
                      <button
                        type="button"
                        className="assistant-memory-cancel"
                        onClick={() => setPendingDeleteId(undefined)}
                        disabled={deletingThreadId === thread.id}
                      >
                        Cancelar
                      </button>
                      <button
                        type="button"
                        className="assistant-memory-delete confirm"
                        onClick={() => void onDelete(thread.id)
                          .then(() => setPendingDeleteId(undefined))
                          .catch(() => undefined)}
                        disabled={deletingThreadId === thread.id}
                      >
                        {deletingThreadId === thread.id ? "Borrando…" : "Confirmar borrar"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="assistant-memory-delete"
                    onClick={() => setPendingDeleteId(thread.id)}
                  >
                    Borrar
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
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
                <p className="private-sensitive">{memory.text}</p>
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
    case "preview_category_edit":
    case "apply_category_edit":
    case "undo_category_edit":
      return <svg {...props}><path d="m5 18 1-4L16.5 3.5a2.1 2.1 0 0 1 3 3L9 17l-4 1Z" /><path d="m14.5 5.5 4 4" /></svg>;
    default:
      return <svg {...props}><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4 4" /></svg>;
  }
}
