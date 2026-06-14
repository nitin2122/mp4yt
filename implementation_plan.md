# mp4yt.com — Full Implementation Plan

A Vercel-design-language YouTube/video downloader that surpasses vidssave.com with zero disk storage, serverless CDN streaming, edge SEO interception, and a premium developer-centric UI.

---

## Competitor Analysis: vidssave.com

After thorough analysis, here's what the competitor offers and how we'll exceed it:

| Feature | vidssave.com | mp4yt.com (Our Plan) |
|---|---|---|
| Supported Platforms | YouTube, IG, FB, TikTok, Pinterest | YouTube (primary, yt-dlp supports 1000+ sites) |
| Quality Options | 144p → 4K + MP3 | Best MP4 (progressive, no muxing) |
| Design | Dark theme, generic | Vercel-inspired, premium Geist/Inter |
| Download Method | Dual "Fast/Download" buttons (slow mirrors) | Direct CDN streaming URL, zero disk |
| SEO | Footer keyword guides | Dynamic OpenGraph edge interception |
| Unique Feature | Chrome Extension | Live video preview player + hash URL autofill |
| UX | Manual click | Auto-paste detection + instant extraction |
| Performance | Heavy muxing delays | Serverless CDN proxy, instant metadata fetch |

---

## How We'll Beat the Competitor

1. **Cleaner, more premium design** — Vercel design system (Geist font, mesh gradient, stacked shadow elevation, ink primary)
2. **Zero muxing** — Direct progressive MP4 stream URLs, no FFmpeg overhead
3. **Live preview player** — HTML5 video preview before download
4. **Auto-paste detection** — URL is pasted → extraction triggers automatically
5. **Hash URL autofill** — Shared links auto-populate the input field
6. **Dynamic Edge SEO** — Real OpenGraph with actual title + thumbnail for crawlers
7. **Elegant loading states** — Vercel-style progress animation during fetch
8. **How It Works** section — Transparent, trust-building technical explainer

---

## Architecture Overview

```
mp4yt.com/
├── vercel.json              ← Advanced routing (SEO handler + API)
├── api/
│   ├── extract.js           ← Serverless: yt-dlp metadata proxy
│   └── seo-handler.js       ← Serverless: Bot detection + OG tags
└── src/ (Astro frontend)
    ├── layouts/
    │   └── Layout.astro     ← Base layout with Geist font + global CSS
    ├── components/
    │   ├── Navbar.astro     ← Sticky nav (logo + nav links + CTA)
    │   ├── Hero.astro       ← Hero band with mesh gradient + URL input
    │   ├── ResultCard.astro ← Video result card with preview player
    │   ├── Features.astro   ← 3-up feature cards
    │   ├── HowItWorks.astro ← Step-by-step explainer
    │   ├── SupportedSites.astro ← Logo strip of supported platforms
    │   ├── FAQ.astro        ← Accordion FAQ section
    │   └── Footer.astro     ← 4-column footer
    ├── pages/
    │   └── index.astro      ← Main page assembling all components
    └── styles/
        └── global.css       ← Design system tokens + utilities
```

---

## Proposed Changes

### Backend — Serverless API

#### [NEW] `vercel.json`
Advanced Vercel routing:
- Route `/watch` → `api/seo-handler.js`
- Route `/api/extract` → `api/extract.js`
- All other routes → Astro frontend

#### [NEW] `api/extract.js`
- GET handler with universal CORS headers
- Check `/tmp/yt-dlp` binary existence; if missing, download from GitHub releases (`chmod +x`)
- Run `yt-dlp --dump-json` with subprocess
- Extract: `title`, `duration`, `thumbnail`, direct streaming URL (`url` field from best mp4), sanitized filename
- Return structured JSON

#### [NEW] `api/seo-handler.js`
- Parse `?url=` query parameter
- Match User-Agent against bot regex (Twitterbot, facebookexternalhit, Discordbot, WhatsApp, TelegramBot, Googlebot, Slackbot, LinkedInBot, etc.)
- **Bot path**: Run minimal `yt-dlp -J` fetch → return HTML shell with full OpenGraph + Twitter Card meta tags
- **Human path**: 302 redirect to `/#url=<encoded>` for frontend autofill

---

### Frontend — Astro + Tailwind CSS

#### [MODIFY] `astro.config.mjs`
- Add Tailwind CSS v4 integration (`@astrojs/tailwind`)

#### [MODIFY] `src/layouts/Layout.astro`
- Geist + Geist Mono fonts from Google Fonts (or CDN)
- Full SEO meta tags (title, description, OG, Twitter Card)
- Global design system CSS
- `<slot />` with canvas-soft body

#### [NEW] `src/styles/global.css`
Complete Vercel design token system:
- CSS custom properties for all colors, spacing, radius, shadows
- Typography scale matching DESIGN.md exactly
- Mesh gradient keyframe animation
- Micro-interaction utilities

