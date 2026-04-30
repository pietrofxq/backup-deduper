import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Match the Fastify boot in `src/main.ts`, which reads `PORT` (default 7777).
// `SAFE_DEDUPE_PORT` is kept as a fallback for anyone who set it before this
// alignment — `PORT` wins so changing one variable in `.env` keeps the dev
// proxy and the backend pointed at the same port.
const SERVER_PORT = Number(process.env.PORT ?? process.env.SAFE_DEDUPE_PORT ?? 7777);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // The Fastify backend lives on its own port; in dev we proxy /api/*
    // requests to it so the SPA can use same-origin URLs in code. CORS is
    // configured on the server too, but the proxy is preferred for dev
    // because it keeps cookies/headers stable and matches production wiring.
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${SERVER_PORT}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    emptyOutDir: true,
  },
});
