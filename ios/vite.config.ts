import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],

  define: {
    __TAURI_MOBILE__: true,
  },

  resolve: {
    alias: {
      // All source imports resolve to the shared web/src directory
      '@': path.resolve(__dirname, '../web/src'),
      // Tauri packages are in ios/node_modules, but source files live in web/src/
      '@tauri-apps/plugin-store': path.resolve(__dirname, 'node_modules/@tauri-apps/plugin-store'),
      '@tauri-apps/plugin-notification': path.resolve(__dirname, 'node_modules/@tauri-apps/plugin-notification'),
      '@tauri-apps/plugin-shell': path.resolve(__dirname, 'node_modules/@tauri-apps/plugin-shell'),
      '@tauri-apps/api': path.resolve(__dirname, 'node_modules/@tauri-apps/api'),
    },
  },

  // Prevent vite from obscuring Rust errors
  clearScreen: false,

  server: {
    port: 1440,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1441,
        }
      : undefined,
    watch: {
      // Watch the shared web source too
      ignored: ['!**/web/src/**'],
    },
  },
});
