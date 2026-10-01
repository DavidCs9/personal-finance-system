# TODOs — control financiero

Solicitud de David, 2026-09-30: «Una vez esté el SQL, quiero una tabla con las nóminas y otra con estados de cuenta por tarjeta. Quiero tener súper control de todo».

Las tablas de nóminas y estados de cuenta se retoman cuando SQL esté listo. Esta rama registra el trabajo futuro; las casillas permanecen abiertas hasta implementarlo y verificarlo.

Solicitud adicional de David: incorporar presupuestos mensuales, actualizar cómo vamos al registrar cada compra y avisar «cuidado, estás llegando al límite».

Solicitud adicional de David: una tabla de MSI para ver progresos, planes pasados y activos.

Solicitud adicional de David, 2026-10-01: mejorar el correo de cierre que se envía el día 1; considera que el correo actual es malo y que el análisis de IA es de baja calidad.

## Dependencia: SQL listo

- [ ] Confirmar que la migración/proyección SQL está operativa y que su historial y cifras tienen paridad con la fuente actual. Referencia: [plan DSQL](docs/dsql-migration-plan.md) y [runbook](docs/dsql-migration-runbook.md).

## 1. Tabla de nóminas

- [ ] Tener una tabla consultable con el historial de nóminas, respaldada por SQL y vinculada a los CFDI XML importados.
- [ ] Permitir filtrar por mes/año y ordenar por fecha de pago.
- [ ] Definir las columnas con los datos disponibles: fecha de pago, periodo, tipo de nómina, liquidez neta, percepciones, deducciones y aportaciones al fondo de ahorro.
- [ ] Abrir el desglose y la evidencia XML original desde cada nómina.
- [ ] Mostrar totales del periodo sin mezclar nóminas reales con estimaciones o liquidez provisional; conservar la deduplicación por UUID.

## 2. Tabla de estados de cuenta por tarjeta

- [ ] Tener otra tabla consultable con el historial de estados de cuenta, respaldada por SQL y organizada por tarjeta.
- [ ] Permitir filtrar por tarjeta y periodo, y ordenar cronológicamente.
- [ ] Definir las columnas según la evidencia disponible: tarjeta, periodo, fecha de corte, fecha límite de pago, importes reportados y estado de importación/conciliación. Mostrar explícitamente los datos faltantes.
- [ ] Abrir el PDF original y revisar sus movimientos, cuotas MSI y pendientes de conciliación desde cada estado de cuenta.
- [ ] Asociar cada estado de cuenta a la tarjeta correcta; dejar para revisión las asociaciones ambiguas y conservar la deduplicación de importaciones.

## 3. Presupuestos mensuales y avisos de límite

- [ ] Incorporar presupuestos por mes, con un límite de gasto editable e historial que preserve los meses anteriores. Definir si el alcance incluye un presupuesto total, presupuestos por categoría o ambos.
- [ ] Mostrar el límite, gasto acumulado, porcentaje consumido y cuánto queda del presupuesto; distinguir ese disponible de la liquidez y de «Te quedan» después de compromisos.
- [ ] Actualizar el estado del presupuesto al registrar cada compra en Olbia desde las fuentes existentes, reflejándolo en la interfaz sin recarga manual. La actualización depende de recibir y procesar la compra; no prometer detección antes de que llegue la evidencia.
- [ ] Recalcular ante correcciones, rechazos, conciliaciones y cambios de categoría si aplican; los reintentos y las observaciones duplicadas de una compra no deben consumir el presupuesto otra vez.
- [ ] Usar las mismas reglas de gasto que Resumen: Mi parte cuando corresponda, sólo cuotas MSI gastadas del mes, compras por confirmar con incertidumbre explícita, y exclusión de rechazadas y autorizaciones extranjeras pendientes. Mostrar compromisos futuros por separado.
- [ ] Implementar un sistema de cuidado con estados claros: dentro del presupuesto, cerca del límite y límite alcanzado/superado. Definir los umbrales de aviso; por ejemplo, 80 %, 90 % y 100 % son una propuesta pendiente, no una decisión tomada.
- [ ] Al acercarse o superar el límite, mostrar un aviso útil con cifras: «Cuidado, estás llegando al límite: llevas X de Y; te quedan Z» o «Superaste tu presupuesto por X». Integrarlo en Resumen y aprovechar los avisos push existentes para notificar según las preferencias autorizadas.
- [ ] Evitar avisos repetidos en cada compra o reintento: definir una política por presupuesto, mes y umbral, incluyendo qué ocurre si el gasto baja o cambia el límite.
- [ ] Verificar cambio de mes en America/Chihuahua, presupuesto ausente o cero, compras retrasadas, cruces de varios umbrales en una compra y correcciones, con importes en unidades menores y sin doble conteo.

