# Olbia: dirección de UI

Guía vinculante para cualquier cambio visible, incluidos reportes y mensajes fuera del frontend. Sigue el [norte del producto](product-north-star.md) y las [reglas financieras](financial-rules.md). Las instrucciones de implementación están en [AGENTS web](../apps/web/AGENTS.md).

## Navegación y jerarquía

Decisión explícita de David del **2026-10-25**: cuatro tabs en este orden, **Resumen / Movimientos / Planificación / Patrimonio**. Primero organizar la aplicación y sus listas; después abordar la confiabilidad financiera en un trabajo separado. La reorganización reutiliza datos y cálculos existentes, sin corregir conciliaciones ni introducir fórmulas nuevas. Diseñar primero para móvil: al menos 95% del uso esperado. En escritorio mantener el mismo recorrido con ancho de lectura contenido.

Cada lista completa tiene una ubicación principal. Resumen conserva cifras, alertas, análisis y accesos compactos; Movimientos reúne cobros y su revisión; Planificación reúne programación y fechas; Patrimonio conserva activos, deudas y neto.

**Resumen** responde cuánto has gastado y qué significa para el resto del mes. Orden:

1. **Has gastado**, cifra dominante. En el mismo bloque, **Con fijos y MSI pendientes** muestra el total de gasto y compromisos, con su porcentaje de liquidez y **Ver cómo se compone**: gasto registrado, fijos programados y MSI pendientes separados. Las cuotas MSI registradas ya forman parte de Has gastado. El detalle aclara que los fijos son programación sin verificación de cobro. El porcentaje acompaña al total combinado; no presentar dos porcentajes compitiendo.
2. **A este ritmo**, proyección al cierre.
3. **Te quedan**, después de compromisos.
4. **Incluye por confirmar**, incertidumbre dentro del total.
5. Acceso compacto a **Planificación**: MSI, gastos fijos y próximas fechas.
6. Acceso compacto a **Estados de cuenta**: PDF registrados y cortes faltantes, con alcance explícito de todas las fechas.
7. **En qué se fue**, entrada compacta al análisis y a su evidencia.
8. Preferencias de avisos, con prioridad visual secundaria.

