import { useEffect, useState } from "react";
import { ledgerApi } from "../api/client";
import {
  currentPushPermission,
  pushManagerAvailable,
  readBrowserPushSubscription,
  subscribeBrowserPush,
  subscriptionIdForEndpoint,
  unsubscribeBrowserPush,
  type PushPermissionState,
} from "../push/notifications";

export function PushPreference({
  idToken,
  demoMode,
}: {
  idToken: string;
  demoMode: boolean;
}) {
  const [permission, setPermission] = useState<PushPermissionState>(() => currentPushPermission());
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    if (demoMode || !pushManagerAvailable()) {
      setPermission(demoMode ? "unsupported" : currentPushPermission());
      setEnabled(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const local = await readBrowserPushSubscription();
        const remote = await ledgerApi.listPushSubscriptions(idToken);
        if (cancelled) return;
        if (local) {
          const localId = await subscriptionIdForEndpoint(local.endpoint);
          if (remote.subscriptions.some((item) => item.subscriptionId === localId)) {
            setEnabled(true);
            setPermission("granted");
            return;
          }
        }
        setEnabled(false);
        setPermission(currentPushPermission());
      } catch {
        if (!cancelled) {
          setEnabled(false);
          setPermission(currentPushPermission());
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demoMode, idToken]);

  if (demoMode || permission === "unsupported") return null;

  const enable = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const vapidPublicKey = ledgerApi.vapidPublicKey();
      const subscription = await subscribeBrowserPush(vapidPublicKey);
      const subscriptionId = await subscriptionIdForEndpoint(subscription.endpoint);
      await ledgerApi.savePushSubscription(subscriptionId, subscription, idToken);
      setEnabled(true);
      setPermission("granted");
      setMessage("Te avisaré cuando llegue una compra nueva.");
    } catch (error) {
      setEnabled(false);
      setPermission(currentPushPermission());
      setMessage(error instanceof Error ? error.message : "No se pudo activar el aviso.");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const local = await readBrowserPushSubscription();
      const subscriptionId = local
        ? await subscriptionIdForEndpoint(local.endpoint)
        : undefined;
      await unsubscribeBrowserPush();
      if (subscriptionId) await ledgerApi.deletePushSubscription(subscriptionId, idToken);
      setEnabled(false);
      setPermission(currentPushPermission());
      setMessage("Avisos desactivados en este dispositivo.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo desactivar el aviso.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="push-preference">
      <div>
        <p className="eyebrow">AVISOS</p>
        <strong>Notificar compras nuevas</strong>
        <small>
          {permission === "denied"
            ? "El permiso está bloqueado en el sistema. Cámbialo en Ajustes."
            : "Un aviso cuando Olbia registre un movimiento observado."}
        </small>
        {message && <p className="push-preference-message">{message}</p>}
      </div>
      {enabled ? (
        <button type="button" className="push-preference-button" onClick={() => void disable()} disabled={busy}>
          {busy ? "Espera…" : "Desactivar"}
        </button>
      ) : (
        <button
          type="button"
          className="push-preference-button"
          onClick={() => void enable()}
          disabled={busy || permission === "denied"}
        >
          {busy ? "Espera…" : "Activar"}
        </button>
      )}
    </section>
  );
}
