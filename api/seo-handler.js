/**
 * api/seo-handler.js
 *
 * Smart Crawler Interceptor — mp4yt.com
 *
 * Responsibilities:
 *  1. Parse incoming page requests with ?url= query strings
 *  2. Detect User-Agent against a rigorous bot/crawler regex
 *  3. If BOT detected:
 *     - Run a minimal yt-dlp -J fetch for speed
 *     - Construct and return a full OpenGraph + Twitter Card HTML shell
 *       using the real video title + thumbnail
 *  4. If HUMAN detected:
 *     - 302 redirect to /#url=<encoded> so the frontend JS can auto-fill
 *       the input and trigger extraction automatically
 *
 * This enables rich link previews in Discord, WhatsApp, Telegram, Twitter,
 * Facebook, Slack, LinkedIn, iMessage, etc. — while humans get a seamless
 * app experience.
 */

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

// ── Constants ────────────────────────────────────────────────────────────────

const isVercel = !!process.env.VERCEL;
const isWindows = process.platform === 'win32';

const YTDLP_BIN_PATH = isVercel
  ? '/tmp/yt-dlp'
  : (isWindows
      ? path.join(process.cwd(), 'bin', 'yt-dlp.exe')
      : path.join(process.cwd(), 'bin', 'yt-dlp'));

const YTDLP_DOWNLOAD_URL = isWindows
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

const SITE_URL = 'https://mp4yt.com';
const YTDLP_TIMEOUT_MS = 12_000;

// ── Bot detection regex ───────────────────────────────────────────────────────

/**
 * Comprehensive User-Agent regex for social media crawlers and search bots.
 *
 * Covers:
 * - Social platforms: Twitter, Facebook, Discord, WhatsApp, Telegram, LinkedIn,
 *   Slack, Pinterest, Mastodon, Threads, Snapchat, Line
 * - Search engines: Google, Bing, Yahoo, DuckDuckBot, Baidu, Yandex, Sogou
 * - AI crawlers: GPTBot, Claude-Web, Anthropic, PerplexityBot, CCBot
 * - Link previewers: Embedly, Iframely, unfurl, Open Graph scrapers
 * - Uptime monitors: UptimeRobot, Pingdom, StatusCake
 */
const BOT_USER_AGENT_REGEX = /\b(
  Twitterbot
  |facebookexternalhit
  |Facebook(?:Catalog|Bot)
  |Discordbot
  |WhatsApp
  |TelegramBot
  |Slackbot(?:-LinkExpanding)?
  |Slack-ImgProxy
  |LinkedInBot
  |Pinterest(?:bot)?
  |Mastodon
  |Threads
  |SnapchatBot
  |Line(?:-NewsDigest)?
  |Googlebot
  |Google-InspectionTool
  |Google-Extended
  |bingbot
  |msnbot
  |YahooSeeker
  |DuckDuckBot
  |Baiduspider
  |YandexBot
  |Sogou(?:Spider)?
  |Exabot
  |AhrefsBot
  |SemrushBot
  |MJ12bot
  |DotBot
  |GPTBot
  |Claude-Web
  |anthropic-ai
  |PerplexityBot
  |CCBot
  |cohere-ai
  |Embedly
  |Iframely
  |unfurl
  |Rogerbot
  |UptimeRobot
  |Pingdom(?:Bot)?
  |StatusCake
  |HeadlessChrome
  |PhantomJS
  |Prerender
  |facebot
  |ia_archiver
  |scrapy
  |python-requests
  |wget
  |curl
)\b/ix;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Check whether yt-dlp binary exists and is executable.
 */
