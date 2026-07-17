/**
 * worker.js
 *
 * Cloudflare Worker Backend & Asset Server
 *
 * Intercepts requests for mp4yt.com on Cloudflare:
 * 1. Routes `/api/*`, `/download-stream`, and `/watch` internally.
 * 2. Serves all static pages, assets (CSS, JS, images, favicon) from Cloudflare's global edge network.
 * 3. Provides clean 404 fallback routing using Astro's compiled 404 page.
 *
 * Download Engine: Multi-instance Cobalt failover with 144p–4K support.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range',
  'Cache-Control': 'no-store, no-cache, must-revalidate'
};

// ── Security Response Headers ──────────────────────────────
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://www.google-analytics.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://img.youtube.com https://*.ytimg.com https://*.ggpht.com https://*.cdninstagram.com",
    "connect-src 'self' https://www.google-analytics.com https://www.googletagmanager.com https://analytics.google.com https://stats.g.doubleclick.net",
    "worker-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join('; '),
};

/**
 * Injects security headers into any Response.
 * Clones the response to make headers mutable.
 */
function withSecurityHeaders(response) {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

// ── Community Cobalt instances — verified open (no Turnstile/JWT) ──
// Only instances that accept unauthenticated POST requests are listed.
// Source: https://cobalt.directory/ (verified 2026-06-30)
const COMMUNITY_COBALT_INSTANCES = [
  'https://api.cobalt.blackcat.sweeux.org/',// v11.7 — open, no auth
  'https://dog.kittycat.boo/',             // v11.7 — open, no auth
  'https://fox.kittycat.boo/',             // v11.7 — open, no auth
  'https://cobaltapi.kittycat.boo/',       // v11.7 — open, no auth
  'https://api.cobalt.liubquanti.click/',  // v11.7 — open, no auth
  'https://rue-cobalt.xenon.zone/',        // v11.7 — open, no auth
  'https://cobaltapi.cjs.nz/',             // v11.5 — open, no auth
];

// Per-request timeout for Cobalt API calls (ms)
const COBALT_TIMEOUT_MS = 12000;

// Error codes that mean "skip this instance immediately" (auth-gated)
const SKIP_ERROR_CODES = new Set([
  'error.api.auth.jwt.missing',
  'error.api.auth.jwt.invalid',
  'error.api.auth.turnstile.missing',
  'error.api.auth.turnstile.invalid',
  'error.api.auth.key.invalid',
  'error.api.auth.key.ip_not_allowed',
]);

const BOT_USER_AGENT_REGEX = /\b(Twitterbot|facebookexternalhit|Facebook(Catalog|Bot)|Discordbot|WhatsApp|TelegramBot|Slackbot(-LinkExpanding)?|Slack-ImgProxy|LinkedInBot|Pinterest(bot)?|Mastodon|Threads|SnapchatBot|Line(-NewsDigest)?|Googlebot|Google-InspectionTool|Google-Extended|bingbot|msnbot|YahooSeeker|DuckDuckBot|Baiduspider|YandexBot|Sogou(Spider)?|Exabot|AhrefsBot|SemrushBot|MJ12bot|DotBot|GPTBot|Claude-Web|anthropic-ai|PerplexityBot|CCBot|cohere-ai|Embedly|Iframely|unfurl|Rogerbot|UptimeRobot|Pingdom(Bot)?|StatusCake|HeadlessChrome|PhantomJS|Prerender|facebot|ia_archiver|scrapy|python-requests|wget|curl)\b/i;

function validateUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname;
    if (!hostname) return false;

    const privatePatterns = [
      /^localhost$/i, /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
      /^0\.0\.0\.0$/, /^::1$/, /^fd[0-9a-f]{2}:/i, /^fe80:/i
    ];
    return !privatePatterns.some(pattern => pattern.test(hostname));
  } catch (e) {
    return false;
  }
}

function getYoutubeVideoId(url) {
  try {
    const match = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
    return match ? match[1] : null;
  } catch (e) {
    return null;
  }
}

function escapeHtml(val) {
  if (!val) return "";
  return val.toString()
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
}

