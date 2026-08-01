import type { EventFeed, PurchaseEvent } from "../types";
import type { MonthlyPlan } from "../monthly-plan";

interface LedgerRuntimeConfig {
  readonly apiBaseUrl: string;
  readonly cognitoUserPoolId: string;
  readonly cognitoUserPoolClientId: string;
  readonly region: string;
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
  if (!response.ok) throw new Error(String(body.message ?? "No fue posible iniciar sesión."));
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

export const ledgerApi = {
  saveSession: ({ idToken, refreshToken }: LedgerSession) => {
    localStorage.setItem(idTokenKey, idToken);
    localStorage.setItem(refreshTokenKey, refreshToken);
  },
  clearSession: () => {
    localStorage.removeItem(idTokenKey);
    localStorage.removeItem(refreshTokenKey);
  },
  async restoreSession(): Promise<string | undefined> {
    const refreshToken = localStorage.getItem(refreshTokenKey);
    if (!refreshToken) return undefined;
    try {
      const runtime = config();
      const result = await cognitoRequest("InitiateAuth", {
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: runtime.cognitoUserPoolClientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      });
      const idToken = tokenFrom(result);
      if (!idToken) throw new Error("No se pudo renovar la sesión.");
      localStorage.setItem(idTokenKey, idToken);
      return idToken;
    } catch {
      ledgerApi.clearSession();
      return undefined;
    }
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
  async listEvents(idToken: string): Promise<EventFeed> {
    return request<EventFeed>("/events", idToken);
  },
  async rawEmail(eventId: string, idToken: string): Promise<string> {
    const result = await request<{ rawEmail: string }>(`/events/${encodeURIComponent(eventId)}/raw`, idToken);
    return result.rawEmail;
  },
  async markVerified(eventId: string, idToken: string): Promise<PurchaseEvent> {
    return request<PurchaseEvent>(`/events/${encodeURIComponent(eventId)}`, idToken, { method: "PATCH" });
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
};

const request = async <T>(path: string, idToken: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${config().apiBaseUrl}${path}`, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${idToken}` },
  });
  const body = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(body.message ?? "No se pudo completar la solicitud.");
  return body;
};
