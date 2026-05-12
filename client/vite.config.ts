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
    // Не удаляем старые hashed assets при новой сборке.
    // Это важно для Яндекс.Вебвизора и браузеров со старым HTML в кеше:
    // записи/страницы могут ссылаться на CSS/JS предыдущих сборок.
    emptyOutDir: false,
    // target: явно перечисляем минимальные версии движков, которые мы
    // обещаем поддерживать. Базис «последние 3 года» (с апреля 2023):
    //   Chrome 109 / Edge 109 — январь 2023
    //   Safari 16.3            — январь 2023 (iOS 16.3)
    //   Firefox 109            — январь 2023
    // Все четыре поддерживают полный ES2022 (top-level await, class fields,
    // .at(), Object.hasOwn, error.cause), поэтому esbuild не транспилирует
    // эти фичи в downlevel-полифилы — бандл получается компактнее, JS
    // парсится быстрее. iOS 15 и более старые Android-Chrome обновляются
    // через системный WebView; устройства старше 3 лет (iPhone 7 на iOS 15
    // и т.п.) уйдут на «упрощённый режим» с возможной ошибкой парсинга —
    // это сознательный trade-off: лучше явный fail, чем тащить полифилы
    // ради ~1% старых устройств.
    target: ['chrome109', 'edge109', 'safari16', 'firefox109'],
    // Не вставляем в HTML автоматические <link rel="modulepreload"> для
    // зависимых чанков. На нестабильных VPN/провайдерах это уменьшает
    // стартовую пачку запросов: CRM сначала загружает основной интерфейс,
    // а тяжёлые разделы подтягиваются только при открытии.
    modulePreload: false,
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,
        drop_debugger: true,
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
