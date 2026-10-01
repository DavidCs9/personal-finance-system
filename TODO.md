# TODOs — control financiero: nóminas, estados de cuenta y presupuestos

Solicitud de David, 2026-09-30: «Una vez esté el SQL, quiero una tabla con las nóminas y otra con estados de cuenta por tarjeta. Quiero tener súper control de todo».

Las tablas de nóminas y estados de cuenta se retoman cuando SQL esté listo. Esta rama registra el trabajo futuro; las casillas permanecen abiertas hasta implementarlo y verificarlo.

Solicitud adicional de David: incorporar presupuestos mensuales, actualizar cómo vamos al registrar cada compra y avisar «cuidado, estás llegando al límite».

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

## Verificación de control financiero

- [ ] Poder revisar qué documentos están cargados, qué periodos faltan y qué requiere atención.
- [ ] Validar las tablas y sus totales con los documentos reales de David, preservando evidencia e historial y evitando doble conteo.
- [ ] Mantener las reglas actuales de liquidez, gasto mensual y patrimonio; un saldo de estado de cuenta no equivale automáticamente a la deuda actual de una tarjeta.
- [ ] Integrar las tablas con una experiencia usable en móvil y la navegación actual Resumen / Movimientos / Patrimonio, siguiendo las [guías de UI](docs/ui-design-brief.md).
