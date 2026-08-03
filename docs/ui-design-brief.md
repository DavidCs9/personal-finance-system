# Olbia — dirección de producto y UI

Olbia es un tablero personal de gasto mensual. Su promesa principal es responder, de inmediato: cuánto he gastado, qué porcentaje representa, cuánto me queda después de compromisos próximos y cómo cerraré el mes si mantengo el mismo ritmo.

Las reglas operativas que deben seguir futuras implementaciones del frontend están en [`apps/web/AGENTS.md`](../apps/web/AGENTS.md).

## Jerarquía de información

1. **Has gastado** — la cifra dominante. Para MSI cuenta solo la cuota ya reconciliada del mes, no el ticket completo.
2. **A este ritmo** — proyección de cierre; el ritmo diario usa gasto discrecional (no MSI) y suma cuotas/compromisos pendientes.
3. **Te quedan** — disponible después de gasto realizado y dinero comprometido (bills + cuotas MSI aún no reconciliadas).
4. **Incluye por confirmar** — incertidumbre del parser expuesta dentro del total.
5. **Meses sin intereses** — en **Resumen**, sección “Planes con fin”: cuotas del mes con total fijo, inicio y última cuota (`Merchant · cuota i/N · total · rango`). Detalle operativo en [`msi.md`](msi.md).
6. **Gastos fijos** — servicios y suscripciones indefinidos (renta, iCloud, etc.), sin fecha de fin. Las cuotas MSI no se mezclan aquí.

El ingreso mensual se captura manualmente como una sola cifra, aunque provenga de dos depósitos de nómina. El periodo siempre es un mes calendario.

## Personalidad

- Precisa, firme y útil.
- Premium por la jerarquía numérica, la materialidad y la tipografía.
- Cercana en su lenguaje: “Has gastado”, “Te quedan”, “Te faltarán”.
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

- **Resumen** — estado mensual, proyección, Planes con fin (MSI) y gastos fijos.
- **Movimientos** — lista ordenable de evidencia/compras (sin duplicar el bloque de planes MSI).

En escritorio se conserva la misma arquitectura con un ancho de lectura contenido; no se convierte en un dashboard distinto.

## Persistencia mensual

Las compras continúan viniendo de la API existente. El ingreso mensual y los pagos próximos se guardan en DynamoDB mediante `GET /months/{month}` y `PUT /months/{month}`. Cada registro queda aislado por el identificador autenticado del usuario y el mes calendario.

Un mes sin registro se considera no configurado. La UI debe pedir explícitamente el ingreso antes de calcular disponibilidad o permitir administrar pagos próximos; el ingreso se puede editar en cualquier momento.
