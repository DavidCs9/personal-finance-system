import type {
  AmexImportPreview,
  AmexImportResult,
  EventFeed,
  IngestionException,
  PurchaseEvent,
  SantanderImportDecision,
  SantanderImportPreview,
  SantanderImportResult,
  SantanderStatementImportPreview,
  SantanderStatementImportResult,
  StatementImportDecision,
} from "../types";
import type { MonthlyPlan } from "../monthly-plan";
import type { CardCycle } from "../card-cycle";
import type { CardLiabilitySnapshot, WealthOverview } from "../wealth";
import { CAJITA_ACCOUNT_ID, type MonthSummary, type WealthSnapshot } from "@finance/domain";

interface LedgerRuntimeConfig {
  readonly apiBaseUrl: string;
  /** Native API Gateway REST SSE endpoint for assistant chat. */
  readonly agentChatUrl?: string;
  readonly cognitoUserPoolId: string;
  readonly cognitoUserPoolClientId: string;
  readonly region: string;
  readonly vapidPublicKey?: string;
  readonly webAppUrl?: string;
}

interface CognitoChallenge {
  readonly kind: "new_password";
  readonly email: string;
  readonly session: string;
}

export interface LedgerSession {
  readonly idToken: string;
  readonly refreshToken: string;
}

export type SignInResult = ({ readonly kind: "signed_in" } & LedgerSession) | CognitoChallenge;

export interface NominaUploadResultItem {
  readonly filename: string;
  readonly status: "created" | "duplicate" | "failed";
  readonly uuid?: string;
  readonly month?: string;
  readonly totalMinor?: number;
  readonly error?: string;
}

export interface NominaUploadResponse {
  readonly results: readonly NominaUploadResultItem[];
  readonly created: number;
  readonly duplicates: number;
  readonly failed: number;
}

export interface AssistantMemory {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
}

declare global {
  interface Window { __LEDGER_CONFIG__?: LedgerRuntimeConfig; }
}

const config = (): LedgerRuntimeConfig => {
  if (!window.__LEDGER_CONFIG__) throw new Error("La configuración de Olbia no está disponible todavía.");
  return window.__LEDGER_CONFIG__;
};

