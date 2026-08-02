# Olbia como app web en iOS

## Qué cambia en iOS 26

Desde iOS 26, cualquier sitio agregado a la pantalla de inicio abre como app web por defecto cuando **Abrir como app web** está activo. Ya no se requiere un manifest para entrar a este modo, aunque el manifest sigue definiendo identidad, nombre, iconos, inicio y alcance. La referencia principal es [WebKit: Every site can be a web app on iOS and iPadOS](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/).

Una app web de pantalla de inicio tiene ventana y ciclo de vida propios. También mantiene cookies y almacenamiento separados del navegador; una sesión iniciada en Safari no se comparte con la instalación. Apple explica este aislamiento y el alcance de navegación en [What's new in web apps](https://developer.apple.com/videos/play/wwdc2023/10120/).

El sistema puede suspender la app en segundo plano. Al volver al frente, Olbia no debe depender de que un timer programado haya corrido mientras estaba suspendida. La sesión se revisa al recibir `pageshow`, al recuperar visibilidad y periódicamente mientras la app permanece activa.

## Decisiones de Olbia

- El manifest usa una identidad estable (`/`), `start_url` y `scope` explícitos, y modo `standalone`, siguiendo la [especificación Web Application Manifest](https://www.w3.org/TR/appmanifest/).
- La sesión de Cognito se conserva en el almacenamiento aislado de cada instalación.
- El ID token se renueva antes de expirar. Las renovaciones concurrentes comparten una sola petición.
- Un `401` de API Gateway dispara una renovación y un único reintento. El primer intento fue rechazado por el authorizer, por lo que el reintento no duplica una mutación.
- Si Cognito rechaza el refresh token, se elimina la sesión local y se vuelve al acceso. Un error transitorio de red no elimina las credenciales.
- Al recuperar foco, TanStack Query vuelve a consultar los datos financieros.
- El layout respeta las safe areas del iPhone en modo standalone.

## Por qué no hay service worker todavía

iOS no requiere service worker para instalar una app web. Olbia tampoco tiene todavía un requisito de operación offline. Añadirlo introduciría una segunda capa de caché y una política de actualización para el shell, la configuración de runtime y datos sensibles. Mientras no exista una experiencia offline explícita y verificable, se conserva la caché HTTP/CDN existente y todas las consultas financieras siguen siendo de red.

Declarative Web Push permite suscribirse y mostrar avisos sin service worker en apps web de pantalla de inicio. Olbia envía push al registrar un movimiento observado y un resumen diario a las 07:00; detalle en [Avisos push de movimientos observados](push-on-new-observable.md) y [Push diario del balance](daily-balance-push.md).

WebKit documenta que el almacenamiento de una app web puede recibir tratamiento persistente, pero sigue sujeto a las políticas de almacenamiento del sistema: [Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/).

## Prueba en un iPhone

1. Elimina una instalación anterior para que iOS vuelva a leer nombre e iconos.
2. En Safari abre `https://finance.castrodavid.dev`.
3. Usa **Compartir → Agregar a pantalla de inicio** y deja activo **Abrir como app web**.
4. Inicia sesión dentro de Olbia, aunque Safari ya tenga una sesión.
5. Envía la app al fondo durante más de una hora y vuelve a abrirla.
6. Confirma que el tablero actualiza sin mostrar `Unauthorized` y que Resumen y Movimientos respetan la isla dinámica y el indicador de inicio.

Para depuración remota, Apple permite inspeccionar las Home Screen Web Apps desde Safari en una Mac con el Web Inspector habilitado en el iPhone: [Inspecting iOS and iPadOS](https://developer.apple.com/documentation/safari-developer-tools/inspecting-ios).