async function getPageMetadata(targetUrl) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500); // 3.5 seconds timeout
    const resp = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!resp.ok) return {};
    const html = await resp.text();

    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const ogTitleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                        html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:title["']/i);
                        
    const ogImageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
                        html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i);

    const ogDescMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i) ||
                       html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i);

    const title = (ogTitleMatch ? ogTitleMatch[1] : (titleMatch ? titleMatch[1] : '')).trim();
    const thumbnail = ogImageMatch ? ogImageMatch[1].trim() : '';
    const desc = ogDescMatch ? ogDescMatch[1].trim() : '';

    return { title, thumbnail, desc };
  } catch (e) {
    return {};
  }
}

function humanizeError(errorCode, targetUrl) {
  const isYouTube = /youtu\.?be/i.test(targetUrl);
  const errorMap = {
    'error.api.youtube.login': isYouTube
      ? 'YouTube requires authentication. The server needs valid cookies configured.'
      : 'Authentication required for this platform.',
    'error.api.youtube.api_error': 'YouTube API returned an error. Cookies may have expired — re-export fresh cookies.',
    'error.api.youtube.decipher': 'YouTube changed its player. Try again in a few hours.',
    'error.api.youtube.token_expired': 'YouTube session token expired. Re-export fresh cookies.',
    'error.api.rate_exceeded': 'Rate limit reached. Please wait a moment and try again.',
    'error.api.content.video.unavailable': 'This video is unavailable, private, or region-locked.',
    'error.api.content.video.age': 'This video is age-restricted. Authenticated cookies are needed.',
    'error.api.content.video.live': 'Live streams cannot be downloaded. Wait until the stream ends.',
    'error.api.link.unsupported': 'This URL is not supported. Check if the link is valid.',
    'error.api.fetch.fail': 'Could not reach the video platform. The URL may be broken or expired.',
    'error.api.fetch.rate': 'The platform rate-limited the request. Try again in a minute.',
    'error.api.fetch.critical': 'A critical fetch error occurred. The platform may be blocking requests.',
    'error.api.fetch.empty': 'The platform returned an empty response. Try a different instance or URL.',
    'error.api.auth.key.ip_not_allowed': 'This Cobalt instance requires API key authentication.',
    'error.api.auth.jwt.missing': null,       // Auth-gated — silently skip
    'error.api.auth.jwt.invalid': null,        // Auth-gated — silently skip
    'error.api.auth.turnstile.missing': null,   // Auth-gated — silently skip
    'error.api.auth.turnstile.invalid': null,   // Auth-gated — silently skip
  };
  return errorMap[errorCode] || null;
}

/**
 * Build the ordered list of Cobalt API instances to try.
 * Primary (self-hosted) first, then community fallbacks.
 */
function buildInstanceList(env) {
  const instances = [];

  // 1. Primary: user's self-hosted instance (from env var)
  const primary = env.COBALT_API_URL;
  if (primary && typeof primary === 'string' && primary.trim()) {
    instances.push(primary.trim());
  }

  // 2. Fallbacks from env var (comma-separated)
  const fallbackStr = env.COBALT_FALLBACK_INSTANCES;
  if (fallbackStr && typeof fallbackStr === 'string') {
    const fallbacks = fallbackStr.split(',').map(s => s.trim()).filter(Boolean);
    for (const fb of fallbacks) {
      if (!instances.includes(fb)) instances.push(fb);
    }
  }

  // 3. Hardcoded community instances (deduplicated)
  for (const inst of COMMUNITY_COBALT_INSTANCES) {
    if (!instances.includes(inst)) instances.push(inst);
  }

  return instances;
}

/**
 * Call a single Cobalt instance with timeout.
 * Returns the parsed JSON response on success.
 * Throws on any error (HTTP error, processing error, timeout).
 */
