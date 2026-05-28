#!/usr/bin/env node
/**
 * Export first chapter of a WeebCentral series to PDF.
 *
 * Usage:
 *   node scrape-chapter-to-pdf.js \
 *     --series-url "https://weebcentral.com/series/.../Jigokuraku-kaku-Yuuji" \
 *     --output "jigokuraku-ch1.pdf"
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
const OUTPUT_PDF = arg('--output', 'chapter-1.pdf');
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

async function collectChapterOneImageUrls(page) {
  // Open first chapter from series page.
  await page.goto(SERIES_URL, { waitUntil: 'networkidle2', timeout: TIMEOUT });

  const firstChapterUrl = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/chapters/"]'));
    if (!links.length) return null;

    // Prefer chapter with obvious numbering = 1.
    const normalized = links.map((a) => ({
      href: a.href,
      text: (a.textContent || '').trim().toLowerCase(),
    }));

    const preferred = normalized.find(
      (l) => /chapter\s*0*1\b/.test(l.text) || /^0*1\b/.test(l.text)
    );

    return preferred?.href || normalized[normalized.length - 1].href;
  });

  if (!firstChapterUrl) {
    throw new Error('Could not find first chapter link on the series page.');
  }

  await page.goto(firstChapterUrl, { waitUntil: 'networkidle2', timeout: TIMEOUT });

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

  return { firstChapterUrl, imageUrls };
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

async function imagesToPdf(urls, outPath) {
  const doc = new PDFDocument({ autoFirstPage: false, margin: 0 });
  const output = fs.createWriteStream(outPath);
  doc.pipe(output);

  for (const imageUrl of urls) {
    const imgBuffer = await requestBuffer(imageUrl);

    const dims = await new Promise((resolve, reject) => {
      const img = doc.openImage(imgBuffer);
      if (!img) reject(new Error(`Unable to decode image: ${imageUrl}`));
      else resolve({ width: img.width, height: img.height, data: imgBuffer });
    });

    doc.addPage({ size: [dims.width, dims.height], margin: 0 });
    doc.image(dims.data, 0, 0, { width: dims.width, height: dims.height });
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

    const { firstChapterUrl, imageUrls } = await collectChapterOneImageUrls(page);
    console.log(`Found chapter: ${firstChapterUrl}`);
    console.log(`Found ${imageUrls.length} images.`);

    const outPath = path.resolve(process.cwd(), OUTPUT_PDF);
    await imagesToPdf(imageUrls, outPath);

    console.log(`Saved PDF: ${outPath}`);
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
