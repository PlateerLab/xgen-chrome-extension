import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    react(),
    crx({ manifest }),
  ],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      input: {
        // 데모 페이지 — sidepanel에서 chrome.tabs.create로 새 탭 오픈.
        // manifest에 등록 안 하고 web_accessible_resources로만 노출.
        demo: resolve(__dirname, 'src/demo/index.html'),
      },
    },
  },
});
