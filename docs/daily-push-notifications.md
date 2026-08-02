# Push diario del balance de Olbia

## Estado y conclusión

**Factibilidad: alta.** Olbia puede enviar una notificación Web Push cada mañana a la app web instalada en un iPhone con iOS 26 sin crear una aplicación nativa, usar la App Store ni pertenecer al Apple Developer Program.

La primera versión recomendada usa **Declarative Web Push**. Esta capacidad está disponible para apps web guardadas en la pantalla de inicio desde iOS 18.4 y permite adquirir una suscripción y mostrar una notificación sin instalar un service worker. Así se conserva la decisión actual de no añadir una capa de caché u operación offline.

Este documento registra una exploración técnica. No autoriza ni contiene una implementación.

## Qué puede significar “balance”

Olbia puede calcular y notificar el estado que ya presenta en Resumen:

- gasto acumulado del mes;
- dinero restante después de compras observadas y próximos pagos;
- proyección de cierre al ritmo actual;
- importe incluido que todavía requiere confirmación.

Esto **no es el saldo real de una cuenta bancaria**. El sistema recibe compras observadas, un ingreso mensual configurado y próximos pagos, pero no consulta saldos de bancos. Una notificación no debe usar lenguaje que sugiera que el importe fue confirmado por una institución financiera.

La fórmula debe ser la misma que utiliza la UI:

```text
restante = ingreso mensual - gasto aceptado o por confirmar - próximos pagos
```

Actualmente este cálculo vive en `apps/web/src/App.tsx`. Antes de producir notificaciones conviene extraerlo a una función compartida y probada para evitar que la UI y el backend comuniquen resultados distintos.

## Experiencia propuesta

La app debe mostrar una preferencia explícita, por ejemplo **“Activar balance diario”**. La solicitud del permiso y la creación de la suscripción tienen que ejecutarse inmediatamente después de ese toque, porque WebKit exige interacción directa del usuario.

Primera configuración sugerida:

- envío diario a las 07:00;
- zona horaria `America/Chihuahua`;
- activación voluntaria;
- opción para desactivar desde Olbia;
- cantidades visibles por defecto sólo después de explicar que pueden aparecer en la pantalla bloqueada.

Ejemplo cuando el mes está configurado:

```text
Olbia · balance de hoy
Has gastado $12,430 este mes. Te quedan $8,570 después de compromisos.
```

Estados que deben conservar las reglas financieras del producto:

- Sin ingreso configurado: mostrar el gasto, pedir configurar el mes y no presentar disponibilidad ni proyección como válidas.
- Con compras por revisar: añadir `Incluye $N por confirmar` cuando quepa sin perder claridad.
- Con proyección negativa: usar una consecuencia concreta, sin vergüenza ni lenguaje celebratorio.
- Sin compras: comunicar `$0 gastados este mes`; no convertirlo en racha, premio o felicitación.

Por privacidad debería existir una modalidad sin importes visibles:

```text
Olbia
Tu balance diario está listo.
```

Al tocar cualquiera de las dos variantes, la notificación navega a la raíz autenticada de Olbia. Si la sesión expiró, la aplicación pide acceso normalmente; la suscripción no debe contener ni reutilizar tokens de Cognito.

## Compatibilidad con iOS 26

Olbia ya cumple las condiciones estructurales relevantes:

- se sirve por HTTPS;
- tiene manifest con identidad estable, `start_url`, `scope` y modo `standalone`;
- ya se usa como app web agregada a la pantalla de inicio.

En iOS 26 se recomienda detectar `window.pushManager` y utilizar Declarative Web Push. El mensaje enviado debe usar el formato declarativo estándar, incluyendo un título visible y una URL `navigate`.

```json
{
  "web_push": 8030,
  "notification": {
    "title": "Olbia · balance de hoy",
    "body": "Has gastado $12,430 este mes. Te quedan $8,570 después de compromisos.",
    "navigate": "https://finance.castrodavid.dev/",
    "lang": "es-MX",
    "silent": false
  }
}
```

Declarative Web Push permite mantener Olbia sin service worker para el alcance inicial de iPhone. Si más adelante se requiere compatibilidad con navegadores que sólo exponen `ServiceWorkerRegistration.pushManager`, puede añadirse un service worker mínimo que:

- maneje únicamente `push` y `notificationclick`;
- no registre un handler `fetch`;
- no introduzca caché offline;
- interprete el mismo payload declarativo para conservar un único formato del servidor.

