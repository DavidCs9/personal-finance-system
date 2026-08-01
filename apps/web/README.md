# Web UI

SPA de revisión personal para los eventos observados. Por ahora usa únicamente datos ficticios locales y no requiere autenticación ni backend.

## Ejecutar

Desde la raíz del monorepo, instala dependencias y levanta la aplicación:

```bash
npm install
npm --workspace @finance/web run dev
```

Después abre la URL que imprima Vite, normalmente `http://localhost:5173`.

## Scripts

- `npm --workspace @finance/web run dev`: servidor local de Vite.
- `npm --workspace @finance/web run check`: validación de tipos.
- `npm --workspace @finance/web run build`: validación de tipos y build de producción.
- `npm --workspace @finance/web run preview`: previsualiza el build.

## Conexión futura

La única frontera de datos es [`src/api/client.ts`](src/api/client.ts). Al implementar API Gateway/Cognito, sustituye `mockApi` por el cliente HTTP autenticado; los componentes no deben llamar `fetch` directamente.

Los ejemplos están en [`src/api/mock-data.ts`](src/api/mock-data.ts) y son completamente ficticios.
