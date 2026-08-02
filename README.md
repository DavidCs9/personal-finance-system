# Olbia — Personal Finance System

Un tablero personal de gasto mensual que observa eventos financieros desde alertas por correo, sin acceder a credenciales bancarias.

## Estado

La V1 recibe correos reenviados a través de Amazon SES y observaciones automáticas de Apple Pay mediante Shortcuts. Conserva cada fuente antes de reconciliar observaciones de una misma compra.

## Estructura

- `apps/web` — UI de revisión personal.
- `infrastructure` — aplicación CDK para los recursos de AWS.
- `packages/domain` — tipos y reglas de dominio compartidos.
- `services/api` — handlers de la API para la UI.
- `services/ingestion` — persistencia y parsing de compras.
- `tests/fixtures/email` — ejemplos anonimizados de alertas bancarias; nunca correos reales.
- `docs` — alcance y decisiones de arquitectura.

Las decisiones acordadas para V1 están en [docs/v1-decisions.md](docs/v1-decisions.md).
La configuracion unica de reenvio esta en [docs/gmail-forwarding.md](docs/gmail-forwarding.md).
La automatizacion de Apple Pay esta en [docs/apple-pay-shortcut.md](docs/apple-pay-shortcut.md).

## Entregas

Los cambios llegan por pull request a `main`. GitHub Actions ejecuta tests, chequeos de tipos, build y síntesis de CDK para cada PR. Tras el merge, el mismo flujo se autentica con AWS mediante OIDC y despliega `PersonalFinanceV1`; no usa claves AWS almacenadas en GitHub. El rol de GitHub sólo puede asumir los roles de bootstrap de CDK y sólo desde `main` de este repositorio.