La app debe usar detección de capacidades, no detección del nombre o versión del navegador. Una instalación eliminada o recreada es otro dispositivo lógico y requiere una suscripción nueva.

## Arquitectura propuesta

```text
iPhone / Olbia
  └─ suscripción Push autenticada
       └─ API Gateway + Cognito
            └─ DynamoDB

EventBridge Scheduler (07:00 America/Chihuahua)
  └─ Lambda de balance diario
       ├─ consulta suscripciones activas
       ├─ consulta plan mensual y movimientos
       ├─ calcula el resumen compartido
       └─ envía Web Push cifrado al endpoint del dispositivo
            └─ servicio Push de Apple
                 └─ notificación en iPhone
```

### Frontend

- Detectar soporte de Declarative Web Push.
- Solicitar permiso sólo como resultado del toque en la preferencia.
- Crear la suscripción con `userVisibleOnly: true` y la clave pública VAPID.
- Registrar la suscripción mediante la API autenticada.
- Permitir cancelarla y reflejar los estados `default`, `granted` y `denied`.
- Explicar que un permiso denegado se administra posteriormente desde Ajustes de iOS.

### API autenticada

Rutas candidatas:

- `PUT /push/subscriptions/{subscriptionId}` para registrar o actualizar una instalación.
- `DELETE /push/subscriptions/{subscriptionId}` para desactivarla.
- `GET /push/preferences` sólo si la UI necesita reconciliar más de una instalación o preferencias editables.

El backend obtiene el propietario del claim `sub` de Cognito. Nunca acepta un identificador de usuario enviado por el cliente.

### Persistencia

Las suscripciones pueden vivir en la tabla DynamoDB existente:

```text
PK = USER#{cognitoSub}
SK = PUSH#{sha256(endpoint)}
```

Campos mínimos:

- endpoint;
- claves `p256dh` y `auth` de la suscripción;
- propietario;
- fecha de creación y última actualización;
- preferencia de contenido privado o con cantidades;
- estado activo.

Para que el proceso programado descubra suscripciones activas sin conocer anticipadamente el usuario, el registro puede reutilizar `GSI1` con una partición específica como `PUSH_SUBSCRIPTIONS`. El endpoint de Push funciona como una capacidad de entrega y debe tratarse como dato sensible. La tabla ya usa cifrado administrado con KMS.

### Identidad VAPID

- Generar un único par de claves VAPID para Olbia.
- Exponer únicamente la clave pública al frontend mediante la configuración de runtime.
- Guardar la clave privada en Secrets Manager.
- Permitir a la Lambda de envío leer exclusivamente ese secreto.

Apple entrega Web Push mediante APNs, pero el servidor usa el protocolo Web Push estándar y no credenciales nativas de APNs.

### Scheduler y Lambda

EventBridge Scheduler debe invocar una Lambda mediante un cron diario con:

- zona horaria `America/Chihuahua`;
- ventana flexible desactivada si se prefiere el inicio más cercano posible a las 07:00;
- política acotada de reintentos;
- DLQ para invocaciones que no pudieron procesarse.

Scheduler tiene precisión de 60 segundos. La entrega al teléfono no es de tiempo real garantizado: conexión, batería, Focus y las políticas de iOS pueden retrasar o silenciar la presentación.

La Lambda debe:

1. consultar todas las suscripciones activas;
2. agruparlas por propietario para calcular una sola vez por usuario;
3. leer el plan del mes correspondiente a la zona horaria configurada;
4. consultar y paginar todos los eventos del mes, no reutilizar el límite actual de 100 elementos de `GET /events`;
5. excluir compras rechazadas e incluir las que necesitan revisión;
6. calcular gasto, restante, incertidumbre y proyección mediante lógica compartida;
7. construir el mensaje según el estado financiero y la preferencia de privacidad;
8. enviar a cada instalación;
9. eliminar o desactivar endpoints que respondan como expirados (`404` o `410`);
10. distinguir fallos permanentes por suscripción de fallos transitorios que ameritan reintento.

No se necesita Step Functions para una ejecución diaria corta y de un solo usuario.

## Seguridad y privacidad

