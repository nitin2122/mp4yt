/**
 * api/extract.js
 *
 * Serverless Compute Engine — mp4yt.com
 *
 * Responsibilities:
 *  1. Accept GET requests with ?url=<video_url> query parameter
 *  2. Return universal CORS headers for browser consumption
 *  3. Check for yt-dlp binary in /tmp; if missing, download from GitHub releases
 *  4. Run yt-dlp --dump-json filtering for best progressive MP4 (no muxing)
 *  5. Return structured JSON: title, duration, thumbnail, url, filename
 *
 * Zero disk: No file is ever saved beyond the yt-dlp binary in /tmp.
 * Serverless-safe: Filters for pre-muxed MP4 to avoid FFmpeg overhead + timeouts.
 */

import { execFile } from 'child_process';
import { promises as fs, createWriteStream } from 'fs';
import { promisify } from 'util';
import path from 'path';
import https from 'https';
import http from 'http';

const execFileAsync = promisify(execFile);

// ── Constants ────────────────────────────────────────────────────────────────

const isVercel = !!process.env.VERCEL;
const isWindows = process.platform === 'win32';

const YTDLP_BIN_PATH = isVercel
  ? '/tmp/yt-dlp'
  : (isWindows
      ? path.join(process.cwd(), 'bin', 'yt-dlp.exe')
      : path.join(process.cwd(), 'bin', 'yt-dlp'));

/**
 * Official yt-dlp latest release URL (Vercel serverless runs on Linux).
 * Using the stable release channel for production reliability.
 */
const YTDLP_DOWNLOAD_URL = isWindows
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

/**
 * yt-dlp format selector:
 * - "best[ext=mp4]"  — best single progressive MP4 file (no muxing required)
 * - "/best"          — fallback to best any format if no MP4 progressive exists
 *
 * This ensures we NEVER trigger FFmpeg muxing, which would:
 * a) Exceed the 30s Vercel serverless timeout
 * b) Require disk space for the output file
 */
const FORMAT_SELECTOR = 'best[ext=mp4]/best';

/**
 * Maximum execution time (ms) for yt-dlp metadata fetch.
 * Must be well below the Vercel 30s function timeout.
 */
const YTDLP_TIMEOUT_MS = 20_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Check whether the yt-dlp binary already exists in /tmp.
 * @returns {Promise<boolean>}
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
 * Download the yt-dlp binary from GitHub releases into /tmp and apply chmod +x.
 * Uses native Node.js https module — no external dependencies.
 * @returns {Promise<void>}
 */
async function downloadYtdlp() {
  return new Promise((resolve, reject) => {
    const downloadToPath = YTDLP_BIN_PATH;
    let fileStream;

    const followRedirects = (url, maxRedirects = 5) => {
      if (maxRedirects === 0) {
        reject(new Error('Too many redirects while downloading yt-dlp'));
        return;
      }

      const protocol = url.startsWith('https') ? https : http;

      protocol.get(url, (res) => {
        // Handle redirects (GitHub releases always redirect 302 → CDN)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          followRedirects(res.headers.location, maxRedirects - 1);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Failed to download yt-dlp: HTTP ${res.statusCode}`));
          return;
        }

        fileStream = createWriteStream(downloadToPath, { mode: 0o755 });

        fileStream.on('error', (err) => {
          reject(new Error(`File write error during yt-dlp download: ${err.message}`));
        });

        fileStream.on('finish', () => {
          fileStream.close(async () => {
            try {
              // Ensure executable bit even if createWriteStream mode was ignored (skip on Windows)
              if (process.platform !== 'win32') {
                await fs.chmod(downloadToPath, 0o755);
              }
              resolve();
            } catch (chmodErr) {
              reject(new Error(`chmod failed: ${chmodErr.message}`));
            }
          });
        });

        res.pipe(fileStream);

      }).on('error', (err) => {
        reject(new Error(`Network error downloading yt-dlp: ${err.message}`));
      });
    };

    followRedirects(YTDLP_DOWNLOAD_URL);
  });
}

/**
 * Sanitize a video title into a web-safe filename.
 * - Removes characters invalid in filenames
 * - Collapses whitespace to hyphens
 * - Truncates to 120 chars to avoid path length issues
 * @param {string} title
 * @returns {string}
 */
function sanitizeFilename(title) {
  if (!title || typeof title !== 'string') return 'video';
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_]/g, '')   // strip non-alphanumeric except space, hyphen, underscore
    .trim()
    .replace(/\s+/g, '-')              // spaces → hyphens
    .replace(/-+/g, '-')               // collapse multiple hyphens
    .slice(0, 120)                     // truncate
    || 'video';
}

/**
 * Validate that the given string is a safe HTTP/HTTPS URL.
 * Prevents SSRF by blocking private IP ranges.
 * @param {string} rawUrl
 * @returns {{ valid: boolean; reason?: string }}
 */
function validateUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { valid: false, reason: 'No URL provided.' };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { valid: false, reason: 'Invalid URL format.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: 'Only HTTP and HTTPS URLs are supported.' };
  }

  // Block private/loopback IP ranges (SSRF prevention)
  const hostname = parsed.hostname;
  const privateRanges = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^0\.0\.0\.0$/,
    /^::1$/,
    /^fd[0-9a-f]{2}:/i,
    /^fe80:/i,
  ];

  for (const range of privateRanges) {
    if (range.test(hostname)) {
      return { valid: false, reason: 'Private or loopback addresses are not allowed.' };
    }
  }

  return { valid: true };
}

