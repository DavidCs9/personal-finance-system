# Push diario del balance de Olbia

## Estado

Operativo: cada mañana a las **07:00 America/Chihuahua**, Olbia envía un Web Push declarativo con el resumen del mes a las instalaciones que activaron avisos. Usa la misma suscripción VAPID que el aviso de movimiento nuevo y los recordatorios de corte/pago.

## Preferencia

Un solo control en Resumen — **Avisos de Olbia** — activa:

1. el balance diario a las 07:00;
2. el aviso al registrar una compra nueva (correo / Apple Pay);
3. los recordatorios de corte y pago de tarjetas a las 07:05.

La petición de permiso ocurre sólo tras ese toque. Desactivar cancela la suscripción en el dispositivo y en el servidor.

La UI siempre guarda `contentMode: "amounts"`. El modo `private` existe en API/dominio (oculta cifras) pero no tiene control en la app todavía.

## Contenido

Plantilla con importes:

```text
Olbia · balance de hoy
Has gastado $12,430 este mes. Te quedan $8,570 después de compromisos.
```

Reglas (`dailyBalancePushMessage` en `packages/domain`):

- sin ingreso configurado: muestra el gasto y pide configurar el mes; no inventa restante ni proyección;
- proyección negativa: añade `A este ritmo te faltarán $N`;
- si la proyección no es negativa y hay incertidumbre: añade `Incluye $N por confirmar`;
- `contentMode: private`: `Tu balance diario está listo.`

No es saldo bancario. El cálculo usa `computeMonthSummary` (ingreso, gasto no rechazado, MSI spent/committed, próximos pagos).

### Paridad con Resumen

La Lambda carga eventos con importe, status y fechas, pero **hoy no proyecta el campo `msi`**. En meses con planes MSI, el push puede tratar el principal como gasto discrecional y **divergir** de las cifras de Resumen. Hasta que el job cargue `msi`, trata el aviso diario como orientación, no como fuente de verdad frente al tablero.

## Arquitectura

```text
EventBridge Scheduler (07:00 America/Chihuahua)
  └─ Lambda daily-balance-push
       ├─ suscripciones activas (GSI1 PUSH_SUBSCRIPTIONS)
       ├─ plan del mes + eventos paginados
       ├─ computeMonthSummary (dominio compartido)
       └─ Declarative Web Push
```

Un `tag` estable `daily-YYYY-MM-DD` evita acumular copias si el scheduler reintenta el mismo día. Endpoints `404`/`410` se eliminan. Hay DLQ y alarmas de error.

## Relacionado

- [Avisos push de movimientos observados](push-on-new-observable.md)
- [Push de corte y pago](card-cycle-push.md)
- [Olbia como app web en iOS](ios-home-screen-web-app.md)
- [Dirección de producto y UI](ui-design-brief.md)
