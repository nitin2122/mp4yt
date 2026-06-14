import re
from urllib.parse import urlparse, quote
from fastapi import FastAPI, Query, Header, Request
from fastapi.responses import HTMLResponse, RedirectResponse
import yt_dlp

app = FastAPI()

# Bot User-Agent regex pattern (covers major search engines, social crawlers, link previewers, AI scrapers)
BOT_USER_AGENT_REGEX = re.compile(
    r'\b(Twitterbot|facebookexternalhit|Facebook(Catalog|Bot)|Discordbot|WhatsApp|TelegramBot|'
    r'Slackbot(-LinkExpanding)?|Slack-ImgProxy|LinkedInBot|Pinterest(bot)?|Mastodon|Threads|SnapchatBot|'
    r'Line(-NewsDigest)?|Googlebot|Google-InspectionTool|Google-Extended|bingbot|msnbot|YahooSeeker|'
    r'DuckDuckBot|Baiduspider|YandexBot|Sogou(Spider)?|Exabot|AhrefsBot|SemrushBot|MJ12bot|DotBot|'
    r'GPTBot|Claude-Web|anthropic-ai|PerplexityBot|CCBot|cohere-ai|Embedly|Iframely|unfurl|'
    r'Rogerbot|UptimeRobot|Pingdom(Bot)?|StatusCake|HeadlessChrome|PhantomJS|Prerender|facebot|'
    r'ia_archiver|scrapy|python-requests|wget|curl)\b',
    re.IGNORECASE
)

def validate_url(url: str) -> bool:
    if not url or not isinstance(url, str):
        return False
    
    url = url.strip()
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ('http', 'https'):
            return False
        
        hostname = parsed.hostname
        if not hostname:
            return False
        
        private_patterns = [
            r'^localhost$', r'^127\.', r'^10\.', r'^172\.(1[6-9]|2\d|3[01])\.', r'^192\.168\.', r'^0\.0\.0\.0$'
        ]
        for pattern in private_patterns:
            if re.search(pattern, hostname, re.IGNORECASE):
                return False
        return True
    except:
        return False

def escape_html(val: str) -> str:
    if not val:
        return ""
    return (val.replace("&", "&amp;")
               .replace('"', "&quot;")
               .replace("<", "&lt;")
               .replace(">", "&gt;"))

def build_og_html(title: str, thumbnail: str, description: str, video_url: str, site_url: str) -> str:
    safe_title = escape_html(title or 'Video on mp4yt')
    safe_desc = escape_html(description or f'Watch and download "{title}" via mp4yt')
    safe_thumbnail = escape_html(thumbnail or f'{site_url}/og-default.png')
    safe_og_url = escape_html(site_url)
    safe_video_url = escape_html(video_url or '')

    video_tag = f'<meta property="og:video" content="{safe_video_url}" />\n  <meta property="og:video:type" content="video/mp4" />' if safe_video_url else ''

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />

  <!-- Primary -->
  <title>{safe_title} — mp4yt</title>
  <meta name="description" content="{safe_desc}" />
  <link rel="canonical" href="{safe_og_url}" />

  <!-- Open Graph -->
  <meta property="og:type"        content="video.other" />
  <meta property="og:site_name"   content="mp4yt" />
  <meta property="og:url"         content="{safe_og_url}" />
  <meta property="og:title"       content="{safe_title}" />
  <meta property="og:description" content="{safe_desc}" />
  <meta property="og:image"       content="{safe_thumbnail}" />
  <meta property="og:image:width"  content="1280" />
  <meta property="og:image:height" content="720" />
  {video_tag}

  <!-- Twitter Card -->
  <meta name="twitter:card"        content="summary_large_image" />
  <meta name="twitter:site"        content="@mp4yt" />
  <meta name="twitter:title"       content="{safe_title}" />
  <meta name="twitter:description" content="{safe_desc}" />
  <meta name="twitter:image"       content="{safe_thumbnail}" />

  <!-- Robots: allow indexing of the OG shell but not follow -->
  <meta name="robots" content="noindex, follow" />
</head>
<body style="font-family:system-ui,sans-serif;background:#fafafa;color:#171717;padding:40px;max-width:640px;margin:auto">
  <h1 style="font-size:24px;font-weight:600;letter-spacing:-0.5px;margin-bottom:12px">{safe_title}</h1>
  {f'<img src="{safe_thumbnail}" alt="Thumbnail" style="width:100%;border-radius:8px;margin-bottom:16px" />' if safe_thumbnail else ''}
  <p style="color:#4d4d4d;margin-bottom:24px">{safe_desc}</p>
  <a href="{site_url}/#url={quote(video_url or '')}"
     style="display:inline-flex;align-items:center;gap:8px;background:#171717;color:#fff;padding:10px 20px;border-radius:100px;text-decoration:none;font-size:14px;font-weight:500">
    ↓ Download on mp4yt
  </a>
</body>
</html>"""

@app.get("/watch")
@app.get("/")
async def watch(request: Request, url: str = Query(None), user_agent: str = Header(None)):
    ua = user_agent or ""
    is_bot = bool(BOT_USER_AGENT_REGEX.search(ua))

    # Resolve SITE_URL dynamically based on the incoming request base url
    site_url = str(request.base_url).rstrip('/')

    if not url or not validate_url(url):
        if is_bot:
            html = build_og_html(
                title='mp4yt — Download Any Video Instantly',
                thumbnail=f'{site_url}/og-default.png',
                description='Download videos from YouTube, TikTok, Instagram and 1000+ platforms instantly.',
                video_url='',
                site_url=site_url
            )
            return HTMLResponse(content=html)
        else:
            return RedirectResponse(url='/', status_code=302)

    target_url = url.strip()

    # HUMAN path: fast redirect with hash URL
    if not is_bot:
        redirect_url = f"{site_url}/#url={quote(target_url)}"
        headers = {
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
        }
        return RedirectResponse(url=redirect_url, status_code=302, headers=headers)

    # BOT path: fetch metadata + render OpenGraph HTML
    try:
        ydl_opts = {
            'nocheckcertificate': True,
            'noplaylist': True,
            'quiet': True,
            'no_warnings': True,
            'skip_download': True,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            meta = ydl.extract_info(target_url, download=False)
        
        title = meta.get('title') or meta.get('fulltitle') or 'Video'
        thumbnail = meta.get('thumbnail') or (meta.get('thumbnails')[-1].get('url') if meta.get('thumbnails') else None)
        desc = meta.get('description', '')
        desc = re.sub(r'\r?\n', ' ', desc)[:200] if desc else f'Watch and download "{title}" via mp4yt'
        
        # Try to find a direct stream url
        stream_url = meta.get('url')
        if not stream_url and meta.get('requested_formats'):
            stream_url = meta['requested_formats'][0].get('url')
        if not stream_url:
            stream_url = target_url

        html = build_og_html(title, thumbnail, desc, stream_url, site_url)
        return HTMLResponse(content=html, headers={"Cache-Control": "public, max-age=300, s-maxage=300"})
        
    except Exception as e:
        # Fallback for bot errors
        fallback_html = build_og_html(
            title='mp4yt — Download Any Video Instantly',
            thumbnail=f'{site_url}/og-default.png',
            description='Download videos from YouTube, TikTok, Instagram and 1000+ platforms instantly.',
            video_url=target_url,
            site_url=site_url
        )
        return HTMLResponse(content=fallback_html, headers={"Cache-Control": "no-store"})
