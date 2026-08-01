import type { EventFeed, PurchaseEvent } from "../types";

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

export type SignInResult = { readonly kind: "signed_in"; readonly idToken: string } | CognitoChallenge;

declare global {
  interface Window { __LEDGER_CONFIG__?: LedgerRuntimeConfig; }
}

const config = (): LedgerRuntimeConfig => {
  if (!window.__LEDGER_CONFIG__) throw new Error("La configuración de Ledger no está disponible todavía.");
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

export const ledgerApi = {
  storedToken: (): string | undefined => sessionStorage.getItem("ledger-id-token") ?? undefined,
  clearSession: () => sessionStorage.removeItem("ledger-id-token"),
  async signIn(email: string, password: string): Promise<SignInResult> {
    const runtime = config();
    const result = await cognitoRequest("InitiateAuth", {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: runtime.cognitoUserPoolClientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    });
    const idToken = tokenFrom(result);
    if (idToken) return { kind: "signed_in", idToken };
    if (result.ChallengeName === "NEW_PASSWORD_REQUIRED" && typeof result.Session === "string") {
      return { kind: "new_password", email, session: result.Session };
    }
    throw new Error("Cognito devolvió una respuesta de acceso no esperada.");
  },
  async completeNewPassword(challenge: CognitoChallenge, newPassword: string): Promise<string> {
    const runtime = config();
    const result = await cognitoRequest("RespondToAuthChallenge", {
      ClientId: runtime.cognitoUserPoolClientId,
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      Session: challenge.session,
      ChallengeResponses: { USERNAME: challenge.email, NEW_PASSWORD: newPassword },
    });
    const idToken = tokenFrom(result);
    if (!idToken) throw new Error("No se completó el cambio de contraseña.");
    return idToken;
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
