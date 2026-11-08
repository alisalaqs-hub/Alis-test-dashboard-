import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build:single` emits one self-contained HTML file (handy for demos/sharing).
export default defineConfig(({ mode }) => ({
  // Relative base so the site works at any path (GitHub Pages project URL, custom domain, Netlify, Vercel).
  base: './',
  plugins: [react(), ...(mode === 'single' ? [viteSingleFile()] : [])],
  build: { outDir: mode === 'single' ? 'dist-single' : 'dist' },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
}));
