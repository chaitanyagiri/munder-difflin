import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { hiveDataPlugin } from './plugin/hiveData';
import path from 'path';

export default defineConfig({
  plugins: [react(), hiveDataPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  server: {
    port: 3000,
    open: true
  }
});
