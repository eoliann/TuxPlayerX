import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { Features } from 'lightningcss';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  // TAURI_ENV_PLATFORM tells the frontend which app to load (desktop or Android).
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  server: {
    port: 3000,
    strictPort: true,
    // Only this computer; Android device development sets TAURI_DEV_HOST to the LAN address.
    host: process.env.TAURI_DEV_HOST || 'localhost',
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  // Tailwind 4 writes colors as oklch() and color-mix(), which older Android System WebViews (common on
  // Android TV boxes and emulators) do not understand, leaving backgrounds transparent. Lightning CSS rewrites
  // them to plain rgb() for these browsers.
  css: {
    transformer: 'lightningcss',
    lightningcss: {
      targets: { chrome: 87 << 16, safari: 14 << 16 },
      include: Features.Colors,
    },
  },
  build: {
    cssMinify: 'lightningcss',
    rollupOptions: {
      input: {
        main: resolve(projectRoot, 'index.html'),
        pip: resolve(projectRoot, 'pip.html'),
      },
    },
  },
});
