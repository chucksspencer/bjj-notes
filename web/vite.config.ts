import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const server = process.env.BJJ_API ?? 'http://localhost:8080';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: '../dist/public',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    // In development the API runs separately (npm run dev); same paths as production.
    proxy: Object.fromEntries(['/api', '/mcp', '/oauth', '/healthz'].map(p => [p, { target: server, changeOrigin: false }])),
  },
});
