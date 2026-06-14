/**
 * worker.js
 *
 * Cloudflare Worker Reverse Proxy & Asset Server
 *
 * Intercepts requests for mp4yt.com on Cloudflare:
 * 1. Routes `/api/*`, `/download-stream`, and `/watch` to the Vercel backend (running Node.js with yt-dlp/ffmpeg binaries).
 * 2. Serves all static pages, assets (CSS, JS, images, favicon) from Cloudflare's global edge network.
 * 3. Provides clean 404 fallback routing using Astro's compiled 404 page.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Define target paths that require backend execution (yt-dlp / ffmpeg)
    // We only route to Vercel's proxy for downloads that require merging video + audio (contains audioUrl).
    const isBackendRoute =
      pathname === '/api/extract' ||
      pathname === '/api/proxy' ||
      (pathname === '/download-stream' && url.searchParams.has('audioUrl')) ||
      pathname.startsWith('/api/') ||
      pathname === '/watch';

    // Intercept progressive streaming downloads directly on Cloudflare Edge to bypass Vercel execution limits
    if (pathname === '/download-stream' && !url.searchParams.has('audioUrl')) {
      const targetUrl = url.searchParams.get('url');
      const filename = url.searchParams.get('filename') || 'video.mp4';

      if (!targetUrl) {
        return new Response(JSON.stringify({ error: 'Missing target URL parameter.' }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      // Clone client range header for partial content streaming (resuming and seeking)
      const requestHeaders = new Headers();
      const rangeHeader = request.headers.get('range');
      if (rangeHeader) {
        requestHeaders.set('range', rangeHeader);
      }

      try {
        const upstreamResponse = await fetch(targetUrl, {
          headers: requestHeaders,
        });

        // Set attachment headers and allow cross-origin resource sharing
        const responseHeaders = new Headers(upstreamResponse.headers);
        responseHeaders.set('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Cache-Control', 'no-store');

        return new Response(upstreamResponse.body, {
          status: upstreamResponse.status,
          statusText: upstreamResponse.statusText,
          headers: responseHeaders,
        });
      } catch (err) {
        console.error('[Worker Proxy] Failed to proxy stream directly:', err);
        return new Response(JSON.stringify({
          error: 'Failed to stream download from provider CDN.',
          details: err.message
        }), {
          status: 502,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
    }

    if (isBackendRoute) {
      // 1. Determine target backend URL
      const backendHost = env.BACKEND_API_HOST || 'mp4yt.vercel.app';
      const targetUrl = new URL(request.url);
      targetUrl.host = backendHost;
      targetUrl.port = '';
      targetUrl.protocol = 'https:';

      // 2. Clone headers and override Host to match the target Vercel domain
      // Vercel routes incoming requests strictly based on the HTTP Host header.
      const proxyHeaders = new Headers(request.headers);
      proxyHeaders.set('host', backendHost);

      // Pass along client IP information using standard headers
      const clientIP = request.headers.get('cf-connecting-ip');
      if (clientIP) {
        proxyHeaders.set('x-forwarded-for', clientIP);
        proxyHeaders.set('x-real-ip', clientIP);
      }

      // 3. Construct the proxy request
      // We set redirect to 'manual' so that 302 Redirect responses (e.g. from /watch for humans)
      // are returned straight to the client browser rather than being followed by the Worker.
      const proxyRequest = new Request(targetUrl.toString(), {
        method: request.method,
        headers: proxyHeaders,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
        redirect: 'manual',
      });

      console.log(`[Worker] Proxying ${pathname} request to: ${targetUrl.toString()}`);

      try {
        const response = await fetch(proxyRequest);

        // Standard CORS handling for API requests
        const responseHeaders = new Headers(response.headers);
        responseHeaders.set('Access-Control-Allow-Origin', '*');

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        });
      } catch (err) {
        console.error(`[Worker] Failed to proxy backend request for ${pathname}:`, err);
        return new Response(
          JSON.stringify({
            error: 'Backend API is temporarily unavailable.',
            details: err.message,
          }),
          {
            status: 502,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
          }
        );
      }
    }

    // Serve static files from Cloudflare's Assets storage
    try {
      const response = await env.ASSETS.fetch(request);

      // Astro builds clean directories, but in case a genuine 404 is encountered,
      // load the custom built 404.html page from the static bundle.
      if (response.status === 404) {
        console.log(`[Worker] Asset 404 on ${pathname}, fetching static /404.html fallback`);
        const notFoundRequest = new Request(new URL('/404.html', request.url));
        const notFoundResponse = await env.ASSETS.fetch(notFoundRequest);
        
        if (notFoundResponse.status === 200) {
          return new Response(notFoundResponse.body, {
            status: 404,
            headers: notFoundResponse.headers,
          });
        }
      }

      return response;
    } catch (err) {
      console.error(`[Worker] Error fetching asset from ASSETS binding:`, err);
      return new Response(`Error loading asset: ${err.message}`, { status: 500 });
    }
  },
};
