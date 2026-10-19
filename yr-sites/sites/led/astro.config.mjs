import { defineConfig } from 'astro/config';
export default defineConfig({
  site: process.env.SITE_URL || 'https://led.example.com',
  trailingSlash: 'always',
  outDir: process.env.OUT_DIR || './dist',
  build: { format: 'directory' },
  vite: { server: { fs: { allow: ['../..'] } } },
});
