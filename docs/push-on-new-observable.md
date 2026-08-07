# Avisos push de movimientos observados

## Estado

Operativo: Olbia envía una notificación Web Push cuando se registra un **nuevo evento observado** por **correo** o **Apple Pay**, usando Declarative Web Push en la app instalada en la pantalla de inicio. Ese aviso reemplaza el correo SES de movimiento observado; SES queda reservado a excepciones de ingestión (y a fallos de sync de patrimonio).

No envían este push: altas manuales, CSV Santander, ni apply de estado de cuenta Amex/Santander.

El mismo opt-in también habilita el [push diario de balance](daily-balance-push.md) a las 07:00 America/Chihuahua y los [recordatorios de corte/pago de tarjetas](card-cycle-push.md) a las 07:05.

## Contenido

```text
Olbia · movimiento nuevo
Hay un movimiento nuevo.
```

Con `contentMode: private`: el cuerpo oculta el detalle comercial. La UI web siempre suscribe en modo `amounts` hoy.

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

En Resumen, debajo de Fechas de corte, la opción **Avisos de Olbia** pide permiso sólo tras un toque explícito. Activa compras nuevas, balance diario y recordatorios de corte/pago. Si iOS lo deniega, Olbia indica que debe cambiarse en Ajustes.

Fallos de sync Bitso/IBKR también pueden empujar un aviso (y email); detalle en [Patrimonio](patrimonio.md).

## Relacionado

- [Push diario del balance](daily-balance-push.md)
- [Push de corte y pago](card-cycle-push.md)
- [Olbia como app web en iOS](ios-home-screen-web-app.md)
