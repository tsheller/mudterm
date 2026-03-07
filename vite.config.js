import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    target: 'esnext',
    outDir: 'dist',
    assetsInlineLimit: 100000000, // Inline everything
    cssCodeSplit: false,
    rollupOptions: {
      treeshake: false,
      output: {
        inlineDynamicImports: true,
      }
    }
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    open: false,
    allowedHosts: true
  }
});