## 4. Tabla de MSI: progreso, activos e historial

- [ ] Tener una tabla consultable de todos los planes MSI, incluyendo activos y pasados, sin limitar el historial al mes seleccionado.
- [ ] Mostrar por plan: comercio, tarjeta cuando esté identificada, importe total, cuota, fecha de inicio y última cuota, estado, cuotas gastadas/pendientes/canceladas, progreso e importe pendiente según el calendario.
- [ ] Filtrar por activos, terminados y cancelados/cerrados anticipadamente, además de tarjeta y periodo; definir el estado con el calendario y la evidencia, no sólo con el paso del tiempo.
- [ ] Mostrar el progreso como cuotas gastadas respecto del total y su porcentaje. Distinguir las cuotas conciliadas de los pagos efectivos de la tarjeta: una cuota `spent` no demuestra por sí sola que se haya pagado al banco. Marcar las cuotas anteriores asumidas por un estado de cuenta y no presentarlas como evidencia individual.
- [ ] Abrir el calendario completo de cuotas desde cada plan, con mes, importe, estado y evidencia de conciliación; conservar el historial al terminar o cerrar anticipadamente un plan.
- [ ] Actualizar el progreso al conciliar estados de cuenta/CSV o corregir un plan, preservando un único plan por compra y evitando duplicados o cuotas contadas dos veces.
- [ ] Acceder a la tabla desde Resumen → Planes con fin, conservando la sección de cuotas del mes, la lista simple de Movimientos y la navegación actual. Referencia: [reglas MSI](docs/msi.md).
- [ ] Verificar planes activos, terminados, incompletos y cerrados anticipadamente; conservar la regla de gasto mensual por cuota y mantener las cuotas futuras como compromisos, sin sumar el principal completo al gasto ni confundirlo con la deuda actual de la tarjeta.

## 5. Mejorar el correo de cierre mensual y su análisis de IA

- [ ] Revisar el correo realmente enviado el día 1 y su análisis persistido, contrastándolo con los datos del mes cerrado. Identificar qué aporta poco y si se usó IA o el fallback determinista antes de decidir la solución.
- [ ] Mejorar la lectura de IA para que sea específica y útil para David: qué cambió frente a meses anteriores, qué explica las variaciones según la evidencia disponible, qué requiere atención y qué acciones concretas puede tomar. Evitar frases genéricas, obviedades y repetir las tablas sin interpretarlas.
- [ ] Revisar el contexto que recibe el modelo, el prompt, las señales calculadas y las restricciones del formato de salida; corregir las limitaciones que estén produciendo un análisis superficial, sin inventar causas ni cifras.
- [ ] Mejorar la jerarquía y redacción del correo para destacar los hallazgos relevantes y facilitar la lectura en móvil, conservando los capítulos «Tu mes / Dónde se fue» y «Tu patrimonio / Qué cambió».
- [ ] Mantener cifras calculadas por código, incertidumbre explícita, corte al último día del mes anterior y distinción entre variación patrimonial y rendimiento. Incluir presupuestos y compromisos MSI cuando esos datos estén disponibles y aporten contexto.
- [ ] Preparar una vista previa del cierre mejorado con los datos reales del correo criticado y comparar el antes/después; verificar que cada hallazgo esté respaldado por evidencia y que el fallback siga siendo útil si falla la IA. Referencia: [correo de cierre mensual](docs/monthly-close-email.md).

## Verificación de control financiero

- [ ] Poder revisar qué documentos están cargados, qué periodos faltan y qué requiere atención.
- [ ] Validar las tablas y sus totales con los documentos reales de David, preservando evidencia e historial y evitando doble conteo.
- [ ] Mantener las reglas actuales de liquidez, gasto mensual y patrimonio; un saldo de estado de cuenta no equivale automáticamente a la deuda actual de una tarjeta.
- [ ] Integrar las tablas con una experiencia usable en móvil y la navegación actual Resumen / Movimientos / Patrimonio, siguiendo las [guías de UI](docs/ui-design-brief.md).
