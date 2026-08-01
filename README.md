# Personal Finance System

Un ledger personal que observa eventos financieros desde alertas por correo, sin acceder a credenciales bancarias.

## Estado

La V1 recibe correos reenviados a través de Amazon SES y conserva el MIME original en S3 antes de procesarlo.

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
