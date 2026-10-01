# TODOs — control de nóminas y estados de cuenta

Solicitud de David, 2026-09-30: «Una vez esté el SQL, quiero una tabla con las nóminas y otra con estados de cuenta por tarjeta. Quiero tener súper control de todo».

Estos pendientes se retoman cuando SQL esté listo. Esta rama registra el trabajo futuro; las casillas permanecen abiertas hasta implementarlo y verificarlo.

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

## Verificación de control financiero

- [ ] Poder revisar qué documentos están cargados, qué periodos faltan y qué requiere atención.
- [ ] Validar las tablas y sus totales con los documentos reales de David, preservando evidencia e historial y evitando doble conteo.
- [ ] Mantener las reglas actuales de liquidez, gasto mensual y patrimonio; un saldo de estado de cuenta no equivale automáticamente a la deuda actual de una tarjeta.
- [ ] Integrar las tablas con una experiencia usable en móvil y la navegación actual Resumen / Movimientos / Patrimonio, siguiendo las [guías de UI](docs/ui-design-brief.md).
