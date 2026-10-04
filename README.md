# Olbia

**David Castro's private application for controlling his overall financial situation. David is its sole user and owner.**

Olbia brings together income, spending, liquidity, commitments, investments, debt and net worth. Email alerts, Apple Pay and imports preserve original evidence; corrections and reconciliation remain auditable. It never asks for bank credentials. The code is public as a technical sample; the application and financial data are private.

## What to read

Start with the product north star, then read only what your task needs:

| Task | Document |
| --- | --- |
| Understand purpose and binding decisions | [Product north star](docs/product-north-star.md) |
| Change a screen, message or report layout | [UI direction](docs/ui-design-brief.md) |
| Change calculations, imports or financial behavior | [Financial rules](docs/financial-rules.md) |
| Change data, persistence or service boundaries | [Architecture](docs/architecture.md) |
| Configure integrations, diagnose, deliver or recover | [Operations](docs/operations.md) |
| Change assistant tools, memory or runtime prompt | [Assistant](docs/ai-assistant.md) |

[AGENTS.md](AGENTS.md) defines working instructions. Completed migration plans, audits and run records are available through Git history; they are not current operating guidance. `docs/` contains only these six documents. Add a section to the existing guide before proposing another file.

## Develop

Node.js 24+, npm workspaces, strict TypeScript and Vitest:

```sh
npm ci
npm --workspace @finance/web run dev
npm test
npm run check
npm run synth
```

The [web README](apps/web/README.md) explains local login/demo mode. The [architecture map](docs/architecture.md#where-changes-belong) locates each service and schema.

Production code ships by PR, required quality check, linear merge and the deploy-production GitHub Actions job. No local deployment. Aurora DSQL owns every product domain; native financial history and S3 originals remain intact, native backups protect current finances, and retained DynamoDB provides pre-cutover recovery. DSQL contains no migration-copy tables.
