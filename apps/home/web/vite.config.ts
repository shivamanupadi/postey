import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-vite-plugin';
import path from 'path';

export default defineConfig({
  plugins: [react(), TanStackRouterVite()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    // Same convention as Traks: keep the site's hashed assets off /assets/*
    // so zone routes can split cleanly against the platform workers later.
    assetsDir: 'site-assets',
  },
  server: {
    port: 6013,
    proxy: {
      '/api': { target: 'http://localhost:6014', changeOrigin: true },
    },
  },
});
