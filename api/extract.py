import re
from urllib.parse import urlparse
from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import yt_dlp

app = FastAPI()

# Enable CORS for frontend requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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
        
        # Block private/loopback IP ranges for SSRF prevention
        private_patterns = [
            r'^localhost$',
            r'^127\.',
            r'^10\.',
            r'^172\.(1[6-9]|2\d|3[01])\.',
            r'^192\.168\.',
            r'^0\.0\.0\.0$',
            r'^::1$',
            r'^fd[0-9a-f]{2}:',
            r'^fe80:'
        ]
        for pattern in private_patterns:
            if re.search(pattern, hostname, re.IGNORECASE):
                return False
        
        return True
    except Exception:
        return False

def sanitize_filename(title: str) -> str:
    if not title or not isinstance(title, str):
        return 'video'
    # strip non-alphanumeric except space, hyphen, underscore
    cleaned = re.sub(r'[^a-zA-Z0-9\s\-_]', '', title)
    cleaned = cleaned.strip().lower()
    cleaned = re.sub(r'\s+', '-', cleaned)
    cleaned = re.sub(r'-+', '-', cleaned)
    return cleaned[:120] or 'video'

def get_resolution_label(width, height) -> str:
    w = width or 0
    h = height or 0
    max_dim = max(w, h)
    
    if max_dim >= 3840 or h >= 2160:
        return '4K (2160p)'
    if max_dim >= 2560 or h >= 1440:
        return '2K (1440p)'
    if max_dim >= 1920 or h >= 1080:
        return '1080p (FHD)'
    if max_dim >= 1280 or h >= 720:
        return '720p (HD)'
    if max_dim >= 854 or h >= 480:
        return '480p'
    if max_dim >= 640 or h >= 360:
        return '360p'
    if max_dim >= 426 or h >= 240:
        return '240p'
    return '144p'