#### [MODIFY] `src/pages/index.astro`
Full page composition:
```
<Layout>
  <Navbar />
  <Hero />          ← URL input + mesh gradient
  <ResultCard />    ← Video preview player (shown after extraction)
  <SupportedSites />
  <Features />
  <HowItWorks />
  <FAQ />
  <Footer />
</Layout>
```

#### [NEW] `src/components/Navbar.astro`
- Logo: `mp4yt` with subtle gradient text
- Nav links: YouTube, Features, How It Works, FAQ
- CTA: "Download Now" black pill button
- Sticky with backdrop blur
- Mobile hamburger collapse

#### [NEW] `src/components/Hero.astro`
- Mesh gradient background (cyan/blue/magenta/amber — per DESIGN.md)
- `display-xl` headline: "Download any video. Instantly."
- Lead paragraph in `body-lg`
- `form-input-lg` URL input (height 48px) with inline "Extract" button
- Auto-paste detection via JS clipboard event listener
- Hash URL autofill: reads `/#url=...` on load and populates input
- Loading state: animated progress bar (Vercel-style)

#### [NEW] `src/components/ResultCard.astro`
- Shown after successful API response (JS-driven visibility)
- Video thumbnail displayed
- Title, duration metadata
- HTML5 `<video>` preview player with controls
- "Download MP4" black pill CTA
- Sanitized filename displayed
- Fade-in animation on appearance

#### [NEW] `src/components/Features.astro`
- 3-up `card-marketing` grid
- Features: "Zero Storage" / "Instant CDN Stream" / "Privacy First"
- Each card: icon (SVG), `display-sm` heading, `body-md` copy
- Level 3 stacked shadow elevation
- Hover micro-animation (subtle lift + border glow)

#### [NEW] `src/components/HowItWorks.astro`
- Dark polarity-flipped band (`showcase-band-dark`)
- 3-step horizontal flow: Paste → Extract → Download
- Code-editor-mockup showing example API response JSON
- `caption-mono` step labels

#### [NEW] `src/components/SupportedSites.astro`
- Logo strip: YouTube, Instagram, Twitter/X, TikTok, Facebook, Reddit, Vimeo, Twitch, SoundCloud, etc.
- "Powered by yt-dlp — 1000+ supported sites"
- Infinite horizontal scroll animation

#### [NEW] `src/components/FAQ.astro`
- Accordion with smooth height animation
- Questions: Is it free? / Is it safe? / What formats? / How fast? / Legal disclaimer
- `canvas-soft` background band

#### [NEW] `src/components/Footer.astro`
- 4-column layout: Product / Platforms / Legal / Resources
- Logo + tagline in first column
- Caption-mono column headers
- `body-sm` link rows

---

## Design System Implementation

Following DESIGN.md exactly:
- **Primary font**: Geist (Inter fallback) — weights 400/500/600 only
- **Mono font**: Geist Mono (JetBrains Mono fallback)
- **Primary CTA color**: `#171717` (ink)
- **Canvas**: `#ffffff` / Canvas Soft: `#fafafa`
- **Mesh gradient**: `#007cf0` → `#00dfd8` → `#7928ca` → `#ff0080` → `#ff4d4d` → `#f9cb28`
- **Shadows**: Stacked multi-offset (never single heavy drop)
- **Border radius**: 100px pill for marketing CTAs, 6px for nav buttons
- **Headlines**: Sentence-case, negative letter-spacing, weight 600

---

## Verification Plan

### Automated
- `npm run build` — check for zero build errors
- `npm run dev` — local dev server at `localhost:4321`

### Manual
1. Paste a YouTube URL → verify extraction + preview player appears
2. Share a `/watch?url=...` link → verify bot detection + OG tags rendered
3. Share a human-accessible link → verify 302 redirect with hash
4. Test on mobile viewport (responsive breakpoints)
5. Verify mesh gradient renders at hero scale
6. Check all nav links, FAQ accordion, footer links

---

## Open Questions

> [!IMPORTANT]
> **Tailwind CSS Version**: The user requested Tailwind v4. Shall I use `@tailwindcss/vite` (new Tailwind v4 plugin for Vite/Astro) or the legacy `@astrojs/tailwind` adapter (which uses Tailwind v3)?

> [!IMPORTANT]
> **yt-dlp Platform**: The `api/extract.js` downloads the Linux `yt-dlp` binary (for Vercel serverless Linux containers). This will NOT work locally on Windows dev. The Astro frontend itself runs fine locally — only the API routes need Vercel deployment. Is this the intended setup?

> [!NOTE]
> **Supported Platforms Scope**: The competitor (vidssave.com) has dedicated sub-pages per platform (YouTube, Instagram, TikTok, etc.). For this initial build, I plan one unified extractor (yt-dlp handles all platforms). Should I add platform-specific sub-pages (`/youtube`, `/instagram`, etc.) as SEO landing pages?
