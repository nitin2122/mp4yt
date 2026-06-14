/**
 * api/proxy.js
 *
 * Download Proxy — mp4yt.com
 *
 * Streams a remote video file through our serverless function with
 * Content-Disposition: attachment so the browser triggers a real file
 * download dialog. This is necessary because the HTML `download` attribute
 * is blocked by browsers for cross-origin URLs (yt-dlp CDN domains).
 *
 * Query params:
 *   url      — the direct CDN stream URL (from /api/extract response)
 *   filename — desired filename for the download (e.g. "my-video.mp4")
 */

import https from 'https';
import http from 'http';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range',
};

/**
 * Validate that a URL is safe to proxy (HTTP/HTTPS, no private ranges).
 */
function validateProxyUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  let parsed;
  try { parsed = new URL(rawUrl.trim()); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const h = parsed.hostname;
  const private_ = [
    /^localhost$/i, /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\.0\.0\.0$/,
  ];
  return !private_.some(r => r.test(h));
}

/**
 * Sanitize filename for Content-Disposition header.
 */
function safeFilename(raw) {
  if (!raw) return 'video.mp4';
  return raw.replace(/[^\w.\-]/g, '_').slice(0, 200) || 'video.mp4';
}

export default async function handler(req, res) {
  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const rawUrl = req.query?.url ?? '';
  const filename = safeFilename(req.query?.filename ?? 'video.mp4');

  if (!validateProxyUrl(rawUrl)) {
    res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or unsafe URL.' }));
    return;
  }

  const targetUrl = rawUrl.trim();

  try {
    await streamDownload(targetUrl, filename, req, res);
  } catch (err) {
    console.error('[proxy] Stream error:', err?.message ?? err);
    if (!res.headersSent) {
      res.writeHead(502, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to stream video. The URL may have expired.' }));
    }
  }
}

/**
 * Stream the remote URL to the client response, following redirects.
 */
function streamDownload(url, filename, req, res, redirectDepth = 0) {
  if (redirectDepth > 5) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many redirects.' }));
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    // Forward Range header if client sends it (for partial content / seek support)
    const forwardHeaders = {};
    if (req.headers['range']) {
      forwardHeaders['Range'] = req.headers['range'];
    }

    const request = protocol.get(url, { headers: forwardHeaders }, (upstream) => {
      const status = upstream.statusCode;

      // Follow redirects
      if (status >= 300 && status < 400 && upstream.headers.location) {
        upstream.resume(); // Drain to free socket
        streamDownload(upstream.headers.location, filename, req, res, redirectDepth + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (status !== 200 && status !== 206) {
        upstream.resume();
        reject(new Error(`Upstream returned HTTP ${status}`));
        return;
      }

      // Build response headers
      const responseHeaders = {
        ...CORS,
        'Content-Type': upstream.headers['content-type'] || 'video/mp4',
        'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes',
      };

      if (upstream.headers['content-length']) {
        responseHeaders['Content-Length'] = upstream.headers['content-length'];
      }
      if (upstream.headers['content-range']) {
        responseHeaders['Content-Range'] = upstream.headers['content-range'];
      }

      res.writeHead(status === 206 ? 206 : 200, responseHeaders);
      upstream.pipe(res);

      upstream.on('end', resolve);
      upstream.on('error', reject);
      res.on('close', () => {
        // Client disconnected early — destroy upstream to free resources
        if (!upstream.destroyed) upstream.destroy();
        resolve();
      });
    });

    request.on('error', reject);
    request.setTimeout(25000, () => {
      request.destroy();
      reject(new Error('Upstream connection timed out.'));
    });
  });
}