@app.get("/api/extract")
@app.get("/")
async def extract(url: str = Query(...)):
    url = url.strip()
    if not validate_url(url):
        return JSONResponse(status_code=400, content={"error": "Invalid or unsafe URL."})

    # yt-dlp configuration to extract progressive mp4 by default
    format_selector = 'best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]/best'
    
    ydl_opts = {
        'format': format_selector,
        'nocheckcertificate': True,
        'noplaylist': True,
        'quiet': True,
        'no_warnings': True,
        'extractor_args': {
            'youtube': {
                'player_client': ['android', 'web']
            }
        }
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            try:
                metadata = ydl.extract_info(url, download=False)
            except Exception as e:
                err_str = str(e).lower()
                user_message = 'Failed to extract video. Please check the URL and try again.'
                
                if 'unsupported url' in err_str or 'no suitable' in err_str:
                    user_message = 'This URL is not supported. Try a direct video page URL.'
                elif 'private video' in err_str or 'not available' in err_str:
                    user_message = 'This video is private or unavailable in the current region.'
                elif 'age' in err_str or 'sign in' in err_str:
                    user_message = 'This video requires sign-in or age verification.'
                elif 'copyright' in err_str or 'removed' in err_str:
                    user_message = 'This video has been removed or blocked due to copyright.'
                elif 'timeout' in err_str or 'timed out' in err_str:
                    user_message = 'The extraction timed out. The server may be slow — please retry.'
                elif 'network' in err_str or 'connection' in err_str:
                    user_message = 'Network error during extraction. Please retry in a moment.'
                
                return JSONResponse(status_code=400 if 'invalid' in err_str else 500, content={"error": user_message})

        if not metadata:
            return JSONResponse(status_code=500, content={"error": "Could not extract video metadata."})

        # Find direct stream URL (prioritize metadata['url'])
        stream_url = metadata.get('url')
        if not stream_url and metadata.get('requested_formats'):
            stream_url = metadata['requested_formats'][0].get('url')

        if not stream_url:
            return JSONResponse(status_code=500, content={"error": "yt-dlp returned metadata without a stream URL."})

        raw_title = metadata.get('title') or metadata.get('fulltitle') or 'video'
        sanitized = sanitize_filename(raw_title)
        ext = metadata.get('ext', 'mp4').replace('.', '').lower()
        filename = f"{sanitized}.{ext}"

        # Deduplicate formats and list options
        unique_formats = []
        formats = metadata.get('formats', [])

        # Find best audio-only format to suggest for video formats that lack audio
        best_audio_format = None
        audio_formats = [
            f for f in formats 
            if f.get('acodec') and f.get('acodec') != 'none' and (not f.get('vcodec') or f.get('vcodec') == 'none')
        ]
        if audio_formats:
            audio_formats.sort(key=lambda x: x.get('tbr') or x.get('abr') or 0, reverse=True)
            best_audio_format = audio_formats[0]
        else:
            any_audio = [f for f in formats if f.get('acodec') and f.get('acodec') != 'none']
            if any_audio:
                any_audio.sort(key=lambda x: x.get('tbr') or x.get('abr') or 0, reverse=True)
                best_audio_format = any_audio[0]

        # Filter and sort video formats
        video_formats = [
            f for f in formats 
            if f.get('height') and f.get('url') and f.get('vcodec') and f.get('vcodec') != 'none'
        ]

        # Sort: progressive (video+audio) first, then mp4 extension, then filesize/bitrate
        def get_sort_key(f):
            is_progressive = 1 if f.get('acodec') and f.get('acodec') != 'none' else 0
            is_mp4 = 1 if f.get('ext') == 'mp4' else 0
            size = f.get('filesize') or f.get('filesize_approx') or 0
            return (is_progressive, is_mp4, size)

        video_formats.sort(key=get_sort_key, reverse=True)

        seen_labels = set()
        for f in video_formats:
            label = get_resolution_label(f.get('width'), f.get('height'))
            if label in seen_labels:
                continue
            seen_labels.add(label)

            has_audio = f.get('acodec') and f.get('acodec') != 'none'
            v_size = f.get('filesize') or f.get('filesize_approx') or 0
            a_size = 0 if has_audio else (best_audio_format.get('filesize') or best_audio_format.get('filesize_approx') or 0 if best_audio_format else 0)
            total_size = v_size + a_size if (v_size or a_size) else None

            unique_formats.append({
                "format_id": f.get('format_id'),
                "ext": f.get('ext') or 'mp4',
                "height": f.get('height'),
                "width": f.get('width'),
                "resolution": label,
                "url": f.get('url'),
                "audio_url": None if has_audio else (best_audio_format.get('url') if best_audio_format else None),
                "filesize": total_size,
                "has_audio": True,
                "fps": f.get('fps'),
            })

        # Sort formats by height descending
        unique_formats.sort(key=lambda x: x['height'] or 0, reverse=True)

        if not unique_formats and stream_url:
            unique_formats.append({
                "format_id": metadata.get('format_id') or 'best',
                "ext": ext,
                "height": metadata.get('height') or 720,
                "width": metadata.get('width') or 1280,
                "resolution": get_resolution_label(metadata.get('width'), metadata.get('height')) or '720p (HD)',
                "url": stream_url,
                "audio_url": None,
                "filesize": metadata.get('filesize') or metadata.get('filesize_approx'),
                "has_audio": True,
                "fps": metadata.get('fps'),
            })

        payload = {
            "title": raw_title,
            "duration": int(round(metadata['duration'])) if isinstance(metadata.get('duration'), (int, float)) else None,
            "thumbnail": metadata.get('thumbnail') or (metadata.get('thumbnails')[-1].get('url') if metadata.get('thumbnails') else None),
            "url": stream_url,
            "filename": filename,
            "extractor": metadata.get('extractor_key') or metadata.get('extractor') or 'unknown',
            "webpage_url": metadata.get('webpage_url') or url,
            "formats": unique_formats,
        }

        headers = {
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Pragma": "no-cache",
        }
        return JSONResponse(content=payload, headers=headers)

    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Internal extraction error: {str(e)}"})
