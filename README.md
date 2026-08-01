# Personal Finance System

Un ledger personal que observa eventos financieros desde alertas por correo, sin acceder a credenciales bancarias.

## Estado

El repositorio contiene el esqueleto inicial de V1. Aún no se ha creado infraestructura ni se ha conectado a Gmail o AWS.

## Estructura

- `apps/web` — UI de revisión personal.
- `infrastructure` — aplicación CDK para los recursos de AWS.
- `packages/domain` — tipos y reglas de dominio compartidos.
- `services/api` — handlers de la API para la UI.
- `services/ingestion` — descubrimiento de Gmail, persistencia y parsing de compras.
- `tests/fixtures/email` — ejemplos anonimizados de alertas bancarias; nunca correos reales.
- `docs` — alcance y decisiones de arquitectura.

Las decisiones acordadas para V1 están en [docs/v1-decisions.md](docs/v1-decisions.md).
