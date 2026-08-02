# Avisos push de movimientos observados

## Estado

Primera versión operativa: Olbia envía una notificación Web Push cuando se registra un **nuevo evento observado** (correo o Apple Pay), usando Declarative Web Push en la app instalada en la pantalla de inicio. Ese aviso reemplaza el correo SES de movimiento observado; SES queda reservado a excepciones de ingestión.

El mismo opt-in también habilita el [push diario de balance](daily-balance-push.md) a las 07:00 America/Chihuahua.

## Flujo

```text
Usuario activa “Avisos de Olbia”
  └─ window.pushManager.subscribe (VAPID)
       └─ PUT /push/subscriptions/{sha256(endpoint)}

Email o Apple Pay crea un evento nuevo
  └─ Lambda consulta suscripciones activas (GSI1 PUSH_SUBSCRIPTIONS)
       └─ Web Push cifrado (payload declarativo)
            └─ notificación en el dispositivo
```

## Persistencia

```text
PK = USER#{cognitoSub}
SK = PUSH#{sha256(endpoint)}
GSI1PK = PUSH_SUBSCRIPTIONS
```

## Seguridad

- Alta y baja autenticadas con JWT de Cognito; el propietario sale del claim `sub`.
- La clave VAPID privada vive en Secrets Manager; sólo la pública llega al frontend vía `runtime-config.js`.
- Endpoints expirados (`404`/`410`) se eliminan.
- Los logs truncan el `subscriptionId`; no registran endpoints completos ni claves.

## Preferencia

En Resumen, debajo de la jerarquía financiera, la opción **Avisos de Olbia** pide permiso sólo tras un toque explícito. Activa el aviso de compras nuevas y el balance diario. Si iOS lo deniega, Olbia indica que debe cambiarse en Ajustes.
