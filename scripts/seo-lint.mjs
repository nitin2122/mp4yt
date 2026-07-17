// scripts/seo-lint.mjs — Run with: node scripts/seo-lint.mjs
// Validates page titles and meta descriptions against SERP display limits.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const TITLE_MAX_CHARS = 60;
const TITLE_MIN_CHARS = 30;
const DESC_MAX_CHARS = 155;

const pagesDir = 'src/pages';
const files = readdirSync(pagesDir).filter(f => f.endsWith('.astro'));

const issues = [];
const results = [];

for (const file of files) {
  const content = readFileSync(join(pagesDir, file), 'utf-8');

  // Skip redirect stubs (they have no title/description)
  if (content.includes('Astro.redirect')) continue;

  // Extract title="..." from Layout props
  const titleMatch = content.match(/title="([^"]+)"/);
  if (titleMatch) {
    const title = titleMatch[1].replace(/&amp;/g, '&');
    const len = title.length;
    let status = '✅';

    if (len > TITLE_MAX_CHARS) {
      status = '⚠️  TOO LONG';
      issues.push(`⚠️  ${file}: Title too long (${len}/${TITLE_MAX_CHARS} chars)\n   "${title}"`);
    } else if (len < TITLE_MIN_CHARS) {
      status = '📏 TOO SHORT';
      issues.push(`📏 ${file}: Title too short (${len}/${TITLE_MIN_CHARS} chars)\n   "${title}"`);
    }

    results.push({ file, type: 'title', value: title, len, limit: TITLE_MAX_CHARS, status });
  }

  // Extract description="..." from Layout props (first occurrence only)
  const descMatch = content.match(/^\s*description="([^"]+)"/m);
  if (descMatch) {
    const desc = descMatch[1].replace(/&amp;/g, '&');
    const len = desc.length;
    let status = '✅';

    if (len > DESC_MAX_CHARS) {
      status = '⚠️  TOO LONG';
      issues.push(`⚠️  ${file}: Description too long (${len}/${DESC_MAX_CHARS} chars)\n   "${desc}"`);
    }

    results.push({ file, type: 'desc', value: desc, len, limit: DESC_MAX_CHARS, status });
  }
}

// Print table
console.log('\n📊 SEO Lint Report — Title & Description Lengths\n');
console.log('─'.repeat(90));
console.log(`${'File'.padEnd(30)} ${'Type'.padEnd(8)} ${'Len'.padStart(4)} ${'Limit'.padStart(6)}  Status`);
console.log('─'.repeat(90));

for (const r of results) {
  console.log(
    `${r.file.padEnd(30)} ${r.type.padEnd(8)} ${String(r.len).padStart(4)} ${String(r.limit).padStart(6)}  ${r.status}`
  );
}

console.log('─'.repeat(90));

if (issues.length === 0) {
  console.log('\n✅ All titles and descriptions within limits.\n');
} else {
  console.log(`\n🔍 ${issues.length} issue(s) found:\n`);
  issues.forEach(i => console.log(i + '\n'));
  process.exit(1);
}
