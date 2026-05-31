import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const BACKEND = `http://localhost:${process.env.PBALL_PORT ?? 8787}`;

export default defineConfig({
  root: 'web',
  plugins: [svelte()],
  build: { outDir: '../static', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: false },
      '/events': { target: BACKEND, changeOrigin: false, ws: false },
    },
  },
});
