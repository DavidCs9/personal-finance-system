# Olbia: dirección de UI

Guía vinculante para cualquier cambio visible, incluidos reportes y mensajes fuera del frontend. Sigue el [norte del producto](product-north-star.md) y las [reglas financieras](financial-rules.md). Las instrucciones de implementación están en [AGENTS web](../apps/web/AGENTS.md).

## Navegación y jerarquía

Conservar tres tabs: **Resumen / Movimientos / Patrimonio**. Diseñar primero para móvil: al menos 95% del uso esperado. En escritorio mantener el mismo recorrido con ancho de lectura contenido.

**Resumen** responde cuánto has gastado y qué significa para el resto del mes. Orden:

1. **Has gastado**, cifra dominante.
2. **A este ritmo**, proyección al cierre.
3. **Te quedan**, después de compromisos.
4. **Incluye por confirmar**, incertidumbre dentro del total.
5. **Planes con fin**, cuotas MSI del mes con comercio, cuota i/N, total fijo e inicio–fin.
6. **Gastos fijos**, servicios y suscripciones indefinidos, separados de MSI.
7. **Fechas de corte**, calendario de corte/pago de hasta tres tarjetas, antes de preferencias push.
8. **En qué se fue**, entrada compacta al análisis y a su evidencia; sin cuarta tab.

El chip **Liquidez** abre **Nómina del mes**: liquidez y compensación. Cada recibo presenta primero liquidez, fondo, ISR e IMSS; líneas SAT colapsadas. Estimados y cifras provisionales se etiquetan y piden el XML. Si falta liquidez válida, disponibilidad y proyección no se presentan como válidas.

**Movimientos** es una lista simple ordenable, con categorías editables en el detalle y tags discretos con filtro exacto. MSI muestra badge i/N y cuota del mes; no duplica Planes con fin. Una autorización USD muestra el importe original y **Esperando cargo MXN**. Un cargo compartido muestra **Mi parte** primero y el bruto bancario como evidencia secundaria. Rechazados se ocultan del recorrido normal, conservando auditoría.

**Añadir** abre **Sumar un movimiento**: Registrar cobro, Conciliar CSV Santander, Estado de cuenta Santander y Estado de cuenta Amex. Ordenar queda fuera. El cobro manual pide institución, comercio, cantidad, fecha y tarjeta/nota opcionales; **Sumar al mes** es el CTA. Su detalle identifica **Registro manual** y permite rechazo.

**Patrimonio** responde cuánto tienes en neto hoy. Orden: **Neto → Dónde está → Debes → Historial → Holdings**. No mezclar gasto mensual ni Te quedan. El total usa tendencia mensual desde agosto 2026; una cuenta usa historial diario. Mostrar lista numérica, con sparkline mínima de apoyo. El selector global de mes sigue usable, sin convertir el patrimonio actual en un corte mensual. Actualizar total refresca Bitso e IBKR; Fondo muestra su condición ilíquida hasta diciembre.

## Voz y sistema visual

Precisa, firme, útil, personal y premium por la jerarquía numérica. Hablar directamente: “Has gastado”, “Te quedan”, “Gastarás”, “Neto”, “Debes”. Explicar consecuencias con importes y pasos de investigación; exponer incertidumbre y antigüedad. Sin vergüenza, felicitaciones por gastar, bienestar, gamificación ni lenguaje bancario innecesario.

Fondo marfil, superficies carbón y rojo para consecuencias negativas relevantes. Tensión gradual; rojo pleno reservado para proyección negativa o fallo crítico. Sans serif en datos/texto, serif editorial discreta en títulos, cifras tabulares alineadas, bordes definidos y redondeado moderado. Evitar azul corporativo, exceso de pills, gradientes y gráficas ornamentales. Marca Olbia, referencia griega sutil a prosperidad; símbolo de balanza geométrica abstracta.

Priorizar cifras, porcentajes y comparaciones. Una gráfica debe explicar una relación que la jerarquía numérica no comunica. Respetar safe areas, acciones alcanzables y targets cómodos; estado principal legible en segundos sin scroll horizontal.

## Asistente y correo

El asistente es un sheet global del topbar, accesible desde las tres tabs. Conserva conversación al cerrar, recargar o cambiar mes; **Nueva conversación** no borra las anteriores. Conversaciones y memorias durables tienen superficies separadas para revisar/borrar. Mostrar citas, actividad compacta de tools y errores como datos no disponibles; jamás inputs crudos ni razonamiento privado. Modo privado también protege títulos, texto restaurado y recibos.

Una instrucción explícita de tags/categoría autoriza el cambio acotado descrito en [asistente](ai-assistant.md#mutations): sin segunda confirmación UI; recibo factual por operación y undo por chat. Las categorías del asistente no crean reglas de comercio.

**Precierre** pone primero Cajita y deudas manuales con importe/fecha y captura pendiente; Fondo derivado y Bitso/IBKR automáticos. **Cierre mensual** tiene dos capítulos: **Tu mes / Dónde se fue** y **Tu patrimonio / Qué cambió**. Conservar voz/paleta, declarar tags superpuestos y no atribuir causalidad entre gasto y variación patrimonial.

## Verificación visual

Revisar primero en viewport móvil: jerarquías, formato monetario, evidencia accesible y estados de carga, vacío, error, ingreso faltante, incertidumbre, saldos antiguos y proyección negativa. Un cambio de personalidad requiere decisión explícita y actualización conjunta de esta guía y AGENTS web.
