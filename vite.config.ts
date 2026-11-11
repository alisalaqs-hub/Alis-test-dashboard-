import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The site has clean page addresses (/property/…, /sold-prices/leeds), so assets load from the root.
// "Portable" builds can be opened from any folder: `npm run build:single` (one self-contained HTML file)
// and the optional GitHub Pages demo (VITE_PORTABLE=1). They keep relative asset paths and #/ addresses.
export default defineConfig(({ mode }) => {
  const portable = mode === 'single' || process.env.VITE_PORTABLE === '1';
  return {
    base: portable ? './' : '/',
    plugins: [react(), ...(mode === 'single' ? [viteSingleFile()] : [])],
    build: { outDir: mode === 'single' ? 'dist-single' : 'dist' },
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
  };
});
