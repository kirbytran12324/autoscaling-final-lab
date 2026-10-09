import {defineConfig} from 'vitest/config';
import react from '@vitejs/plugin-react';
import type {Connect} from 'vite';

const replayPlayerPolicy: Connect.NextHandleFunction = (request, response, next) => {
  if (request.url?.split('?')[0] === '/showdown/player.html') {
    response.setHeader('Content-Security-Policy',
      "frame-ancestors 'self'; sandbox allow-scripts; form-action 'none'");
  }
  if (request.url?.split('?')[0].startsWith('/showdown/vendor/style/')) {
    response.setHeader('Access-Control-Allow-Origin', '*');
  }
  next();
};

export default defineConfig({
  plugins: [react(), {
    name: 'replay-player-policy',
    configureServer(server) {
      server.middlewares.use(replayPlayerPolicy);
    },
    configurePreviewServer(server) {
      server.middlewares.use(replayPlayerPolicy);
    },
  }],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': process.env.VITE_API_TARGET || 'http://127.0.0.1:3001',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test-setup.ts',
    css: true,
  },
});
