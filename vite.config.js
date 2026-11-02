import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 产物目录刻意不叫 dist/build：部分部署平台会默认忽略 dist 这类构建目录，
  // 导致线上找不到 index.html。
  build: {
    outDir: 'web',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
