const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

let cachedRecords = null;
let cacheTime = null;
let scrapeInProgress = false;
const CACHE_TTL_MS = 60 * 60 * 1000;

const EMBED_URL = 'https://infoweave-13b9d.web.app/embed/4gOIDt1q7qH90ThM7Jm8/re7F1Kzp2tnBQfUAdCDa/YWTgjBEqMLHAx3NjjJKY';

async function scrapeRecords() {
  if (scrapeInProgress) return cachedRecords || [];
  scrapeInProgress = true;

  console.log('[scrape] Launching browser...');
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 1280, height: 2000 },
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });

  try {
    const page = await browser.newPage();
    await page.goto(EMBED_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log('[scrape] Waiting 6s...');
    await new Promise(r => setTimeout(r, 6000));

    await page.evaluate(() => {
      document.querySelectorAll('*').forEach(el => {
        try { if (window.getComputedStyle(el).cursor === 'pointer') el.click(); } catch (_) {}
      });
    });

    console.log('[scrape] Waiting 8s after clicks...');
    await new Promise(r => setTimeout(r, 8000));

    // Get the raw innerText AND a structured dump of the actual DOM
    const result = await page.evaluate(() => {
      const innerText = document.body.innerText;

      // Also get the HTML of just the first expanded division so we can
      // see the EXACT whitespace/structure of one weight class block
      const firstTable = document.querySelector('table.hierarchy-horizontal-table');
      const firstTableHTML = firstTable ? firstTable.outerHTML : 'NO TABLE FOUND';

      // Get the parent hierarchy around the first table
      let parent = firstTable?.parentElement;
      let contextHTML = '';
      for (let i = 0; i < 8 && parent && parent !== document.body; i++) {
        contextHTML = parent.outerHTML.substring(0, 3000);
        parent = parent.parentElement;
      }

      // Get ALL text split by newlines so we can see exact tokens
      const lines = innerText.split('\n').map((l, i) => `${i}: ${JSON.stringify(l)}`).slice(0, 120);

      return { innerText: innerText.substring(0, 500), lines: lines.join('\n'), firstTableHTML: firstTableHTML.substring(0, 2000), contextHTML: contextHTML.substring(0, 3000) };
    });

    console.log('[debug] innerText start:', result.innerText);
    console.log('[debug] first 120 lines:\n', result.lines);
    console.log('[debug] firstTableHTML:', result.firstTableHTML);
    console.log('[debug] contextHTML:', result.contextHTML);

    await page.close();
    return [];
  } finally {
    await browser.close();
    scrapeInProgress = false;
  }
}

async function warmCache() {
  try {
    console.log('[warmup] Starting debug scrape...');
    await scrapeRecords();
  } catch (err) {
    console.error('[warmup] Error:', err.message);
  }
}

app.get('/', (req, res) => res.json({ status: 'ok', mode: 'debug' }));
app.get('/records', async (req, res) => {
  await scrapeRecords();
  res.json({ records: [], debug: true });
});

app.listen(PORT, () => {
  console.log(`USPA proxy debug mode on port ${PORT}`);
  setTimeout(warmCache, 3000);
});
