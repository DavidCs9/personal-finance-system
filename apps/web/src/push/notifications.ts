export type PushPermissionState = "unsupported" | "default" | "granted" | "denied";

export interface BrowserPushSubscription {
  readonly endpoint: string;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
}

declare global {
  interface Window {
    pushManager?: PushManager;
  }
}

export const pushManagerAvailable = (): boolean =>
  typeof window !== "undefined" && typeof window.pushManager?.subscribe === "function";

export const currentPushPermission = (): PushPermissionState => {
  if (!pushManagerAvailable() || typeof Notification === "undefined") return "unsupported";
  return Notification.permission as Exclude<PushPermissionState, "unsupported">;
};

export const subscriptionIdForEndpoint = async (endpoint: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const readBrowserPushSubscription = async (): Promise<BrowserPushSubscription | undefined> => {
  const manager = window.pushManager;
  if (!manager) return undefined;
  const existing = await manager.getSubscription();
  if (!existing) return undefined;
  return serializeSubscription(existing);
};

export const subscribeBrowserPush = async (vapidPublicKey: string): Promise<BrowserPushSubscription> => {
  const manager = window.pushManager;
  if (!manager) throw new Error("Este dispositivo no admite avisos de Olbia.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      permission === "denied"
        ? "El permiso quedó denegado. Actívalo desde Ajustes de iOS."
        : "Se necesita permiso para enviar avisos.",
    );
  }
  const subscription = await manager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });
  return serializeSubscription(subscription);
};

export const unsubscribeBrowserPush = async (): Promise<string | undefined> => {
  const manager = window.pushManager;
  if (!manager) return undefined;
  const existing = await manager.getSubscription();
  if (!existing) return undefined;
  const subscriptionId = await subscriptionIdForEndpoint(existing.endpoint);
  await existing.unsubscribe();
  return subscriptionId;
};

const serializeSubscription = (subscription: PushSubscription): BrowserPushSubscription => {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) {
    throw new Error("La suscripción de avisos está incompleta.");
  }
  return {
    endpoint: json.endpoint,
    keys: { p256dh, auth },
  };
};

const urlBase64ToUint8Array = (value: string): BufferSource => {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }
  return output;
};