async function callCobalt(targetUrl, quality, mode, cobaltApiUrl) {
  const cobaltEndpoint = cobaltApiUrl.endsWith('/') ? cobaltApiUrl : `${cobaltApiUrl}/`;
  
  const body = {
    url: targetUrl,
    downloadMode: mode,
    youtubeVideoCodec: 'h264',  // broad device compatibility
  };
  
  if (mode === 'audio') {
    body.audioFormat = quality === 'best' ? 'mp3' : quality;
  } else {
    body.videoQuality = quality === 'best' ? 'max' : quality;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), COBALT_TIMEOUT_MS);

  try {
    const response = await fetch(cobaltEndpoint, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorCode = errorData.error?.code || '';
      // If auth-gated, throw a special skipable error
      if (SKIP_ERROR_CODES.has(errorCode)) {
        const err = new Error(`Instance requires authentication (${errorCode})`);
        err.skipInstance = true;
        throw err;
      }
      const friendlyMsg = humanizeError(errorCode, targetUrl);
      throw new Error(friendlyMsg || `Cobalt API responded with status ${response.status}`);
    }

    const data = await response.json();

    if (data.status === 'error') {
      const errorCode = data.error?.code || '';
      if (SKIP_ERROR_CODES.has(errorCode)) {
        const err = new Error(`Instance requires authentication (${errorCode})`);
        err.skipInstance = true;
        throw err;
      }
      const friendlyMsg = humanizeError(errorCode, targetUrl);
      throw new Error(friendlyMsg || 'Cobalt returned processing error');
    }

    return data;
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      throw new Error(`Cobalt instance timed out after ${COBALT_TIMEOUT_MS / 1000}s`);
    }
    throw e;
  }
}

/**
 * Try calling Cobalt across multiple instances with automatic failover.
 * Returns the first successful result.
 * Throws the last error if all instances fail.
 */
async function callCobaltWithFailover(targetUrl, quality, mode, instances) {
  let lastError = null;
  
  for (const apiUrl of instances) {
    try {
      const result = await callCobalt(targetUrl, quality, mode, apiUrl);
      // Log success for debugging (visible in Cloudflare Worker logs)
      console.log(`[Cobalt] ✓ ${quality} from ${new URL(apiUrl).hostname}`);
      return result;
    } catch (e) {
      // Don't count auth-gated skips as real errors for user-facing messages
      if (!e.skipInstance) {
        lastError = e;
      }
      console.warn(`[Cobalt] ✗ ${new URL(apiUrl).hostname} failed for ${quality}: ${e.message}${e.skipInstance ? ' (skipped)' : ''}`);
      continue; // try next instance
    }
  }

  throw lastError || new Error('All Cobalt instances failed. Please try again later.');
}

function buildOgHtml(title, thumbnail, description, videoUrl, siteUrl) {
  const safeTitle = escapeHtml(title || 'Video on mp4yt');
  const safeDesc = escapeHtml(description || `Watch and download "${title}" via mp4yt`);
  const safeThumbnail = escapeHtml(thumbnail || `${siteUrl}/og-default.png`);
  const safeOgUrl = escapeHtml(siteUrl);
  const safeVideoUrl = escapeHtml(videoUrl || '');

  const videoTag = safeVideoUrl ? `<meta property="og:video" content="${safeVideoUrl}" />\n  <meta property="og:video:type" content="video/mp4" />` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle} — mp4yt</title>
  <meta name="description" content="${safeDesc}" />
  <meta property="og:type" content="video.other" />
  <meta property="og:site_name" content="mp4yt" />
  <meta property="og:url" content="${safeOgUrl}" />
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDesc}" />
  <meta property="og:image" content="${safeThumbnail}" />
  <meta property="og:image:width" content="1280" />
  <meta property="og:image:height" content="720" />
  ${videoTag}
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:site" content="@mp4yt" />
  <meta name="twitter:title" content="${safeTitle}" />
  <meta name="twitter:description" content="${safeDesc}" />
  <meta name="twitter:image" content="${safeThumbnail}" />
  <meta name="robots" content="noindex, follow" />
