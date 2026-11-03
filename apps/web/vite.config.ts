import { defineConfig } from 'vite';

// La web usa el código fuente de los paquetes del workspace (condición `development`) y la entrada
// de navegador del cliente (`browser`: WebSocket nativo, sin dependencias de Node).
export default defineConfig({
  resolve: { conditions: ['browser', 'development', 'module', 'import', 'default'] },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', assetsInlineLimit: 0 },
  server: {
    // En desarrollo (`pnpm --filter @arenal/web dev`) la API y el WebSocket van al servidor local.
    proxy: {
      '/v1': { target: 'http://localhost:8080', ws: true },
      '/health': 'http://localhost:8080',
    },
  },
});
