import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    emptyOutDir: false,
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, 'src/content/api-hook/main-world-entry.ts'),
      name: 'XgenPathfinderCaptureMain',
      formats: ['iife'],
      fileName: () => 'pathfinder-capture-main.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
