# Push de corte y pago de tarjetas

## Estado

Operativo con la misma suscripción VAPID que el balance diario y los movimientos nuevos: cada mañana a las **07:05 America/Chihuahua**, Olbia revisa las tarjetas configuradas y envía un Web Push cuando el día local coincide con corte o pago.

## Preferencia

Un solo control en Resumen — **Avisos de Olbia** — activa también estos recordatorios. No hay toggles por tipo en v1. La UI siempre guarda `contentMode: "amounts"`; el modo `private` existe en API pero no tiene control en la app.

Las tarjetas se configuran en Resumen → **Fechas de corte** (máximo 3). Solo definen ciclo; el saldo pendiente se captura en Patrimonio.

## Contenido

```text
Olbia · corte hoy
Amex Gold: día de corte.
```

```text
Olbia · pago hoy
Nu: día de pago.
```

Con `contentMode: private`: `Hoy es día de corte.` / `Hoy es día de pago.`

Días configurados mayores al largo del mes (p. ej. 31 en febrero) se ajustan al último día del mes.

## Arquitectura

```text
EventBridge Scheduler (07:05 America/Chihuahua)
  └─ Lambda card-cycle-push
       ├─ suscripciones activas (GSI1 PUSH_SUBSCRIPTIONS)
       ├─ tarjetas del owner (SK CARD#)
       ├─ cardRemindersForDay (dominio)
       └─ Declarative Web Push
```

Persistencia de tarjetas:

```text
PK = USER#{cognitoSub}
SK = CARD#{cardId}
```

API autenticada: `GET /cards`, `PUT /cards/{cardId}`, `DELETE /cards/{cardId}` (máximo 3).

Un `tag` estable `card-{cutoff|payment}-{cardId}-{YYYY-MM-DD}` evita duplicados si el scheduler reintenta. Endpoints `404`/`410` se eliminan.

## Relacionado

- [Push diario del balance](daily-balance-push.md)
- [Avisos push de movimientos observados](push-on-new-observable.md)
- [Patrimonio](patrimonio.md)
- [Dirección de producto y UI](ui-design-brief.md)
