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

interface LedgerRuntimeConfig {
  readonly apiBaseUrl: string;
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
  async saveMonthlyPlan(month: string, plan: MonthlyPlan, idToken: string): Promise<MonthlyPlan> {
    return request<MonthlyPlan>(`/months/${encodeURIComponent(month)}`, idToken, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        incomeMinor: plan.incomeMinor,
        currency: plan.currency,
        upcomingPayments: plan.upcomingPayments,
      }),
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
};

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