/**
 * Run yt-dlp with --dump-json on the given URL and return parsed metadata.
 * Uses the FORMAT_SELECTOR to ensure a pre-muxed MP4 is selected.
 * @param {string} url
 * @returns {Promise<object>} Raw yt-dlp JSON metadata object
 */
async function fetchMetadata(url) {
  const args = [
    '--dump-json',          // Output metadata JSON to stdout, do NOT download
    '--no-playlist',        // Never expand a playlist; extract single video
    '--no-warnings',        // Suppress non-critical warnings from stderr
    '--no-check-certificate', // Avoid slow cert checks on CDN origins
    '-f', FORMAT_SELECTOR,  // Format selector (best[ext=mp4]/best)
    '--',                   // Separator to prevent URL injection as a flag
    url,
  ];

  const { stdout } = await execFileAsync(YTDLP_BIN_PATH, args, {
    timeout: YTDLP_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024, // 8 MB stdout buffer (metadata can be large)
    env: {
      ...process.env,
      // Ensure HOME is set for yt-dlp's config directory
      HOME: process.env.HOME || '/tmp',
    },
  });

  return JSON.parse(stdout.trim());
}

// ── CORS Helper ───────────────────────────────────────────────────────────────

/**
 * Build universal CORS response headers.
 * @returns {object}
 */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
  };
}

// ── Main Handler ─────────────────────────────────────────────────────────────

/**
 * Vercel Serverless Function handler.
 *
 * @param {import('@vercel/node').VercelRequest} req
 * @param {import('@vercel/node').VercelResponse} res
 */
export default async function handler(req, res) {
  // ── Handle CORS preflight ──
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  // ── Only allow GET ──
  if (req.method !== 'GET') {
    res.writeHead(405, { ...corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method Not Allowed. Use GET.' }));
    return;
  }

  // ── Extract & validate URL parameter ──
  const rawUrl = req.query?.url ?? '';
  const { valid, reason } = validateUrl(rawUrl);

  if (!valid) {
    res.writeHead(400, { ...corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: reason || 'Invalid URL.' }));
    return;
  }

  const targetUrl = rawUrl.trim();

  try {
    // ── Ensure yt-dlp binary is present ──
    const exists = await ytdlpExists();
    if (!exists) {
      console.log('[mp4yt] yt-dlp not found — downloading from GitHub releases…');
      await fs.mkdir(path.dirname(YTDLP_BIN_PATH), { recursive: true });
      await downloadYtdlp();
      console.log('[mp4yt] yt-dlp downloaded and initialized.');
    }

    // ── Run metadata extraction ──
    console.log(`[mp4yt] Extracting metadata for: ${targetUrl}`);
    const metadata = await fetchMetadata(targetUrl);

    // ── Extract the direct streaming URL ──
    // yt-dlp returns "url" for single-format, or "requested_formats[].url" for muxed.
    // Since we filter for pre-muxed MP4, "url" should always be present.
    const streamUrl =
      metadata.url ||
      (metadata.requested_formats && metadata.requested_formats[0]?.url) ||
      null;

    if (!streamUrl) {
      throw new Error('yt-dlp returned metadata without a stream URL.');
    }

    // ── Build sanitized filename ──
    const rawTitle = metadata.title || metadata.fulltitle || 'video';
    const sanitized = sanitizeFilename(rawTitle);
    const ext = (metadata.ext || 'mp4').replace(/[^a-z0-9]/gi, '').toLowerCase();
    const filename = `${sanitized}.${ext}`;

    // ── Build response payload ──
    const payload = {
      title: rawTitle,
      duration: typeof metadata.duration === 'number' ? Math.round(metadata.duration) : null,
      thumbnail:
        metadata.thumbnail ||
        (Array.isArray(metadata.thumbnails) && metadata.thumbnails.at(-1)?.url) ||
        null,
      url: streamUrl,
      filename,
      extractor: metadata.extractor_key || metadata.extractor || 'unknown',
      webpage_url: metadata.webpage_url || targetUrl,
    };

    // ── Respond ──
    res.writeHead(200, {
      ...corsHeaders(),
      'Content-Type': 'application/json',
      // Prevent caching — stream URLs expire (typically in a few hours)
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    });
    res.end(JSON.stringify(payload));

  } catch (err) {
    console.error('[mp4yt] Extraction error:', err?.message ?? err);

    // Classify common yt-dlp errors for user-friendly messages
    let userMessage = 'Failed to extract video. Please check the URL and try again.';
    const errStr = (err?.message ?? '').toLowerCase();

    if (errStr.includes('unsupported url') || errStr.includes('no suitable')) {
      userMessage = 'This URL is not supported. Try a direct video page URL.';
    } else if (errStr.includes('private video') || errStr.includes('not available')) {
      userMessage = 'This video is private or unavailable in the current region.';
    } else if (errStr.includes('age') || errStr.includes('sign in')) {
      userMessage = 'This video requires sign-in or age verification.';
    } else if (errStr.includes('copyright') || errStr.includes('removed')) {
      userMessage = 'This video has been removed or blocked due to copyright.';
    } else if (errStr.includes('timeout') || errStr.includes('timed out')) {
      userMessage = 'The extraction timed out. The server may be slow — please retry.';
    } else if (errStr.includes('network') || errStr.includes('connection')) {
      userMessage = 'Network error during extraction. Please retry in a moment.';
    }

    const statusCode = errStr.includes('invalid url') ? 400 : 500;

    res.writeHead(statusCode, {
      ...corsHeaders(),
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify({ error: userMessage }));
  }
}
