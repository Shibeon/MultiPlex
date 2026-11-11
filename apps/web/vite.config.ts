import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [preact()],
  // Chemins relatifs : le même build fonctionne en HTTP, en file:// (Electron)
  // et dans les paquets d'applications TV / mobiles.
  base: './',
  build: { target: 'es2019', sourcemap: false },
  server: { port: 5173, strictPort: false },
});
