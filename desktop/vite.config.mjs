import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    target: 'chrome130',
    cssMinify: 'lightningcss',
    assetsInlineLimit: 0,
    reportCompressedSize: false,
  },
});
