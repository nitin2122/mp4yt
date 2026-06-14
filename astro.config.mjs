// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// Custom Vite plugin to run Vercel serverless functions locally
function localApiPlugin() {
  return {
    name: 'local-api-plugin',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const parsedUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
        const { pathname, searchParams } = parsedUrl;

        if (
          pathname === '/api/extract' ||
          pathname === '/api/proxy' ||
          pathname === '/download-stream' ||
          pathname === '/api/seo-handler' ||
          pathname === '/watch'
        ) {
          try {
            // Mock req.query for the serverless function (which expects express/vercel style req.query)
            // @ts-ignore
            req.query = Object.fromEntries(searchParams.entries());

            let handlerPath = '';
            if (pathname === '/api/extract') {
              handlerPath = './api/extract.js';
            } else if (pathname === '/api/proxy' || pathname === '/download-stream') {
              handlerPath = './api/proxy.js';
            } else {
              handlerPath = './api/seo-handler.js';
            }

            // Dynamically import the Vercel handler with a cache-buster for local development HMR
            const { default: handler } = await import(`${handlerPath}?t=${Date.now()}`);
            await handler(req, res);
          } catch (err) {
            console.error(`Error in local API route ${pathname}:`, err);
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message || 'Internal Server Error' }));
            }
          }
          return;
        }

        next();
      });
    }
  };
}

// https://astro.build/config
export default defineConfig({
  vite: {
    plugins: [tailwindcss(), localApiPlugin()],
  },
});


