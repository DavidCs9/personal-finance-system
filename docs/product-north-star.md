# Olbia: norte del producto

**Olbia es la aplicación privada de David Castro para controlar su situación financiera general. David es su único usuario y dueño.** Decisión explícita del 2026-09-30.

Debe permitirle entender ingresos, gasto, liquidez, compromisos, activos, inversiones, deudas y patrimonio; revisar y corregir movimientos con su evidencia; detectar qué necesita atención y decidir con cifras confiables y menos captura manual.

Resumen, Movimientos y Patrimonio son vistas complementarias. Asistente, reportes y automatizaciones sirven al mismo propósito.

## Restricciones de producto

Diseñar para sus cuentas, fuentes, hábitos y prioridades reales. No añadir registro público, otros usuarios, organizaciones, colaboración, roles de clientes ni configuración multitenant sin una nueva decisión explícita de David. Los campos owner, Cognito sub e IAM protegen su acceso y sus integraciones; no implican otro público.

Validar con sus datos reales. Anonimización, enmascaramiento y datasets sintéticos no son requisitos previos. El código público como muestra técnica no convierte la aplicación en un servicio público ni autoriza versionar sus fuentes o datos privados.

## Restricción de arquitectura

**OLBIA MUST FEEL AS IF IT WAS BORN IN SQL.** Decisión explícita del 2026-10-01.

Usar entidades y claves de dominio, columnas tipadas, relaciones, restricciones nativas, SQL directo y transacciones. Cada dominio tiene autoridad relacional única y todos sus lectores/escritores la usan. No reintroducir PK/SK, GSI, comandos de documentos, envelopes ni proyecciones autoritativas bajo otros nombres. JSON corresponde a evidencia original, cambios inmutables o metadata variable.

Decisión explícita del 2026-10-04: **DSQL sin tablas ni copias de evidencia de migración**, tampoco en esquemas de archivo. Bootstrap/verificadores no las recrean ni dependen de ellas. Conservar historia financiera nativa, los tres controles operativos, originales S3 y respaldos nativos. DynamoDB conserva la recuperación previa al cambio; esta decisión sustituye la retención de copias en DSQL.

## Cómo decidir

¿Ayuda a David a entender o controlar mejor sus finanzas con datos confiables y menos esfuerzo?

Elegir la solución más simple que preserve integridad, evidencia, recuperación y acceso privado. Preferir capacidades nativas; justificar un hueco concreto antes de añadir código propio. Mantener pruebas útiles y el flujo PR/quality.

Las reglas específicas viven en [finanzas](financial-rules.md), [UI](ui-design-brief.md), [arquitectura](architecture.md), [operación](operations.md) y [asistente](ai-assistant.md).
