#!/usr/bin/env node

/**
 * extract-cookies.cjs
 * 
 * Converts a Netscape-format cookies.txt file (exported from a browser extension)
 * into the cookies.json format required by the Cobalt API.
 *
 * Usage:
 *   node scripts/extract-cookies.cjs <path-to-cookies.txt>
 *
 * It will output a cookies.json file in the same directory.
 *
 * Steps:
 *   1. Install "Get cookies.txt LOCALLY" Chrome extension
 *   2. Log into YouTube with a burner Google account
 *   3. Go to youtube.com, click the extension, export cookies.txt
 *   4. Run: node scripts/extract-cookies.cjs path/to/cookies.txt
 *   5. Upload the generated cookies.json to Render as a Secret File
 */

const fs = require('fs');
const path = require('path');

function parseCookiesTxt(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const cookies = [];

  for (const line of lines) {
    // Skip comments and empty lines
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    // Netscape cookie format: domain \t flag \t path \t secure \t expiry \t name \t value
    const parts = trimmed.split('\t');
    if (parts.length >= 7) {
      const [domain, , , , , name, value] = parts;
      // Only include YouTube-related cookies
      if (domain.includes('youtube.com') || domain.includes('google.com') || domain.includes('.google.')) {
        cookies.push({ name: name.trim(), value: value.trim(), domain: domain.trim() });
      }
    }
  }

  return cookies;
}

function buildCookieString(cookies) {
  // Build a semicolon-separated cookie string from name=value pairs
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║            🍪 Cobalt YouTube Cookie Extractor                ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Converts cookies.txt → cookies.json for Cobalt API          ║
║                                                              ║
║  Usage:                                                      ║
║    node scripts/extract-cookies.cjs <cookies.txt>            ║
║                                                              ║
║  Steps:                                                      ║
║    1. Install "Get cookies.txt LOCALLY" Chrome extension      ║
║    2. Log into YouTube with a BURNER Google account           ║
║    3. Go to youtube.com, export cookies via the extension     ║
║    4. Run this script with the exported file                  ║
║    5. Upload generated cookies.json to Render                ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);
    process.exit(1);
  }

  const inputPath = path.resolve(args[0]);
  
  if (!fs.existsSync(inputPath)) {
    console.error(`❌ File not found: ${inputPath}`);
    process.exit(1);
  }

  console.log(`\n🍪 Reading cookies from: ${inputPath}`);
  
  const cookies = parseCookiesTxt(inputPath);
  
  if (cookies.length === 0) {
    console.error(`\n❌ No YouTube/Google cookies found in the file.`);
    console.error(`   Make sure you exported cookies while logged into youtube.com`);
    process.exit(1);
  }

  const cookieString = buildCookieString(cookies);
  
  // Build the cookies.json in Cobalt's expected format
  const cobaltCookies = {
    youtube: [cookieString]
  };

  const outputPath = path.join(path.dirname(inputPath), 'cookies.json');
  fs.writeFileSync(outputPath, JSON.stringify(cobaltCookies, null, 2), 'utf-8');

  console.log(`\n✅ Successfully extracted ${cookies.length} cookies`);
  console.log(`📄 Output: ${outputPath}`);
  
  // Show key cookies found
  const importantCookies = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO'];
  const foundImportant = importantCookies.filter(name => cookies.some(c => c.name === name));
  const missingImportant = importantCookies.filter(name => !cookies.some(c => c.name === name));

  if (foundImportant.length > 0) {
    console.log(`\n🔑 Key cookies found: ${foundImportant.join(', ')}`);
  }
  if (missingImportant.length > 0) {
    console.log(`⚠️  Missing (may still work): ${missingImportant.join(', ')}`);
  }

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Next Steps:                                                 ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  1. Go to https://dashboard.render.com                       ║
║  2. Find your Cobalt service (my-cobalt-api-ttc2)            ║
║  3. Go to "Environment" → "Secret Files"                     ║
║  4. Add Secret File:                                         ║
║     • Filename: cookies.json                                 ║
║     • Contents: paste the contents of ${path.basename(outputPath).padEnd(20)}   ║
║     • Mount Path: /etc/cobalt/cookies.json                   ║
║  5. Add Environment Variable:                                ║
║     • Key:   COOKIE_PATH                                     ║
║     • Value: /etc/cobalt/cookies.json                        ║
║  6. Save & Redeploy                                          ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);
}

main();