- No almacenar tokens de Cognito con la suscripción.
- Autorizar alta y baja mediante el JWT existente.
- Validar esquema, tamaños y protocolo HTTPS de los datos de suscripción.
- No registrar endpoints completos, claves de suscripción ni cantidades personales en logs.
- Mantener la clave VAPID privada fuera del bundle web y de variables públicas.
- Ofrecer contenido neutral para evitar exponer cifras en la pantalla bloqueada.
- Incluir sólo el resumen necesario; no poner comercios, números de tarjeta ni evidencia de movimientos en el Push.
- Recordar que Focus, los resúmenes de notificaciones y la configuración del sistema pertenecen al usuario y no pueden ser anulados por Olbia.

## Observabilidad y operación

Métricas o contadores mínimos:

- ejecuciones programadas;
- usuarios calculados;
- envíos exitosos;
- endpoints expirados eliminados;
- fallos transitorios;
- fallos definitivos de la ejecución.

Debe existir una alarma para errores persistentes de la Lambda y mensajes en la DLQ. Los logs deben usar identificadores irreversibles o truncados para correlacionar una suscripción sin revelar su endpoint.

Para el volumen personal actual, una ejecución de Lambda y un Push al día tienen un coste operativo marginal respecto de la infraestructura existente.

## Riesgos y límites

1. **No es saldo bancario.** La cifra depende de que los movimientos hayan llegado por correo, Apple Pay o importación CSV.
2. **Entrega no exacta.** El scheduler inicia cerca de la hora indicada, pero iOS decide cuándo presentar la notificación.
3. **Permiso revocado o instalación eliminada.** La app no puede restablecerlo silenciosamente; el usuario debe volver a activarlo.
4. **Duplicados por reintento.** Usar un `tag` estable por usuario y fecha puede ayudar a reemplazar la notificación del día en vez de acumular copias.
5. **Lógica duplicada.** Implementar el cálculo nuevamente dentro de Lambda produciría divergencias; debe compartirse con la UI.
6. **Modelo monousuario actual.** Los eventos se consultan globalmente en V1. Antes de ampliar a varios usuarios hay que introducir propiedad explícita y aislamiento también para eventos.
7. **Datos incompletos al iniciar el día.** Una compra todavía no notificada por el banco no aparecerá en el resumen.

## Orden de implementación sugerido

1. Extraer y probar el cálculo financiero compartido.
2. Añadir claves VAPID y persistencia de suscripciones.
3. Añadir endpoints autenticados de alta y baja.
4. Añadir la preferencia opt-in con detección de Declarative Web Push.
5. Implementar la Lambda de resumen y envío.
6. Configurar Scheduler, reintentos, DLQ y alarma mediante CDK.
7. Probar en un iPhone físico instalado desde la pantalla de inicio.
8. Documentar revocación, reinstalación y diagnóstico.

## Criterios de aceptación para una primera versión

- La app sólo solicita permiso después de un toque explícito.
- Un iPhone con iOS 26 recibe una notificación con la aplicación cerrada.
- La notificación abre Olbia al tocarla.
- El total coincide con Resumen para el mismo instante y zona horaria.
- Un mes sin ingreso no muestra restante ni proyección como válidos.
- El importe por confirmar se comunica cuando existe.
- La opción privada no revela cantidades.
- Desactivar la preferencia cancela la suscripción en cliente y servidor.
- Un endpoint expirado deja de intentarse después de una respuesta permanente.
- Un reintento del mismo día no deja múltiples notificaciones visibles.
- No aparecen tokens, endpoints completos ni cifras financieras en logs.

## Decisiones pendientes antes de implementar

- Hora inicial exacta: 07:00 es una propuesta.
- Si la primera versión permite editar la hora o la mantiene fija.
- Contenido por defecto: importes visibles o modalidad privada.
- Métrica principal de la notificación: gasto y restante, o gasto y proyección.
- Si se soportará únicamente iOS 26 al inicio o también navegadores que requieren service worker.

## Referencias

- [WebKit: Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [Apple: Sending web push notifications in web apps and browsers](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
- [WebKit: Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/)
- [Apple WWDC25: Learn more about Declarative Web Push](https://developer.apple.com/videos/play/wwdc2025/235/)
- [AWS: Schedule types in EventBridge Scheduler](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html)
- [AWS: Invoke a Lambda function on a schedule](https://docs.aws.amazon.com/lambda/latest/dg/with-eventbridge-scheduler.html)
- [Olbia como app web en iOS](ios-home-screen-web-app.md)
- [Decisiones de V1](v1-decisions.md)
- [Dirección de producto y UI](ui-design-brief.md)
