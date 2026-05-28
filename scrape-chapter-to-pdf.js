#!/usr/bin/env node
/**
 * Export a WeebCentral series to PDF (single chapter or full book).
 *
 * Usage:
 *   node scrape-chapter-to-pdf.js \
 *     --series-url "https://weebcentral.com/series/.../Jigokuraku-kaku-Yuuji" \
 *     --output "jigokuraku-book.pdf" --all-chapters
 *
 * Defaults to the first discovered chapter unless --all-chapters is provided.
 * Optional: --max-chapters 10
 *
 * Optional Cloudflare/session helpers:
 *   --cookies-file ./cookies.json     # Puppeteer JSON cookie array
 *   --cookie-header "a=b; c=d"       # Raw Cookie header format
 *   --user-agent "..."               # Override default browser UA
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const puppeteer = require('puppeteer');
const PDFDocument = require('pdfkit');

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

const SERIES_URL = arg('--series-url');
const OUTPUT_PDF = arg('--output', 'series.pdf');
const ALL_CHAPTERS = process.argv.includes('--all-chapters');
const MAX_CHAPTERS = Number(arg('--max-chapters', '0'));
const TIMEOUT = Number(arg('--timeout-ms', '120000'));
const COOKIES_FILE = arg('--cookies-file');
const COOKIE_HEADER = arg('--cookie-header');
const USER_AGENT = arg(
  '--user-agent',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
);

if (!SERIES_URL) {
  console.error('Missing --series-url');
  process.exit(1);
}

function requestBuffer(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;

    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36',
          Referer: `${u.origin}/`,
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirected = new URL(res.headers.location, url).toString();
          resolve(requestBuffer(redirected));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to download ${url}: HTTP ${res.statusCode}`));
          return;
        }

        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );

    req.on('error', reject);
  });
}

async function waitForImagesLoaded(page) {
  await page.evaluate(async () => {
    const imgs = Array.from(document.querySelectorAll('img'));
    await Promise.all(
      imgs.map((img) => {
        if (img.complete && img.naturalWidth > 0) return Promise.resolve();
        return new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        });
      })
    );
  });
}

async function collectChapterLinks(page) {
  // Open series page and collect chapter links.
  await page.goto(SERIES_URL, { waitUntil: 'networkidle2', timeout: TIMEOUT });

  const chapterLinks = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/chapters/"]'));
    if (!links.length) return [];

    const normalized = links.map((a) => ({
      href: a.href,
      text: (a.textContent || '').trim(),
    }));

    const seen = new Set();
    const unique = [];
    for (const item of normalized) {
      if (!seen.has(item.href)) {
        seen.add(item.href);
        unique.push(item);
      }
    }

    return unique;
  });

  if (!chapterLinks.length) {
    throw new Error('Could not find chapter links on the series page.');
  }

  return chapterLinks;
}

async function collectChapterImageUrls(page, chapterUrl) {
  await page.goto(chapterUrl, { waitUntil: 'networkidle2', timeout: TIMEOUT });

  // Scroll to force lazy-loaded pages.
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let y = 0;
      const step = 900;
      const timer = setInterval(() => {
        window.scrollTo(0, y);
        y += step;
        if (y > document.body.scrollHeight + 1200) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 80);
    });
  });

  await waitForImagesLoaded(page);

  const imageUrls = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('img'))
      .map((img) => img.currentSrc || img.src)
      .filter(Boolean)
      .filter((src) => /^https?:\/\//.test(src));

    // Keep likely manga pages, dedupe while preserving order.
    const filtered = candidates.filter((src) => /chapter|page|uploads|cdn|images/i.test(src));
    const seen = new Set();
    const result = [];
    for (const src of filtered) {
      if (!seen.has(src)) {
        seen.add(src);
        result.push(src);
      }
    }
    return result;
  });

  if (!imageUrls.length) {
    throw new Error('No chapter images found on chapter page.');
  }

  return imageUrls;
}

function parseCookieHeader(headerValue, domain) {
  return headerValue
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [name, ...rest] = pair.split('=');
      return {
        name: (name || '').trim(),
        value: rest.join('=').trim(),
        domain,
        path: '/',
      };
    })
    .filter((c) => c.name && c.value);
}


function chapterOrderValue(chapter, index) {
  const combined = `${chapter.text} ${chapter.href}`.toLowerCase();
  const match = combined.match(/chapter\s*([0-9]+(?:\.[0-9]+)?)/i) || combined.match(/\/chapters\/([0-9]+(?:\.[0-9]+)?)/i);
  if (!match) return { numeric: Number.POSITIVE_INFINITY, index };
  return { numeric: Number(match[1]), index };
}

function sortChaptersAscending(chapters) {
  return chapters
    .map((chapter, index) => ({ chapter, order: chapterOrderValue(chapter, index) }))
    .sort((a, b) => {
      if (a.order.numeric !== b.order.numeric) return a.order.numeric - b.order.numeric;
      return a.order.index - b.order.index;
    })
    .map((item) => item.chapter);
}

async function applySessionCookies(page) {
  const siteOrigin = new URL(SERIES_URL).origin;
  await page.goto(siteOrigin, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

  if (COOKIES_FILE) {
    const raw = fs.readFileSync(COOKIES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) {
      throw new Error('--cookies-file must contain a non-empty JSON cookie array.');
    }
    await page.setCookie(...parsed);
    console.log(`Applied ${parsed.length} cookies from ${COOKIES_FILE}`);
    return;
  }

  if (COOKIE_HEADER) {
    const host = new URL(SERIES_URL).hostname;
    const cookies = parseCookieHeader(COOKIE_HEADER, host);
    if (!cookies.length) {
      throw new Error('No valid cookies found in --cookie-header.');
    }
    await page.setCookie(...cookies);
    console.log(`Applied ${cookies.length} cookies from --cookie-header`);
  }
}

async function chapterSetsToPdf(chapterSets, outPath) {
  const doc = new PDFDocument({ autoFirstPage: false, margin: 0 });
  const output = fs.createWriteStream(outPath);
  doc.pipe(output);

  for (const chapter of chapterSets) {
    console.log(`Rendering ${chapter.title} (${chapter.imageUrls.length} pages)`);
    for (const imageUrl of chapter.imageUrls) {
      const imgBuffer = await requestBuffer(imageUrl);

      const dims = await new Promise((resolve, reject) => {
        const img = doc.openImage(imgBuffer);
        if (!img) reject(new Error(`Unable to decode image: ${imageUrl}`));
        else resolve({ width: img.width, height: img.height, data: imgBuffer });
      });

      doc.addPage({ size: [dims.width, dims.height], margin: 0 });
      doc.image(dims.data, 0, 0, { width: dims.width, height: dims.height });
    }
  }

  doc.end();
  await new Promise((resolve) => output.on('finish', resolve));
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    ignoreHTTPSErrors: true,
    args: [
      ...(process.getuid && process.getuid() === 0 ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
      '--ignore-certificate-errors',
    ],
  });
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(TIMEOUT);
    await page.setUserAgent(USER_AGENT);

    if (COOKIES_FILE || COOKIE_HEADER) {
      await applySessionCookies(page);
    }

    const chapterLinks = await collectChapterLinks(page);

    const sorted = sortChaptersAscending(chapterLinks);
    const selected = ALL_CHAPTERS ? sorted : [sorted[0]];
    const limited = MAX_CHAPTERS > 0 ? selected.slice(0, MAX_CHAPTERS) : selected;

    console.log(`Found ${chapterLinks.length} chapter links on series page.`);
    console.log(`Preparing ${limited.length} chapter(s) for PDF.`);

    const chapterSets = [];
    for (const chapter of limited) {
      const imageUrls = await collectChapterImageUrls(page, chapter.href);
      chapterSets.push({ title: chapter.text || chapter.href, imageUrls });
      console.log(`Collected ${imageUrls.length} images from ${chapter.href}`);
    }

    const outPath = path.resolve(process.cwd(), OUTPUT_PDF);
    await chapterSetsToPdf(chapterSets, outPath);

    console.log(`Saved PDF: ${outPath}`);
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
