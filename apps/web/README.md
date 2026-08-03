# Web UI

SPA de Olbia: tablero personal de gasto mensual. En desarrollo puede usar la API real (Cognito) o un **modo mock** con datos locales.

## Ejecutar

Desde la raíz del monorepo:

```bash
npm install
npm --workspace @finance/web run dev
```

Abre la URL que imprima Vite, normalmente `http://localhost:5173`.

## Modo mock (solo DEV)

Para revisar Resumen y Movimientos sin autenticarte ni llamar a la API:

1. En la pantalla de login, pulsa **Usar datos de ejemplo**, o
2. Abre `http://localhost:5173/?demo=1`

El tablero queda fijado en julio 2026 con movimientos, MSI, gastos fijos, tarjetas y un correo por revisar. El topbar muestra el badge **Mock**; **Salir del mock** vuelve al login real.

Los fixtures viven en [`src/api/mock-data.ts`](src/api/mock-data.ts), [`src/monthly-plan.ts`](src/monthly-plan.ts) y [`src/card-cycle-demo.ts`](src/card-cycle-demo.ts). El mock no está disponible en builds de producción.

Los imports CSV / estado de cuenta siguen yendo a la API si los abres en mock; no están simulados de punta a punta.

## Scripts

- `npm --workspace @finance/web run dev`: servidor local de Vite.
- `npm --workspace @finance/web run check`: validación de tipos.
- `npm --workspace @finance/web run build`: validación de tipos y build de producción.
- `npm --workspace @finance/web run preview`: previsualiza el build.

## API

La frontera HTTP es [`src/api/client.ts`](src/api/client.ts). Los componentes no deben llamar `fetch` directamente.
