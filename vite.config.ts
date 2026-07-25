import { defineConfig } from 'vite';

// pdfjs-dist ships an ESM build that works client-side. We copy its cmaps into
// the bundle via ?url imports where needed (see src/pdf/parse.ts).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  optimizeDeps: {
    include: ['pdfjs-dist'],
  },
});