const cognitoRequest = async (target: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const runtime = config();
  const response = await fetch(`https://cognito-idp.${runtime.region}.amazonaws.com/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify(payload),
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new CognitoRequestError(String(body.message ?? "No fue posible iniciar sesión."));
  return body;
};

const tokenFrom = (response: Record<string, unknown>): string | undefined =>
  (response.AuthenticationResult as Record<string, unknown> | undefined)?.IdToken as string | undefined;

const sessionFrom = (response: Record<string, unknown>): LedgerSession | undefined => {
  const result = response.AuthenticationResult as Record<string, unknown> | undefined;
  const idToken = result?.IdToken;
  const refreshToken = result?.RefreshToken;
  return typeof idToken === "string" && typeof refreshToken === "string" ? { idToken, refreshToken } : undefined;
};

const refreshTokenKey = "ledger-refresh-token";
const idTokenKey = "ledger-id-token";
const refreshBeforeExpiryMs = 2 * 60 * 1000;
export const sessionExpiredEvent = "olbia:session-expired";

class CognitoRequestError extends Error {}

let refreshPromise: Promise<string | undefined> | undefined;

const tokenExpiresAt = (token: string): number | undefined => {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const normalised = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalised.padEnd(Math.ceil(normalised.length / 4) * 4, "=");
    const expiresAt = (JSON.parse(atob(padded)) as { exp?: unknown }).exp;
    return typeof expiresAt === "number" ? expiresAt * 1000 : undefined;
  } catch {
    return undefined;
  }
};

export const isTokenFresh = (token: string | null | undefined, now = Date.now()): token is string => {
  if (!token) return false;
  const expiresAt = tokenExpiresAt(token);
  return expiresAt !== undefined && expiresAt - now > refreshBeforeExpiryMs;
};

const announceExpiredSession = () => {
  window.dispatchEvent(new Event(sessionExpiredEvent));
};

const clearStoredSession = () => {
  localStorage.removeItem(idTokenKey);
  localStorage.removeItem(refreshTokenKey);
};

const endedSessionError = () => {
  clearStoredSession();
  announceExpiredSession();
  return new Error("Tu sesión terminó. Vuelve a entrar.");
};

const refreshSession = async (): Promise<string | undefined> => {
  if (refreshPromise) return refreshPromise;
  const refreshToken = localStorage.getItem(refreshTokenKey);
  if (!refreshToken) return undefined;

  const operation = (async () => {
    try {
      const runtime = config();
      const result = await cognitoRequest("InitiateAuth", {
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: runtime.cognitoUserPoolClientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      });
      const idToken = tokenFrom(result);
      if (!idToken) throw new CognitoRequestError("No se pudo renovar la sesión.");
      localStorage.setItem(idTokenKey, idToken);
      return idToken;
    } catch (error) {
      if (error instanceof CognitoRequestError) {
        clearStoredSession();
        announceExpiredSession();
        return undefined;
      }
      throw error;
    }
  })();
  refreshPromise = operation;
  try {
    return await operation;
  } finally {
    if (refreshPromise === operation) refreshPromise = undefined;
  }
};

export const ledgerApi = {
  saveSession: ({ idToken, refreshToken }: LedgerSession) => {
    localStorage.setItem(idTokenKey, idToken);
    localStorage.setItem(refreshTokenKey, refreshToken);
  },
  clearSession: () => {
    clearStoredSession();
  },
  async restoreSession(): Promise<string | undefined> {
    const idToken = localStorage.getItem(idTokenKey);
    if (isTokenFresh(idToken)) return idToken;
    return refreshSession();
  },
  async signIn(email: string, password: string): Promise<SignInResult> {
    const runtime = config();
    const result = await cognitoRequest("InitiateAuth", {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: runtime.cognitoUserPoolClientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    });
    const session = sessionFrom(result);
    if (session) return { kind: "signed_in", ...session };
    if (result.ChallengeName === "NEW_PASSWORD_REQUIRED" && typeof result.Session === "string") {
      return { kind: "new_password", email, session: result.Session };
    }
    throw new Error("Cognito devolvió una respuesta de acceso no esperada.");
  },
  async completeNewPassword(challenge: CognitoChallenge, newPassword: string): Promise<LedgerSession> {
    const runtime = config();
    const result = await cognitoRequest("RespondToAuthChallenge", {
      ClientId: runtime.cognitoUserPoolClientId,
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      Session: challenge.session,
      ChallengeResponses: { USERNAME: challenge.email, NEW_PASSWORD: newPassword },
    });
    const session = sessionFrom(result);
    if (!session) throw new Error("No se completó el cambio de contraseña.");
    return session;
  },
  async listEvents(idToken: string, month: string): Promise<EventFeed> {
    return request<EventFeed>(`/events?month=${encodeURIComponent(month)}`, idToken);
  },
  async listAssistantMemories(idToken: string): Promise<{ memories: readonly AssistantMemory[] }> {
    return request<{ memories: readonly AssistantMemory[] }>("/agent/memories", idToken);
  },
  async deleteAssistantMemory(memoryId: string, idToken: string): Promise<void> {
    await request(`/agent/memories/${encodeURIComponent(memoryId)}`, idToken, { method: "DELETE" });
  },
  async listExceptions(idToken: string): Promise<{ exceptions: readonly IngestionException[] }> {
    return request<{ exceptions: readonly IngestionException[] }>("/exceptions", idToken);
  },
  async retryException(exceptionId: string, idToken: string): Promise<IngestionException> {
    return request<IngestionException>(`/exceptions/${encodeURIComponent(exceptionId)}/retry`, idToken, { method: "POST" });
  },
  async discardException(exceptionId: string, idToken: string): Promise<void> {
    await request(`/exceptions/${encodeURIComponent(exceptionId)}`, idToken, { method: "DELETE" });
  },
  async rawException(exceptionId: string, idToken: string): Promise<string> {
    const result = await request<{ rawEmail: string }>(`/exceptions/${encodeURIComponent(exceptionId)}/raw`, idToken);
    return result.rawEmail;
  },
  async rawEmail(eventId: string, idToken: string): Promise<string> {
    const result = await request<{ rawEmail: string }>(`/events/${encodeURIComponent(eventId)}/raw`, idToken);
    return result.rawEmail;
  },
  async markVerified(eventId: string, idToken: string): Promise<PurchaseEvent> {
    return request<PurchaseEvent>(`/events/${encodeURIComponent(eventId)}`, idToken, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "verify" }),
    });
  },
  async markRejected(eventId: string, idToken: string): Promise<PurchaseEvent> {
    return request<PurchaseEvent>(`/events/${encodeURIComponent(eventId)}`, idToken, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reject" }),
    });
  },
  async createManualEvent(
    input: {
      readonly institution: string;
      readonly merchantRaw: string;
      readonly amountMinor: number;
      readonly occurredOn: string;
      readonly accountLastFour?: string;
      readonly note?: string;
    },
    idToken: string,
  ): Promise<PurchaseEvent> {
    return request<PurchaseEvent>("/events/manual", idToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        institution: input.institution,
        merchantRaw: input.merchantRaw,
        amountMinor: input.amountMinor,
        currency: "MXN",
        occurredOn: input.occurredOn,
        accountLastFour: input.accountLastFour,
        note: input.note,
      }),
    });
  },
  async monthlyPlan(month: string, idToken: string): Promise<MonthlyPlan> {
    return request<MonthlyPlan>(`/months/${encodeURIComponent(month)}`, idToken);
  },
  async monthlySummary(month: string, idToken: string): Promise<MonthSummary> {
    return request<MonthSummary>(`/months/${encodeURIComponent(month)}/summary`, idToken);
  },
  async saveMonthlyPlan(month: string, plan: MonthlyPlan, idToken: string): Promise<MonthlyPlan> {
    return request<MonthlyPlan>(`/months/${encodeURIComponent(month)}`, idToken, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currency: plan.currency,
        upcomingPayments: plan.upcomingPayments,
      }),
    });
  },
  async uploadNominas(
    files: readonly File[],
    idToken: string,
  ): Promise<NominaUploadResponse> {
    const documents = await Promise.all(
      files.map(async (file) => ({
        filename: file.name,
        xml: await file.text(),
      })),
    );
    return request<NominaUploadResponse>("/imports/nomina", idToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documents }),
    });
  },
  async listCards(idToken: string): Promise<{ cards: readonly CardCycle[] }> {
    return request<{ cards: readonly CardCycle[] }>("/cards", idToken);
  },
  async saveCard(card: CardCycle, idToken: string): Promise<CardCycle> {
    return request<CardCycle>(`/cards/${encodeURIComponent(card.id)}`, idToken, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: card.name,
        cutOffDay: card.cutOffDay,
        paymentDueDay: card.paymentDueDay,
        ...(card.institution ? { institution: card.institution } : {}),
      }),
    });
  },
  async deleteCard(cardId: string, idToken: string): Promise<void> {
    await request(`/cards/${encodeURIComponent(cardId)}`, idToken, { method: "DELETE" });
  },
  async wealth(idToken: string): Promise<WealthOverview> {
    return request<WealthOverview>("/wealth", idToken);
  },
  async createCajitaSnapshot(amountMinor: number, idToken: string): Promise<WealthSnapshot> {
    return request<WealthSnapshot>(
      `/wealth/accounts/${encodeURIComponent(CAJITA_ACCOUNT_ID)}/snapshots`,
      idToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountMinor, currency: "MXN" }),
      },
    );
  },
  async createCardLiabilitySnapshot(
    cardId: string,
    amountMinor: number,
    idToken: string,
  ): Promise<CardLiabilitySnapshot> {
    return request<CardLiabilitySnapshot>(
      `/wealth/liabilities/${encodeURIComponent(cardId)}/snapshots`,
      idToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountMinor, currency: "MXN" }),
      },
    );
  },
  async syncBitso(idToken: string): Promise<{ snapshot: WealthSnapshot; skipped: readonly string[] }> {
    return request<{ snapshot: WealthSnapshot; skipped: readonly string[] }>(
      "/wealth/sync/bitso",
      idToken,
      { method: "POST" },
    );
  },
  async syncIbkr(idToken: string): Promise<{ snapshot: WealthSnapshot; skipped: readonly string[]; fxRate: number }> {
    return request<{ snapshot: WealthSnapshot; skipped: readonly string[]; fxRate: number }>(
      "/wealth/sync/ibkr",
      idToken,
      { method: "POST" },
    );
  },
  async previewSantanderCsv(file: File, idToken: string): Promise<SantanderImportPreview> {
    return request<SantanderImportPreview>("/imports/santander/preview", idToken, {
      method: "POST",
      headers: { "Content-Type": "text/csv; charset=utf-8" },
      body: await file.text(),
    });
  },
  async applySantanderCsv(importId: string, decisions: Readonly<Record<string, SantanderImportDecision>>, idToken: string): Promise<SantanderImportResult> {
    return request<SantanderImportResult>(`/imports/santander/${encodeURIComponent(importId)}/apply`, idToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions }),
    });
  },
  async previewAmexStatement(file: File, idToken: string): Promise<AmexImportPreview> {
    return request<AmexImportPreview>("/imports/amex/preview", idToken, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: await file.arrayBuffer(),
    });
  },
  async getAmexStatementImport(importId: string, idToken: string): Promise<AmexImportPreview> {
    return request<AmexImportPreview>(`/imports/amex/${encodeURIComponent(importId)}`, idToken);
  },
  async applyAmexStatement(
    importId: string,
    decisions: Readonly<Record<string, StatementImportDecision>>,
    idToken: string,
  ): Promise<AmexImportResult> {
    return request<AmexImportResult>(`/imports/amex/${encodeURIComponent(importId)}/apply`, idToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisions }),
    });
  },
  async previewSantanderStatement(file: File, idToken: string): Promise<SantanderStatementImportPreview> {
    return request<SantanderStatementImportPreview>("/imports/santander-statement/preview", idToken, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: await file.arrayBuffer(),
    });
  },
  async getSantanderStatementImport(
    importId: string,
    idToken: string,
  ): Promise<SantanderStatementImportPreview> {
    return request<SantanderStatementImportPreview>(
      `/imports/santander-statement/${encodeURIComponent(importId)}`,
      idToken,
    );
  },
  async applySantanderStatement(
    importId: string,
    decisions: Readonly<Record<string, StatementImportDecision>>,
    idToken: string,
  ): Promise<SantanderStatementImportResult> {
    return request<SantanderStatementImportResult>(
      `/imports/santander-statement/${encodeURIComponent(importId)}/apply`,
      idToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisions }),
      },
    );
  },
  async updateEventMsi(
    eventId: string,
    body:
      | { readonly action: "set_msi"; readonly months: number; readonly cuotaMinor?: number; readonly startMonth?: string }
      | { readonly action: "clear_msi" }
      | { readonly action: "cancel_msi_remaining" }
      | {
          readonly action: "complete_msi_schedule";
          readonly months: number;
          readonly cuotaMinor?: number;
          readonly startMonth?: string;
        },
    idToken: string,
  ): Promise<PurchaseEvent> {
    return request<PurchaseEvent>(`/events/${encodeURIComponent(eventId)}`, idToken, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },
  vapidPublicKey(): string {
    const key = config().vapidPublicKey;
    if (!key || key === "pending") throw new Error("La clave de avisos todavía no está disponible.");
    return key;
  },
  async listPushSubscriptions(idToken: string): Promise<{
    subscriptions: readonly { readonly subscriptionId: string; readonly contentMode: "amounts" | "private" }[];
  }> {
    return request("/push/subscriptions", idToken);
  },
  async savePushSubscription(
    subscriptionId: string,
    subscription: { readonly endpoint: string; readonly keys: { readonly p256dh: string; readonly auth: string } },
    idToken: string,
  ): Promise<void> {
    await request(`/push/subscriptions/${encodeURIComponent(subscriptionId)}`, idToken, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        contentMode: "amounts",
      }),
    });
  },
  async deletePushSubscription(subscriptionId: string, idToken: string): Promise<void> {
    await request(`/push/subscriptions/${encodeURIComponent(subscriptionId)}`, idToken, {
      method: "DELETE",
    });
  },
  async listCategories(idToken: string): Promise<{ categories: readonly { id: string; name: string; sortOrder: number }[] }> {
    return request("/categories", idToken);
  },
  async setEventCategory(
    eventId: string,
    body: { readonly categoryId: string | null; readonly updateRule?: boolean },
    idToken: string,
  ): Promise<PurchaseEvent> {
    return request<PurchaseEvent>(`/events/${encodeURIComponent(eventId)}`, idToken, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set_category", ...body }),
    });
  },
  async streamAgentChat(
    input: { readonly message: string; readonly month: string; readonly sessionId?: string },
    idToken: string,
    onEvent: (event: AgentChatEvent) => void,
  ): Promise<string | undefined> {
    const storedToken = localStorage.getItem(idTokenKey);
    let requestToken = isTokenFresh(storedToken)
      ? storedToken
      : isTokenFresh(idToken)
        ? idToken
        : await refreshSession();
    if (!requestToken) throw endedSessionError();

    const chatUrl = config().agentChatUrl?.trim();
    if (!chatUrl) throw new Error("El streaming del asistente no está configurado.");

    const execute = (token: string) => fetch(chatUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(input),
    });

    let response: Response;
    try {
      response = await execute(requestToken);
    } catch {
      throw new Error("No pude consultar tus datos. Reintenta.");
    }
    if (response.status === 401) {
      requestToken = await refreshSession();
      if (!requestToken) throw endedSessionError();
      try {
        response = await execute(requestToken);
      } catch {
        throw new Error("No pude consultar tus datos. Reintenta.");
      }
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({ message: "No pude consultar tus datos." })) as {
        message?: string;
        requestId?: string;
      };
      throw new Error(body.message ?? "No pude consultar tus datos.");
    }

    if (!response.body) {
      throw new Error("Tu navegador no pudo abrir el streaming del asistente. Reintenta.");
    }

    let sessionId: string | undefined = input.sessionId;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const consumeBlock = (block: string) => {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) return;
      try {
        const event = JSON.parse(data) as AgentChatEvent;
        onEvent(event);
        if (event.type === "done") sessionId = event.sessionId;
      } catch {
        // Ignore a malformed event without discarding a healthy stream.
      }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? "";
        blocks.forEach(consumeBlock);
      }
      buffer += decoder.decode();
      if (buffer.trim()) consumeBlock(buffer);
    } finally {
      reader.releaseLock();
    }
    return sessionId;
  },
};

export type AgentChatEvent =
  | { readonly type: "token"; readonly text: string }
  | { readonly type: "reasoning_start"; readonly reasoningId: string; readonly label: string }
  | { readonly type: "reasoning_complete"; readonly reasoningId: string; readonly durationMs: number }
  | { readonly type: "tool_start"; readonly toolUseId: string; readonly name: string; readonly label: string; readonly attempt: number }
  | { readonly type: "tool_complete"; readonly toolUseId: string; readonly name: string; readonly label: string; readonly attempt: number; readonly durationMs: number; readonly summary?: string; readonly material: boolean }
  | { readonly type: "tool_failed"; readonly toolUseId: string; readonly name: string; readonly label: string; readonly attempt: number; readonly durationMs: number; readonly message: string }
  | { readonly type: "citation"; readonly kind: string; readonly id?: string; readonly label: string }
  | { readonly type: "proposal"; readonly eventId: string; readonly categoryId: string; readonly message: string }
  | { readonly type: "done"; readonly requestId: string; readonly sessionId: string }
  | { readonly type: "error"; readonly message: string; readonly requestId: string };

const request = async <T>(path: string, idToken: string, init?: RequestInit): Promise<T> => {
  const storedToken = localStorage.getItem(idTokenKey);
  let requestToken = isTokenFresh(storedToken)
    ? storedToken
    : isTokenFresh(idToken)
      ? idToken
      : await refreshSession();
  if (!requestToken) throw endedSessionError();

  const execute = (token: string) => fetch(`${config().apiBaseUrl}${path}`, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${token}` },
  });
  let response = await execute(requestToken);
  if (response.status === 401) {
    requestToken = await refreshSession();
    if (!requestToken) throw endedSessionError();
    response = await execute(requestToken);
  }
  const body = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(body.message ?? "No se pudo completar la solicitud.");
  return body;
};
