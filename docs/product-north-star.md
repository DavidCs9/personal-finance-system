# Olbia: norte del producto

Decisión explícita de David Castro, 2026-09-30.

**Olbia es la aplicación privada de David Castro para llevar el control de su situación financiera general. Su único usuario y dueño es David Castro.**

Esta es la definición que guía decisiones de producto, UX, datos, infraestructura e integraciones. Las guías de UI, contratos financieros y planes de migración desarrollan este propósito.

## Qué debe permitirle a David

- Entender sus ingresos, gasto, liquidez disponible y compromisos próximos.
- Conocer sus activos, inversiones, deudas y patrimonio neto, y cómo cambian con el tiempo.
- Revisar movimientos, categorías, contextos y evidencia; corregir y conciliar sus datos.
- Detectar qué necesita atención y tomar decisiones con cifras confiables y su contexto personal.
- Mantener ese control con la menor captura manual y carga operativa razonables.

El gasto del mes es una parte de la situación financiera general. Resumen, Movimientos y Patrimonio son vistas complementarias de las mismas finanzas de David; conservan sus reglas y jerarquías actuales. El asistente, reportes y automatizaciones sirven al mismo propósito.

## Para quién se diseña

Para David Castro y nadie más. Sus cuentas, tarjetas, fuentes, hábitos, prioridades y forma de usar la aplicación determinan qué implementar. Es válido personalizar directamente para él.

El producto no incluye registro para otras personas, invitaciones, cuentas compartidas, organizaciones, roles de clientes ni soporte multitenant. No es una fase inicial de un producto público. Añadir otro usuario requiere una nueva decisión explícita de David.

Los campos técnicos `owner`, Cognito `sub` e identidades IAM vinculan datos, acciones e integraciones con David y protegen su acceso. Su presencia no justifica construir gestión de usuarios ni anticipar otros clientes. El acceso financiero corresponde a su identidad autorizada y a sus integraciones configuradas.

## Cómo decidir

### Norte de la arquitectura SQL

Decisión explícita de David Castro, 2026-10-01: **Olbia debe sentirse como una aplicación nacida en SQL.** El modelo y las operaciones deben expresar entidades financieras, claves de dominio, relaciones, restricciones e interacción SQL directa.

Las claves `PK`/`SK`, los campos `GSI`, los comandos de documentos, los envelopes y las proyecciones heredadas de DynamoDB son mecanismos temporales de compatibilidad y recuperación. No son el diseño final de persistencia ni deben reaparecer bajo nombres nuevos. Cada entrega de normalización debe acercar un dominio completo a una única autoridad relacional y migrar sus lectores y escritores. JSON sigue siendo válido para evidencia original, cambios históricos y metadata variable cuando su significado lo justifica; no sustituye relaciones y campos operativos canónicos.

La pregunta para cada cambio es: **¿esto ayuda a David a entender o controlar mejor su situación financiera, con datos confiables y menos esfuerzo?**

- Priorizar sus necesidades concretas y los patrones de consulta de sus datos reales.
- Elegir la solución más simple que preserve integridad, evidencia, recuperación y acceso privado.
- Usar capacidades nativas cuando cubran la necesidad; introducir recursos o abstracciones adicionales cuando exista un problema concreto que lo requiera.
- Validar con sus datos reales. No exigir anonimización, enmascaramiento ni datasets sintéticos como requisito para investigar, implementar o verificar.
- Mantener pruebas útiles y entrega por PR/`quality`; la simplicidad debe facilitar que las cifras sean correctas y que los cambios se puedan recuperar.

El éxito se evalúa por la utilidad para David: puede entender qué tiene, qué debe, cómo gasta y qué viene, y confiar en la información. No se optimiza para adquisición de usuarios, crecimiento comercial o adopción por otras personas.

## Aplicación privada y código público

Que el repositorio sea público como muestra técnica no convierte la aplicación ni sus datos financieros en un servicio público. Trabajar con datos reales para el desarrollo y la validación es una decisión distinta de publicarlos en Git; esta definición no implica incorporar fuentes financieras al repositorio.

## Documentos que aplican este norte

- [`../AGENTS.md`](../AGENTS.md): instrucciones de trabajo para todo el repositorio.
- [`ui-design-brief.md`](ui-design-brief.md) y [`../apps/web/AGENTS.md`](../apps/web/AGENTS.md): dirección y reglas de UI.
- [`v1-decisions.md`](v1-decisions.md): contratos y decisiones operativas.
- [`patrimonio.md`](patrimonio.md): activos, pasivos e historial.
- [`dsql-migration-plan.md`](dsql-migration-plan.md): migración gradual para los datos de David, conservando DynamoDB.