**Te quedan** indica «según tu gasto y compromisos del mes». **A este ritmo** declara que incluye fijos y MSI del mes. El total combinado no sustituye gasto observado, categorías ni cierre mensual; sigue las [reglas del resumen](financial-rules.md#resumen-del-mes). No mostrar porcentaje, disponibilidad o proyección válidos sin liquidez válida; mantener visibles provisionales e importes por confirmar. El desglose usa expansión nativa, conserva modo privado y se cierra al cambiar de mes.

El chip **Liquidez** concentra el acceso a **Nómina del mes**, sus recibos y la carga XML: liquidez y compensación. Cada recibo presenta primero liquidez, fondo, ISR e IMSS; líneas SAT colapsadas. La lista completa de nóminas permanece en ese detalle; Resumen conserva el aviso y la acción para añadir nómina cuando falta. Estimados y cifras provisionales se etiquetan y piden el XML. Si falta liquidez válida, disponibilidad y proyección no se presentan como válidas.

**Planificación** responde qué tienes programado. Usa el mes global elegido para sus cuotas MSI, gastos fijos y calendario de tarjetas; la cabecera explicita el periodo. Se puede consultar sin nómina ni liquidez configurada. Una fuente con error no oculta las secciones que sí están disponibles ni se presenta como cero. Orden:

1. **Planes con fin**, cuotas MSI del mes con comercio, tags de contexto cuando existan, cuota i/N, total fijo e inicio–fin. Cada plan conserva la identidad de su compra y acceso a su evidencia; varias compras del mismo comercio permanecen distinguibles. Mantener las señales de cuotas registradas, comprometidas, calendarios incompletos e importes por confirmar.
2. **Gastos fijos**, servicios y suscripciones con nombre, importe y día programado, separados de MSI. Conservar sus acciones de alta/edición y mostrar el mes fuente cuando la lista sea heredada. La programación no acredita cobro ni conciliación; su significado sigue las [reglas financieras](financial-rules.md#nómina-y-gastos-fijos).
3. **Próximos compromisos**, acceso al detalle de próximos meses.
4. **Fechas de corte**, calendario de corte/pago de hasta tres tarjetas y edición de perfiles. Fechas y recordatorios se mantienen separados de los importes programados y saldos de Patrimonio.

**Próximos compromisos** abre un sheet desde Planificación. Presenta 12 meses desde el mes actual real, continuación por periodos, total conocido en MXN y desglose separado de MSI/gastos fijos. Si el mes global elegido es otro, explicar ese horizonte. Cada mes se expande para ver cuotas, fechas de fin, días programados y acceder a la compra/evidencia. Mostrar cambios entre meses futuros completos, importes por confirmar, calendarios incompletos excluidos y ausencia de configuración fija. Las cifras siguen las [reglas de compromisos futuros](financial-rules.md#compromisos-futuros); no proyectar ingresos ni disponibilidad futura.

**Movimientos** es una lista simple ordenable, con categorías editables en el detalle y tags discretos con filtro exacto. MSI muestra badge i/N y cuota del mes; no duplica Planes con fin. Una autorización USD muestra el importe original y **Esperando cargo MXN**. Un cargo compartido muestra **Mi parte** primero y el bruto bancario como evidencia secundaria. Rechazados se ocultan del recorrido normal, conservando auditoría.

**Estados de cuenta** es un único catálogo en un sheet desde Resumen, independiente del mes elegido y con alcance de todas las fechas visible en su entrada. Agrupa los PDF registrados por banco y últimos cuatro observados; muestra periodo, estado de lectura/conciliación, originales y cortes sin archivo identificado. Permite subir el PDF faltante o retomar una lectura/conciliación. Mantener visibles archivos sin tarjeta/periodo y errores; no presentar cobertura completa cuando falta identificar archivos. Los huecos son estimaciones según las [reglas de cobertura](financial-rules.md#cobertura-de-estados-de-cuenta). Un estado aplicado no certifica la exactitud o cobertura completa del gasto. Movimientos conserva la captura PDF desde Añadir, sin otro acceso al catálogo.

**Añadir** abre **Sumar un movimiento**: Registrar cobro, Conciliar CSV Santander, Estado de cuenta Santander y Estado de cuenta Amex. Ordenar queda fuera. El cobro manual pide institución, comercio, cantidad, fecha y tarjeta/nota opcionales; **Sumar al mes** es el CTA. Su detalle identifica **Registro manual** y permite rechazo.

**Patrimonio** responde cuánto tienes en neto hoy. Orden: **Neto → Dónde está → Debes → Historial → Holdings**. No mezclar gasto mensual ni Te quedan. El total usa tendencia mensual desde agosto 2026; una cuenta usa historial diario. Mostrar lista numérica, con sparkline mínima de apoyo. El selector global de mes sigue usable, sin convertir el patrimonio actual en un corte mensual. Actualizar total refresca Bitso e IBKR; Fondo muestra su condición ilíquida hasta diciembre.

## Voz y sistema visual

Precisa, firme, útil, personal y premium por la jerarquía numérica. Hablar directamente: “Has gastado”, “Te quedan”, “Gastarás”, “Neto”, “Debes”. Explicar consecuencias con importes y pasos de investigación; exponer incertidumbre y antigüedad. Sin vergüenza, felicitaciones por gastar, bienestar, gamificación ni lenguaje bancario innecesario.

Fondo marfil, superficies carbón y rojo para consecuencias negativas relevantes. Tensión gradual; rojo pleno reservado para proyección negativa o fallo crítico. Sans serif en datos/texto, serif editorial discreta en títulos, cifras tabulares alineadas, bordes definidos y redondeado moderado. Evitar azul corporativo, exceso de pills, gradientes y gráficas ornamentales. Marca Olbia, referencia griega sutil a prosperidad; símbolo de balanza geométrica abstracta.

Priorizar cifras, porcentajes y comparaciones. Una gráfica debe explicar una relación que la jerarquía numérica no comunica. Respetar safe areas, acciones alcanzables y targets cómodos; estado principal legible en segundos sin scroll horizontal.

## Asistente y correo

El asistente es un sheet global del topbar, accesible desde las cuatro tabs. Conserva conversación al cerrar, recargar o cambiar mes; **Nueva conversación** no borra las anteriores. Conversaciones y memorias durables tienen superficies separadas para revisar/borrar. Mostrar citas, actividad compacta de tools y errores como datos no disponibles; jamás inputs crudos ni razonamiento privado. Modo privado también protege títulos, texto restaurado y recibos.

Una instrucción explícita de tags/categoría autoriza el cambio acotado descrito en [asistente](ai-assistant.md#mutations): sin segunda confirmación UI; recibo factual por operación y undo por chat. Las categorías del asistente no crean reglas de comercio.

**Precierre** pone primero Cajita y deudas manuales con importe/fecha y captura pendiente; Fondo derivado y Bitso/IBKR automáticos. **Cierre mensual** tiene dos capítulos: **Tu mes / Dónde se fue** y **Tu patrimonio / Qué cambió**. Conservar voz/paleta, declarar tags superpuestos y no atribuir causalidad entre gasto y variación patrimonial.

## Verificación visual

Revisar primero en viewport móvil: jerarquías, formato monetario, evidencia accesible y estados de carga, vacío, error, ingreso faltante, incertidumbre, saldos antiguos y proyección negativa. Un cambio de personalidad requiere decisión explícita y actualización conjunta de esta guía y AGENTS web.