async function ytdlpExists() {
  try {
    await fs.access(YTDLP_BIN_PATH, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Download yt-dlp binary from GitHub releases, following redirects, chmod +x.
 */
async function downloadYtdlp() {
  const https = await import('https');
  const http = await import('http');
  const fsSync = await import('fs');

  return new Promise((resolve, reject) => {
    const followRedirects = (url, maxRedirects = 5) => {
      if (maxRedirects === 0) {
        reject(new Error('Too many redirects downloading yt-dlp'));
        return;
      }

      const lib = url.startsWith('https') ? https.default : http.default;

      lib.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          followRedirects(res.headers.location, maxRedirects - 1);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} downloading yt-dlp`));
          return;
        }

        const stream = fsSync.createWriteStream(YTDLP_BIN_PATH, { mode: 0o755 });
        stream.on('error', reject);
        stream.on('finish', () => {
          stream.close(async () => {
            if (process.platform !== 'win32') {
              await fs.chmod(YTDLP_BIN_PATH, 0o755);
            }
            resolve();
          });
        });
        res.pipe(stream);
      }).on('error', reject);
    };

    followRedirects(YTDLP_DOWNLOAD_URL);
  });
}

/**
 * Validate URL is a safe http/https URL (SSRF prevention).
 */
function validateUrl(rawUrl) {
  if (!rawUrl) return { valid: false };
  try {
    const u = new URL(rawUrl.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { valid: false };
    const privateRanges = [/^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^0\.0\.0\.0$/];
    for (const r of privateRanges) {
      if (r.test(u.hostname)) return { valid: false };
    }
    return { valid: true, parsed: u };
  } catch {
    return { valid: false };
  }
}

/**
 * Fetch minimal video metadata using yt-dlp -J (alias for --dump-json).
 * We only need title + thumbnail, so this is fast.
 */
async function fetchMinimalMetadata(url) {
  const { stdout } = await execFileAsync(
    YTDLP_BIN_PATH,
    [
      '-J',                // Alias for --dump-json; fastest metadata fetch
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificate',
      '--skip-download',   // Belt-and-suspenders: never download the file
      '--',
      url,
    ],
    {
      timeout: YTDLP_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024, // 4 MB
      env: { ...process.env, HOME: process.env.HOME || '/tmp' },
    }
  );
  return JSON.parse(stdout.trim());
}

/**
 * Escape HTML entities to prevent XSS in OpenGraph meta values.
 */
function escapeHtml(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build the OpenGraph HTML shell for crawler bots.
 * Returns a minimal, fast-parsing HTML document.
 */
function buildOgHtml({ title, thumbnail, description, videoUrl, ogUrl }) {
  const safeTitle      = escapeHtml(title || 'Video on mp4yt');
  const safeDesc       = escapeHtml(description || `Watch and download "${title}" via mp4yt.com`);
  const safeThumbnail  = escapeHtml(thumbnail || `${SITE_URL}/og-default.png`);
  const safeOgUrl      = escapeHtml(ogUrl || SITE_URL);
  const safeVideoUrl   = escapeHtml(videoUrl || '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />

  <!-- Primary -->
  <title>${safeTitle} — mp4yt</title>
  <meta name="description" content="${safeDesc}" />
  <link rel="canonical" href="${safeOgUrl}" />

  <!-- Open Graph -->
  <meta property="og:type"        content="video.other" />
  <meta property="og:site_name"   content="mp4yt" />
  <meta property="og:url"         content="${safeOgUrl}" />
  <meta property="og:title"       content="${safeTitle}" />
  <meta property="og:description" content="${safeDesc}" />
  <meta property="og:image"       content="${safeThumbnail}" />
  <meta property="og:image:width"  content="1280" />
  <meta property="og:image:height" content="720" />
  ${safeVideoUrl ? `<meta property="og:video"       content="${safeVideoUrl}" />` : ''}
  ${safeVideoUrl ? `<meta property="og:video:type"  content="video/mp4" />` : ''}

  <!-- Twitter Card -->
  <meta name="twitter:card"        content="summary_large_image" />
  <meta name="twitter:site"        content="@mp4yt" />
  <meta name="twitter:title"       content="${safeTitle}" />
  <meta name="twitter:description" content="${safeDesc}" />
  <meta name="twitter:image"       content="${safeThumbnail}" />

  <!-- Robots: allow indexing of the OG shell but not follow -->
  <meta name="robots" content="noindex, follow" />
</head>
<body style="font-family:system-ui,sans-serif;background:#fafafa;color:#171717;padding:40px;max-width:640px;margin:auto">
  <h1 style="font-size:24px;font-weight:600;letter-spacing:-0.5px;margin-bottom:12px">${safeTitle}</h1>
  ${safeThumbnail ? `<img src="${safeThumbnail}" alt="Thumbnail" style="width:100%;border-radius:8px;margin-bottom:16px" />` : ''}
  <p style="color:#4d4d4d;margin-bottom:24px">${safeDesc}</p>
  <a href="${SITE_URL}/#url=${encodeURIComponent(videoUrl || '')}"
     style="display:inline-flex;align-items:center;gap:8px;background:#171717;color:#fff;padding:10px 20px;border-radius:100px;text-decoration:none;font-size:14px;font-weight:500">
    ↓ Download on mp4yt.com
  </a>
</body>
</html>`;
}

// ── Main Handler ─────────────────────────────────────────────────────────────

/**
 * Vercel Serverless Function handler.
 *
 * @param {import('@vercel/node').VercelRequest} req
 * @param {import('@vercel/node').VercelResponse} res
 */
export default async function handler(req, res) {
  const rawUrl = req.query?.url ?? '';
  const userAgent = req.headers['user-agent'] ?? '';

  // ── Validate URL ──
  const { valid, parsed } = validateUrl(rawUrl);

  if (!valid) {
    // No valid URL: just redirect humans to home, bots get minimal page
    const isBot = BOT_USER_AGENT_REGEX.test(userAgent);
    if (isBot) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildOgHtml({ title: 'mp4yt — Download Any Video Instantly', videoUrl: '' }));
    } else {
      res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
      res.end();
    }
    return;
  }

  const targetUrl = rawUrl.trim();
  const isBot = BOT_USER_AGENT_REGEX.test(userAgent);

  // ── HUMAN path: fast redirect with hash URL ──
  if (!isBot) {
    const redirectUrl = `${SITE_URL}/#url=${encodeURIComponent(targetUrl)}`;
    res.writeHead(302, {
      Location: redirectUrl,
      'Cache-Control': 'no-store, no-cache',
      'Pragma': 'no-cache',
    });
    res.end();
    return;
  }

  // ── BOT path: fetch metadata + render OpenGraph HTML ──
  try {
    // Ensure yt-dlp is available
    if (!(await ytdlpExists())) {
      console.log('[seo-handler] Downloading yt-dlp for OG fetch…');
      await fs.mkdir(path.dirname(YTDLP_BIN_PATH), { recursive: true });
      await downloadYtdlp();
    }

    const meta = await fetchMinimalMetadata(targetUrl);

    const title = meta.title || meta.fulltitle || 'Video';
    const thumbnail =
      meta.thumbnail ||
      (Array.isArray(meta.thumbnails) ? meta.thumbnails.at(-1)?.url : null) ||
      null;
    const description = meta.description
      ? meta.description.slice(0, 200).replace(/\r?\n/g, ' ')
      : `Watch and download "${title}" via mp4yt.com`;

    const ogUrl = `${SITE_URL}/watch?url=${encodeURIComponent(targetUrl)}`;
    const streamUrl = meta.url || null;

    const html = buildOgHtml({ title, thumbnail, description, videoUrl: streamUrl, ogUrl });

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      // Cache OG shells briefly — yt-dlp URLs expire but thumbnail/title are stable
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    });
    res.end(html);

  } catch (err) {
    console.error('[seo-handler] OG fetch failed:', err?.message ?? err);

    // Graceful fallback: return a minimal branded OG shell without video-specific data
    const fallbackHtml = buildOgHtml({
      title: 'mp4yt — Download Any Video Instantly',
      thumbnail: `${SITE_URL}/og-default.png`,
      description: 'Download videos from YouTube, TikTok, Instagram and 1000+ platforms instantly.',
      videoUrl: targetUrl,
      ogUrl: `${SITE_URL}/watch?url=${encodeURIComponent(targetUrl)}`,
    });

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(fallbackHtml);
  }
}
