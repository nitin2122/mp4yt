#!/usr/bin/env node

/**
 * grab-cookies.cjs
 * 
 * Uses Puppeteer (via Chrome DevTools Protocol) to extract cookies
 * from an already-running Chrome instance with --remote-debugging-port.
 * 
 * Usage:
 *   1. Close all Chrome windows
 *   2. Run: chrome.exe --remote-debugging-port=9222
 *   3. Log into YouTube in that browser
 *   4. Run: node scripts/grab-cookies.cjs
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function sendCDP(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const WebSocket = require('ws');
    const ws = new WebSocket(wsUrl);
    const id = 1;
    
    ws.on('open', () => {
      ws.send(JSON.stringify({ id, method, params }));
    });
    
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.close();
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
    
    ws.on('error', reject);
    setTimeout(() => { ws.close(); reject(new Error('Timeout')); }, 10000);
  });
}

async function main() {
  console.log('\n🍪 YouTube Cookie Grabber (CDP)\n');
  
  // Try to connect to Chrome DevTools
  let tabs;
  try {
    tabs = await httpGet('http://127.0.0.1:9222/json');
  } catch (e) {
    console.error('❌ Could not connect to Chrome on port 9222.');
    console.error('');
    console.error('   Please restart Chrome with remote debugging:');
    console.error('');
    console.error('   1. Close ALL Chrome windows');
    console.error('   2. Run this command:');
    console.error('      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\\tmp\\chrome-debug"');
    console.error('   3. Log into YouTube in that browser');
    console.error('   4. Run this script again');
    process.exit(1);
  }

  // Find a YouTube tab
  const ytTab = tabs.find(t => t.url && t.url.includes('youtube.com'));
  if (!ytTab) {
    console.error('❌ No YouTube tab found. Please open youtube.com in the debug Chrome instance.');
    process.exit(1);
  }

  console.log(`✅ Found YouTube tab: ${ytTab.title}`);
  console.log(`   URL: ${ytTab.url}\n`);

  // Get all cookies via CDP
  const result = await sendCDP(ytTab.webSocketDebuggerUrl, 'Network.getAllCookies');
  const allCookies = result.cookies || [];

  // Filter YouTube/Google cookies
  const ytCookies = allCookies.filter(c => 
    c.domain.includes('youtube.com') || 
    c.domain.includes('google.com') || 
    c.domain.includes('.google.')
  );

  if (ytCookies.length === 0) {
    console.error('❌ No YouTube/Google cookies found. Are you logged in?');
    process.exit(1);
  }

  // Build cookie string
  const cookieString = ytCookies.map(c => `${c.name}=${c.value}`).join('; ');

  // Build cookies.json in Cobalt's expected format
  const cobaltCookies = {
    youtube: [cookieString]
  };

  const outputPath = path.join(__dirname, '..', 'cookies.json');
  fs.writeFileSync(outputPath, JSON.stringify(cobaltCookies, null, 2), 'utf-8');

  console.log(`✅ Extracted ${ytCookies.length} cookies`);
  console.log(`📄 Saved to: ${outputPath}\n`);

  // Show key cookies
  const importantCookies = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO'];
  const foundImportant = importantCookies.filter(name => ytCookies.some(c => c.name === name));
  const missingImportant = importantCookies.filter(name => !ytCookies.some(c => c.name === name));

  if (foundImportant.length > 0) {
    console.log(`🔑 Key cookies found: ${foundImportant.join(', ')}`);
  }
  if (missingImportant.length > 0) {
    console.log(`⚠️  Missing (may still work): ${missingImportant.join(', ')}`);
  }

  console.log('\n✅ cookies.json is ready! Now upload it to Render.\n');
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