</head>
<body style="font-family:system-ui,sans-serif;background:#fafafa;color:#171717;padding:40px;max-width:640px;margin:auto">
  <h1 style="font-size:24px;font-weight:600;letter-spacing:-0.5px;margin-bottom:12px">${safeTitle}</h1>
  ${safeThumbnail ? `<img src="${safeThumbnail}" alt="Thumbnail" style="width:100%;border-radius:8px;margin-bottom:16px" />` : ''}
  <p style="color:#4d4d4d;margin-bottom:24px">${safeDesc}</p>
  <a href="${siteUrl}/#url=${encodeURIComponent(videoUrl || '')}"
     style="display:inline-flex;align-items:center;gap:8px;background:#171717;color:#fff;padding:10px 20px;border-radius:100px;text-decoration:none;font-size:14px;font-weight:500">
    ↓ Download on mp4yt
  </a>
</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    // Build instance list from env + hardcoded fallbacks
    const cobaltInstances = buildInstanceList(env);

    // 1. Handle OPTIONS (CORS) for all backend API routes
    if (method === 'OPTIONS' && (pathname.startsWith('/api/') || pathname === '/download-stream')) {
      return withSecurityHeaders(new Response(null, { status: 204, headers: CORS }));
    }

    // 2. /api/extract — Multi-instance failover extraction engine
    if (pathname === '/api/extract') {
      if (method !== 'GET') {
        return withSecurityHeaders(new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405, headers: CORS }));
      }

      const targetUrl = (url.searchParams.get('url') || '').trim();
      if (!targetUrl || !validateUrl(targetUrl)) {
        return withSecurityHeaders(new Response(JSON.stringify({ error: 'Invalid or unsafe URL.' }), { status: 400, headers: CORS }));
      }

      try {
        const metadataPromise = getPageMetadata(targetUrl);

        // Extended quality range: 144p → 4K + Audio
        const formatsConfig = [
          { q: '2160', mode: 'auto', label: '2160p (4K)',  ext: 'mp4' },
          { q: '1440', mode: 'auto', label: '1440p (2K)',  ext: 'mp4' },
          { q: '1080', mode: 'auto', label: '1080p (FHD)', ext: 'mp4' },
          { q: '720',  mode: 'auto', label: '720p (HD)',   ext: 'mp4' },
          { q: '480',  mode: 'auto', label: '480p',        ext: 'mp4' },
          { q: '360',  mode: 'auto', label: '360p',        ext: 'mp4' },
          { q: '240',  mode: 'auto', label: '240p',        ext: 'mp4' },
          { q: '144',  mode: 'auto', label: '144p',        ext: 'mp4' },
          { q: 'best', mode: 'audio', label: 'Audio (MP3)', ext: 'mp3' }
        ];

        const cobaltPromises = formatsConfig.map(async (config) => {
          try {
            const resObj = await callCobaltWithFailover(targetUrl, config.q, config.mode, cobaltInstances);
            let streamUrl = '';
            let filename = '';

            if (resObj.status === 'redirect' || resObj.status === 'tunnel') {
              streamUrl = resObj.url;
              filename = resObj.filename || 'video.mp4';
            } else if (resObj.status === 'picker' && Array.isArray(resObj.picker) && resObj.picker.length > 0) {
              streamUrl = resObj.picker[0].url;
              filename = resObj.picker[0].filename || 'video.mp4';
            }

            if (streamUrl) {
              return {
                resolution: config.label,
                ext: config.ext,
                filesize: null,
                has_audio: config.mode === 'auto',
                url: streamUrl,
                audio_url: null,
                filename: filename
              };
            }
          } catch (e) {
            console.error(`[extract] All instances failed for quality ${config.label}:`, e.message);
            return { error: e.message };
          }
          return null;
        });

        const results = await Promise.all(cobaltPromises);
        const validFormats = results.filter(f => f !== null && !f.error);

        if (validFormats.length === 0) {
          const errors = results.filter(f => f && f.error).map(f => f.error);
          // Deduplicate error messages
          const uniqueErrors = [...new Set(errors)];
          const errorMsg = uniqueErrors.length > 0
            ? `Extraction failed: ${uniqueErrors[0]}`
            : 'Could not extract stream link from any instance. Try another URL or try again later.';
          return withSecurityHeaders(new Response(JSON.stringify({ error: errorMsg }), { status: 400, headers: CORS }));
        }

        // Deduplicate formats by URL (Cobalt may return same URL for similar qualities)
        const seenUrls = new Set();
        const uniqueFormats = [];
        for (const fmt of validFormats) {
          if (!seenUrls.has(fmt.url)) {
            seenUrls.add(fmt.url);
            uniqueFormats.push(fmt);
          }
        }

        const scrapedMeta = await metadataPromise;
        const defaultFormat = uniqueFormats[0];
        const defaultFilename = defaultFormat.filename;
        const filenameWithoutExt = defaultFilename.substring(0, defaultFilename.lastIndexOf('.')) || defaultFilename;
        const title = scrapedMeta.title || filenameWithoutExt || 'Video';

        let thumbnail = scrapedMeta.thumbnail;
        if (!thumbnail) {
          const ytId = getYoutubeVideoId(targetUrl);
          if (ytId) {
            thumbnail = `https://img.youtube.com/vi/${ytId}/maxresdefault.jpg`;
          } else {
            thumbnail = '/og-default.png';
          }
        }

        const payload = {
          title: title,
          duration: null,
          thumbnail: thumbnail,
          url: defaultFormat.url,
          filename: defaultFilename,
          extractor: 'cobalt-failover',
          webpage_url: targetUrl,
          formats: uniqueFormats
        };

        return withSecurityHeaders(new Response(JSON.stringify(payload), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }));
      } catch (e) {
        console.error('[extract] Extraction handler error:', e.message);
        return withSecurityHeaders(new Response(JSON.stringify({ error: `Internal extraction error: ${e.message}` }), { status: 500, headers: CORS }));
      }
    }

    // 3. /api/proxy and /download-stream
    if (pathname === '/api/proxy' || pathname === '/download-stream') {
      const targetUrl = url.searchParams.get('url');
      let filename = url.searchParams.get('filename') || 'video.mp4';
      filename = filename.replace(/[^\w.\-]/g, '_').slice(0, 200) || 'video.mp4';

      if (!targetUrl || !validateUrl(targetUrl)) {
        return withSecurityHeaders(new Response(JSON.stringify({ error: 'Invalid or unsafe URL.' }), { status: 400, headers: CORS }));
      }

      const requestHeaders = new Headers();
      const rangeHeader = request.headers.get('range');
      if (rangeHeader) {
        requestHeaders.set('range', rangeHeader);
      }

      try {
        const upstreamResponse = await fetch(targetUrl, {
          headers: requestHeaders,
          redirect: 'follow'
        });

        const responseHeaders = new Headers(upstreamResponse.headers);
        responseHeaders.set('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Cache-Control', 'no-store');

        return withSecurityHeaders(new Response(upstreamResponse.body, {
          status: upstreamResponse.status,
          statusText: upstreamResponse.statusText,
          headers: responseHeaders,
        }));
      } catch (err) {
        console.error('[Worker Proxy] Failed to stream download:', err);
        return withSecurityHeaders(new Response(JSON.stringify({ error: 'Failed to stream download from provider CDN.' }), { status: 502, headers: CORS }));
      }
    }

    // 4. /watch (SEO handler)
    if (pathname === '/watch') {
      const ua = request.headers.get('user-agent') || "";
      const isBot = BOT_USER_AGENT_REGEX.test(ua);

      const protocol = new URL(request.url).protocol;
      const host = new URL(request.url).host;
      const siteUrl = `${protocol}//${host}`;
      const queryUrl = (url.searchParams.get('url') || '').trim();

      if (!queryUrl || !validateUrl(queryUrl)) {
        if (isBot) {
          const html = buildOgHtml('mp4yt — Download Any Video Instantly', `${siteUrl}/og-default.png`, 'Download videos from YouTube, TikTok, Instagram and 1000+ platforms instantly.', '', siteUrl);
          return withSecurityHeaders(new Response(html, { status: 200, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=300' } }));
        } else {
          return Response.redirect(`${siteUrl}/`, 302);
        }
      }

      if (!isBot) {
        const redirectUrl = `${siteUrl}/#url=${encodeURIComponent(queryUrl)}`;
        return new Response(null, {
          status: 302,
          headers: {
            'Location': redirectUrl,
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache'
          }
        });
      }

      try {
        const [scrapedMeta, cobaltResult] = await Promise.all([
          getPageMetadata(queryUrl),
          callCobaltWithFailover(queryUrl, '720', 'auto', cobaltInstances).catch(() => null)
        ]);

        let streamUrl = '';
        let cobaltFilename = '';
        if (cobaltResult) {
          if (cobaltResult.status === 'redirect' || cobaltResult.status === 'tunnel') {
            streamUrl = cobaltResult.url;
            cobaltFilename = cobaltResult.filename || 'video.mp4';
          } else if (cobaltResult.status === 'picker' && Array.isArray(cobaltResult.picker) && cobaltResult.picker.length > 0) {
            streamUrl = cobaltResult.picker[0].url;
            cobaltFilename = cobaltResult.picker[0].filename || 'video.mp4';
          }
        }

        const filenameWithoutExt = cobaltFilename ? (cobaltFilename.substring(0, cobaltFilename.lastIndexOf('.')) || cobaltFilename) : '';
        const title = scrapedMeta.title || filenameWithoutExt || 'Video';
        const description = scrapedMeta.desc || `Watch and download "${title}" via mp4yt`;

        let thumbnail = scrapedMeta.thumbnail;
        if (!thumbnail) {
          const ytId = getYoutubeVideoId(queryUrl);
          if (ytId) {
            thumbnail = `https://img.youtube.com/vi/${ytId}/maxresdefault.jpg`;
          } else {
            thumbnail = `${siteUrl}/og-default.png`;
          }
        }

        const html = buildOgHtml(title, thumbnail, description, streamUrl || queryUrl, siteUrl);
        return withSecurityHeaders(new Response(html, {
          status: 200,
          headers: {
            'Content-Type': 'text/html',
            'Cache-Control': 'public, max-age=300, s-maxage=300'
          }
        }));
      } catch (e) {
        console.error('[seo-handler] Bot path processing failed:', e.message);
        const fallbackHtml = buildOgHtml('mp4yt — Download Any Video Instantly', `${siteUrl}/og-default.png`, 'Download videos from YouTube, TikTok, Instagram and 1000+ platforms instantly.', queryUrl, siteUrl);
        return withSecurityHeaders(new Response(fallbackHtml, { status: 200, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } }));
      }
    }

    // 5. Serve static files from Cloudflare's Assets storage
    try {
      const response = await env.ASSETS.fetch(request);

      if (response.status === 404) {
        const notFoundRequest = new Request(new URL('/404.html', request.url));
        const notFoundResponse = await env.ASSETS.fetch(notFoundRequest);
        if (notFoundResponse.status === 200) {
          return withSecurityHeaders(new Response(notFoundResponse.body, {
            status: 404,
            headers: notFoundResponse.headers,
          }));
        }
      }

      return withSecurityHeaders(response);
    } catch (err) {
      console.error(`[Worker] Error fetching asset from ASSETS binding:`, err);
      return withSecurityHeaders(new Response(`Error loading asset: ${err.message}`, { status: 500 }));
    }
  },

  // Cron trigger to keep Cobalt instances warm
  async scheduled(event, env, ctx) {
    const instances = buildInstanceList(env);
    console.log(`[Keep-alive] Pinging ${instances.length} Cobalt instances...`);

    const pingResults = await Promise.allSettled(
      instances.map(async (apiUrl) => {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);
          const res = await fetch(apiUrl, { signal: controller.signal });
          clearTimeout(timeoutId);
          console.log(`  ✓ ${new URL(apiUrl).hostname}: ${res.status}`);
          return { url: apiUrl, status: res.status };
        } catch (e) {
          console.warn(`  ✗ ${new URL(apiUrl).hostname}: ${e.message}`);
          return { url: apiUrl, error: e.message };
        }
      })
    );

    const alive = pingResults.filter(r => r.status === 'fulfilled' && !r.value.error).length;
    console.log(`[Keep-alive] ${alive}/${instances.length} instances responded.`);
  }
};
