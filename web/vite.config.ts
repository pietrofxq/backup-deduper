import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const SERVER_PORT = Number(process.env.SAFE_DEDUPE_PORT ?? 7777);

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
