import { beforeEach, describe, expect, it, vi } from "vitest";
import { isTokenFresh, ledgerApi } from "./client";

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length() { return this.#values.size; }
  clear() { this.#values.clear(); }
  getItem(key: string) { return this.#values.get(key) ?? null; }
  key(index: number) { return [...this.#values.keys()][index] ?? null; }
  removeItem(key: string) { this.#values.delete(key); }
  setItem(key: string, value: string) { this.#values.set(key, value); }
}

const token = (expiresAt: number, name: string) => {
  const payload = btoa(JSON.stringify({ exp: Math.floor(expiresAt / 1000), name }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header.${payload}.signature`;
};

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

beforeEach(() => {
  const browserWindow = new EventTarget() as EventTarget & { __LEDGER_CONFIG__: Record<string, string> };
  browserWindow.__LEDGER_CONFIG__ = {
    apiBaseUrl: "https://api.example.test",
    cognitoUserPoolId: "pool",
    cognitoUserPoolClientId: "client",
    region: "us-east-2",
  };
  vi.stubGlobal("window", browserWindow);
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("fetch", vi.fn());
});

describe("iOS web app session recovery", () => {
  it("recognises tokens with enough lifetime remaining", () => {
    const now = Date.now();
    expect(isTokenFresh(token(now + 5 * 60 * 1000, "fresh"), now)).toBe(true);
    expect(isTokenFresh(token(now + 60 * 1000, "near-expiry"), now)).toBe(false);
    expect(isTokenFresh("not-a-jwt", now)).toBe(false);
  });

  it("restores a fresh local token without calling Cognito", async () => {
    const idToken = token(Date.now() + 10 * 60 * 1000, "cached");
    ledgerApi.saveSession({ idToken, refreshToken: "refresh-token" });

    await expect(ledgerApi.restoreSession()).resolves.toBe(idToken);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renews a token before it expires", async () => {
    const oldToken = token(Date.now() + 30 * 1000, "old");
    const newToken = token(Date.now() + 60 * 60 * 1000, "new");
    ledgerApi.saveSession({ idToken: oldToken, refreshToken: "refresh-token" });
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ AuthenticationResult: { IdToken: newToken } }));

    await expect(ledgerApi.restoreSession()).resolves.toBe(newToken);
    expect(localStorage.getItem("ledger-id-token")).toBe(newToken);
  });

  it("shares one Cognito request across concurrent renewals", async () => {
    const oldToken = token(Date.now() + 30 * 1000, "old");
    const newToken = token(Date.now() + 60 * 60 * 1000, "new");
    ledgerApi.saveSession({ idToken: oldToken, refreshToken: "refresh-token" });
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ AuthenticationResult: { IdToken: newToken } }));

    await expect(Promise.all([ledgerApi.restoreSession(), ledgerApi.restoreSession()])).resolves.toEqual([newToken, newToken]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("renews and retries once after API Gateway returns 401", async () => {
    const oldToken = token(Date.now() + 60 * 60 * 1000, "old");
    const newToken = token(Date.now() + 60 * 60 * 1000, "new");
    ledgerApi.saveSession({ idToken: oldToken, refreshToken: "refresh-token" });
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ AuthenticationResult: { IdToken: newToken } }))
      .mockResolvedValueOnce(jsonResponse({ events: [] }));

    await expect(ledgerApi.listEvents(oldToken)).resolves.toEqual({ events: [] });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetch).mock.calls[2]?.[1]?.headers).toMatchObject({ Authorization: `Bearer ${newToken}` });
  });

  it("keeps the refresh token after a transient network failure", async () => {
    const oldToken = token(Date.now() + 30 * 1000, "old");
    ledgerApi.saveSession({ idToken: oldToken, refreshToken: "refresh-token" });
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("offline"));

    await expect(ledgerApi.restoreSession()).rejects.toThrow("offline");
    expect(localStorage.getItem("ledger-refresh-token")).toBe("refresh-token");
  });

  it("clears the local session when Cognito rejects the refresh token", async () => {
    const oldToken = token(Date.now() + 30 * 1000, "old");
    ledgerApi.saveSession({ idToken: oldToken, refreshToken: "invalid-refresh-token" });
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ message: "Refresh Token has been revoked" }, 400));

    await expect(ledgerApi.restoreSession()).resolves.toBeUndefined();
    expect(localStorage.getItem("ledger-id-token")).toBeNull();
    expect(localStorage.getItem("ledger-refresh-token")).toBeNull();
  });

  it("announces an ended session when no refresh token remains", async () => {
    const expired = token(Date.now() - 60 * 1000, "expired");
    const expiredListener = vi.fn();
    localStorage.setItem("ledger-id-token", expired);
    window.addEventListener("olbia:session-expired", expiredListener);

    await expect(ledgerApi.listEvents(expired)).rejects.toThrow("Tu sesión terminó");
    expect(expiredListener).toHaveBeenCalledOnce();
    expect(localStorage.getItem("ledger-id-token")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
