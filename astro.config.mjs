// @ts-check
import { defineConfig, passthroughImageService } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  trailingSlash: 'always',
  image: {
    service: passthroughImageService(),
  },
  vite: {
    plugins: [tailwindcss()],
    server: {
      proxy: {
        // Proxy API routes to a locally running Wrangler dev server.
        // Run `npm run dev:worker` in a separate terminal to start the Worker.
        '/api': {
          target: 'http://localhost:8787',
          changeOrigin: true,
        },
        '/download-stream': {
          target: 'http://localhost:8787',
          changeOrigin: true,
        },
        '/watch': {
          target: 'http://localhost:8787',
          changeOrigin: true,
        },
      },
    },
  },
});