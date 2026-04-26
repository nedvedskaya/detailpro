import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config для SaaS-CRM фронта.
 *
 * dev:
 *   - порт 5173 (стандартный vite-дефолт)
 *   - proxy /api → http://127.0.0.1:3000 (наш бэкенд server.cjs)
 *   - cookie-сессии работают через proxy без extra-телодвижений
 *     (changeOrigin=true, бэк в .env.example уже настроен на Domain без секции для dev)
 *
 * build:
 *   - вывод в client/dist; сервер будет отдавать оттуда статику
 *     через app.cjs SPA-fallback
 *   - drop_console=true — на проде не светим логи в DevTools
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        // sessions cookie HttpOnly: браузер сам прокинет, но vite по умолчанию
        // ставит origin к target — для dev этого хватает.
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,
        drop_debugger: true,
      },
    },
    rollupOptions: {
      output: {
        manualChunks: {
          'ui-vendor': ['lucide-react'],
          'chart-vendor': ['recharts'],
        },
      },
    },
    chunkSizeWarningLimit: 1000,
    cssCodeSplit: true,
    sourcemap: false,
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'lucide-react'],
  },
});
