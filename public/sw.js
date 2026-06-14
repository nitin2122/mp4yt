/**
 * public/sw.js
 *
 * Hybrid Client-Side Stream Downloader (Service Worker)
 *
 * Intercepts requests to `/download-stream?url=<remote_url>&filename=<name>`
 * and streams the remote URL directly to the browser's download manager using
 * standard streams. This bypasses Vercel serverless timeouts completely, requires
 * zero server CPU/bandwidth, and provides standard browser progress indicators.
 *
 * If the remote URL does not support CORS (e.g. some platforms), the service worker
 * catches the fetch error and redirects the browser to `/api/proxy?url=...` which
 * falls back to our serverless Node.js proxy.
 */

self.addEventListener('install', (event) => {
  // Force immediate activation
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Claim all client pages immediately on activation
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only intercept GET requests directed at /download-stream
  if (event.request.method === 'GET' && url.pathname === '/download-stream') {
    const targetUrl = url.searchParams.get('url');
    const filename = url.searchParams.get('filename') || 'video.mp4';
    const audioUrl = url.searchParams.get('audioUrl');

    // If an audioUrl is present, server-side FFmpeg merging is required. Bypass SW.
    if (audioUrl) return;

    if (!targetUrl) return;

    event.respondWith((async () => {
      try {
        console.log(`[sw] Intercepted download for: ${filename}. Direct streaming from CDN…`);

        // Perform client-side fetch. YouTube CDN supports CORS, so this will succeed.
        const response = await fetch(targetUrl, {
          mode: 'cors',
          credentials: 'omit' // Omit credentials to avoid origin mismatch issues
        });

        if (!response.ok) {
          throw new Error(`Upstream returned HTTP ${response.status}`);
        }

        // Clone headers and inject attachment headers to force a browser download
        const responseHeaders = new Headers(response.headers);
        
        // Construct the Content-Disposition header
        const safeFilename = filename.replace(/[^\w.\-]/g, '_').slice(0, 200) || 'video.mp4';
        responseHeaders.set(
          'Content-Disposition',
          `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`
        );
        
        // Force octet-stream to ensure the browser saves it rather than playing it inline
        responseHeaders.set('Content-Type', 'application/octet-stream');
        
        // Remove headers that might interfere with caching or CORS on client side
        responseHeaders.delete('Cache-Control');
        responseHeaders.set('Cache-Control', 'no-store, no-cache, must-revalidate');

        // Return the streamed response
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders
        });

      } catch (err) {
        console.warn(`[sw] Direct CDN stream failed (CORS or network). Redirecting to server-side proxy fallback... Error:`, err);
        
        // Fallback: Redirect browser to /api/proxy which handles downloading via serverless backend
        const fallbackUrl = `/api/proxy?url=${encodeURIComponent(targetUrl)}&filename=${encodeURIComponent(filename)}`;
        
        return Response.redirect(fallbackUrl, 302);
      }
    })());
  }
});
