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
import { spawn } from 'child_process';
import { promises as fs, createWriteStream } from 'fs';
import path from 'path';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range, audioUrl',
};

const isVercel = !!process.env.VERCEL;
const isWindows = process.platform === 'win32';

const FFMPEG_BIN_PATH = isVercel
  ? '/tmp/ffmpeg'
  : (isWindows
      ? path.join(process.cwd(), 'bin', 'ffmpeg.exe')
      : path.join(process.cwd(), 'bin', 'ffmpeg'));

const FFMPEG_DOWNLOAD_URL = isWindows
  ? 'https://github.com/eugeneware/ffmpeg-static/releases/download/b5.0.1/win32-x64'
  : 'https://github.com/eugeneware/ffmpeg-static/releases/download/b5.0.1/linux-x64';


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
  const audioUrl = req.query?.audioUrl ?? '';
  const filename = safeFilename(req.query?.filename ?? 'video.mp4');

  if (!validateProxyUrl(rawUrl) || (audioUrl && !validateProxyUrl(audioUrl))) {
    res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid or unsafe URL.' }));
    return;
  }

  const targetUrl = rawUrl.trim();

  try {
    if (audioUrl) {
      // Ensure ffmpeg is present
      const exists = await ffmpegExists();
      if (!exists) {
        console.log('[proxy] ffmpeg not found — downloading static binary…');
        await fs.mkdir(path.dirname(FFMPEG_BIN_PATH), { recursive: true });
        await downloadFfmpeg();
        console.log('[proxy] ffmpeg downloaded and initialized.');
      }
      
      // Merge streams on the fly using ffmpeg
      await mergeAndStream(targetUrl, audioUrl.trim(), filename, res);
    } else {
      await streamDownload(targetUrl, filename, req, res);
    }
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

  });
}

/**
 * Check whether the ffmpeg binary already exists in /tmp or bin directory.
 * @returns {Promise<boolean>}
 */
async function ffmpegExists() {
  try {
    await fs.access(FFMPEG_BIN_PATH, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Download static ffmpeg binary from GitHub releases.
 * @returns {Promise<void>}
 */
async function downloadFfmpeg() {
  return new Promise((resolve, reject) => {
    const downloadToPath = FFMPEG_BIN_PATH;
    let fileStream;

    const followRedirects = (url, maxRedirects = 5) => {
      if (maxRedirects === 0) {
        reject(new Error('Too many redirects while downloading ffmpeg'));
        return;
      }

      const protocol = url.startsWith('https') ? https : http;

      protocol.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          followRedirects(res.headers.location, maxRedirects - 1);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Failed to download ffmpeg: HTTP ${res.statusCode}`));
          return;
        }

        fileStream = createWriteStream(downloadToPath, { mode: 0o755 });

        fileStream.on('error', (err) => {
          reject(new Error(`File write error during ffmpeg download: ${err.message}`));
        });

        fileStream.on('finish', () => {
          fileStream.close(async () => {
            try {
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
        reject(new Error(`Network error downloading ffmpeg: ${err.message}`));
      });
    };

    followRedirects(FFMPEG_DOWNLOAD_URL);
  });
}

/**
 * Stream and merge video and audio tracks on the fly to response.
 */
function mergeAndStream(videoUrl, audioUrl, filename, res) {
  return new Promise((resolve, reject) => {
    res.writeHead(200, {
      ...CORS,
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
    });

    console.log(`[proxy] Spawning ffmpeg to merge on the fly:`);
    console.log(`- Video: ${videoUrl.substring(0, 60)}...`);
    console.log(`- Audio: ${audioUrl.substring(0, 60)}...`);

    const args = [
      '-y',
      '-loglevel', 'error',
      '-i', videoUrl,
      '-i', audioUrl,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      'pipe:1'
    ];

    const ffmpegProcess = spawn(FFMPEG_BIN_PATH, args);

    ffmpegProcess.stdout.pipe(res);

    let stderrData = '';
    ffmpegProcess.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
    });

    ffmpegProcess.on('close', (code) => {
      if (code !== 0) {
        console.error(`[proxy] ffmpeg exited with code ${code}. Stderr: ${stderrData}`);
        reject(new Error(`ffmpeg exited with code ${code}: ${stderrData}`));
      } else {
        console.log(`[proxy] ffmpeg merged and streamed successfully.`);
        resolve();
      }
    });

    ffmpegProcess.on('error', (err) => {
      console.error(`[proxy] ffmpeg spawn error:`, err);
      reject(err);
    });

    res.on('close', () => {
      if (!ffmpegProcess.killed) {
        ffmpegProcess.kill('SIGKILL');
      }
      resolve();
    });
  });
}
