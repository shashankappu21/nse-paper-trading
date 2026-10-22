import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.VITE_DEV_API ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Consume the shared package from source so types and zod schemas are shared with the API.
    alias: { '@nse/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) },
  },
  server: {
    port: 5173,
    // Same-origin in dev: no CORS, and the WebSocket goes through the same proxy.
    proxy: {
      '/api': api,
      '/health': api,
      '/ws': { target: api.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { sourcemap: true, chunkSizeWarningLimit: 700 },
});
