# Olbia — dirección de producto y UI

Olbia es un tablero personal de finanzas. Su promesa principal en **Resumen** es responder, de inmediato: cuánto he gastado, qué porcentaje representa, cuánto me queda después de compromisos próximos y cómo cerraré el mes si mantengo el mismo ritmo. **Patrimonio** responde otra pregunta: cuánto tienes en neto hoy (activos − deudas de tarjeta) y cómo ha cambiado.

Las reglas operativas que deben seguir futuras implementaciones del frontend están en [`apps/web/AGENTS.md`](../apps/web/AGENTS.md).

## Jerarquía de información

### Resumen (gasto del mes)

1. **Has gastado** — la cifra dominante. Para MSI cuenta solo la cuota ya reconciliada del mes, no el ticket completo.
2. **A este ritmo** — proyección de cierre; el ritmo diario usa gasto discrecional (no MSI) y suma cuotas/compromisos pendientes.
3. **Te quedan** — disponible después de gasto realizado y dinero comprometido (bills + cuotas MSI aún no reconciliadas).
4. **Incluye por confirmar** — incertidumbre del parser expuesta dentro del total.
5. **Meses sin intereses** — en **Resumen**, sección “Planes con fin”: cuotas del mes con total fijo, inicio y última cuota (`Merchant · cuota i/N · total · rango`). Detalle operativo en [`msi.md`](msi.md).
6. **Gastos fijos** — servicios y suscripciones indefinidos (renta, iCloud, etc.), sin fecha de fin. Las cuotas MSI no se mezclan aquí.
7. **Fechas de corte** — en **Resumen**, calendario del mes con día de corte y día de pago de hasta tres tarjetas. Son recordatorios de ciclo; no restan de “Te quedan” ni se mezclan con gastos fijos.

El ingreso mensual (liquidez) se deriva de los XML de CFDI nómina subidos (`FechaPago` → mes). El chip **Liquidez** muestra esa cifra; tocar abre **Nómina del mes** (liquidez + compensación = liquidez + aportaciones al fondo SAT `004`, con estimado de 2ª quincena cuando aplica). Cada nómina abre un desglose centrado en liquidez, fondo, ISR e IMSS; las líneas SAT quedan colapsadas. Con una sola nómina ordinaria en el mes actual, Resumen estima la 2ª quincena. Sin XML del mes actual, la liquidez puede ser provisional a partir de ordinarias previas. Resumen (% gastado, Te quedan) usa solo liquidez, nunca compensación.

### Patrimonio (neto)

1. **Neto** — activos − saldos pendientes de tarjeta en MXN (hero en vista total).
2. **Dónde está** — desglose de activos (Cajita Nu, Fondo de ahorro, Bitso, Interactive Brokers).
3. **Debes** — saldos pendientes de hasta tres tarjetas (captura manual; incluye MSI).
4. **Historial** — un punto canónico por día (neto en vista total); filtro al seleccionar cuenta de activo.
5. **Holdings** — posiciones embebidas en el snapshot del día.

Patrimonio no mezcla el gasto del mes ni “Te quedan”. Detalle en [`patrimonio.md`](patrimonio.md).

## Personalidad

- Precisa, firme y útil.
- Premium por la jerarquía numérica, la materialidad y la tipografía.
- Cercana en su lenguaje: “Has gastado”, “Te quedan”, “Te faltarán”, “Neto”, “Debes”.
- Sin gamificación, estética bancaria corporativa ni mensajes de bienestar.
- El color se tensa gradualmente; el rojo pleno se reserva para una proyección negativa.

## Sistema visual

- Fondo marfil, superficies carbón y rojo de alerta.
- Sans serif para datos y texto; serif discreta para títulos.
- Superficies moderadamente redondeadas, bordes definidos y cifras tabulares.
- Marca: **Olbia**, referencia griega sutil a prosperidad y abundancia.
- Símbolo: una balanza geométrica abstracta.

## Navegación

La experiencia se diseña primero para móvil (95% del uso esperado):

- **Resumen** — estado mensual, proyección, Planes con fin (MSI), gastos fijos y fechas de corte/pago de tarjetas.
- **Movimientos** — lista ordenable de evidencia/compras (sin duplicar el bloque de planes MSI), con categoría (badge) editable en el detalle.
- **Patrimonio** — neto, activos, deudas de tarjeta, historial y holdings; el selector de mes permanece usable para cambiar periodo sin salir de la tab (el patrimonio sigue siendo el estado actual, no un corte mensual).

**Asistente** — no es una cuarta tab. Se abre como **sheet global** desde un icono del topbar (disponible en las tres destinaciones). Consultas en lenguaje natural sobre el mes (y patrimonio de solo lectura); citas a movimientos/cifras; sin historial durable en UI (el hilo vive solo mientras el sheet está abierto; cambiar el mes del selector limpia el hilo). Detalle técnico en [`ai-assistant.md`](ai-assistant.md).

En escritorio se conserva la misma arquitectura con un ancho de lectura contenido; no se convierte en un dashboard distinto.

## Persistencia mensual

Las compras continúan viniendo de la API existente. La liquidez del mes se deriva de `GET /months/{month}` a partir de las nóminas CFDI (`payslips`, `incomeMinor`, `estimateActive`, `provisionalActive`). Los pagos próximos se guardan con `PUT /months/{month}` (solo `upcomingPayments`). Cada registro queda aislado por el identificador autenticado del usuario y el mes calendario.

En el mes calendario actual, si aún no hay nóminas, la liquidez puede ser **provisional** a partir del patrón de las últimas 1–2 nóminas ordinarias (doble de la última, o suma de las dos más recientes). La UI muestra Resumen usable con esa cifra y pide el XML; al subir la primera nómina del mes, se aplica la lógica normal (depósitos + estimado de 2ª quincena si aplica). Un mes pasado sin nóminas sigue sin configurar.

Los snapshots de patrimonio viven en la misma tabla (`GET /wealth`, `POST /wealth/accounts/.../snapshots`, `POST /wealth/liabilities/{cardId}/snapshots`, `POST /wealth/sync/bitso`, `POST /wealth/sync/ibkr`) con día calendario `America/Chihuahua`.
