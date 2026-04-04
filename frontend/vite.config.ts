import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3003',
        changeOrigin: true,
      },
    },
  },
  preview: {
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'https://back-end-production-14be.up.railway.app',
        changeOrigin: true,
        secure: true,
      },
    },
  },
});
