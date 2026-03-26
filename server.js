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
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Load the inner Firebase app directly — skip the outer USPA page entirely
const EMBED_URL = 'https://infoweave-13b9d.web.app/embed/4gOIDt1q7qH90ThM7Jm8/re7F1Kzp2tnBQfUAdCDa/YWTgjBEqMLHAx3NjjJKY';

async function scrapeRecords() {
  console.log('[scrape] Launching browser...');
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 1280, height: 2000 },
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });

  try {
    const page = await browser.newPage();

    // Track Firestore responses
    const firestoreData = [];
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('firestore.googleapis.com')) {
        try {
          const text = await response.text();
          if (text.length > 20) {
            firestoreData.push({ url, text });
            console.log(`[firestore] ${url.substring(0, 100)}`);
            console.log(`[firestore] body: ${text.substring(0, 800)}`);
          }
        } catch (_) {}
      }
    });

    console.log('[scrape] Loading embed URL directly...');
    await page.goto(EMBED_URL, { waitUntil: 'networkidle0', timeout: 60000 });

    // Wait for Firebase to stream data in
    console.log('[scrape] Waiting for Firestore data...');
    await new Promise(r => setTimeout(r, 8000));

    // Log the full rendered DOM
    const html = await page.evaluate(() => document.body.innerHTML);
    console.log('[dom] length:', html.length);
    console.log('[dom] preview:', html.substring(0, 3000));

    // Try to extract records from the rendered DOM
    let records = await extractFromDOM(page);
    console.log(`[scrape] DOM extraction: ${records.length} records`);

    // If DOM extraction fails, try parsing Firestore streaming data
    if (records.length === 0 && firestoreData.length > 0) {
      console.log('[scrape] Trying Firestore stream parse...');
      records = parseFirestoreStream(firestoreData);
      console.log(`[scrape] Stream parse: ${records.length} records`);
    }

    await page.close();
    return records;
  } finally {
    await browser.close();
  }
}

async function extractFromDOM(page) {
  return await page.evaluate(() => {
    const records = [];

    // Log all text content so we can see what rendered
    const allText = document.body.innerText;
    console.log('innerText length:', allText.length);

    // Try standard HTML tables
    document.querySelectorAll('table').forEach((table, ti) => {
      const headers = [...table.querySelectorAll('thead th, thead td, tr:first-child th, tr:first-child td')]
        .map(h => h.textContent.trim().toLowerCase().replace(/\s+/g, '_'));
      console.log(`table[${ti}] headers:`, headers.join(', '));

      table.querySelectorAll('tbody tr, tr:not(:first-child)').forEach(tr => {
        const cells = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
        if (cells.length < 2) return;
        const row = {};
        headers.forEach((h, i) => { if (cells[i] !== undefined) row[h] = cells[i]; });
        if (Object.keys(row).length > 0) records.push(row);
      });
    });

    // Try any element with class containing "record" or "row"
    if (records.length === 0) {
      const rowEls = document.querySelectorAll('[class*="record"], [class*="row"], [class*="item"], [class*="entry"]');
      console.log('row-like elements:', rowEls.length);
      rowEls.forEach(el => {
        const text = el.textContent.trim();
        if (text.length > 10 && text.length < 500) {
          records.push({ raw_text: text });
        }
      });
    }

    // Log all class names present to understand the app structure
    const allClasses = [...new Set([...document.querySelectorAll('[class]')].map(el => el.className).join(' ').split(/\s+/).filter(Boolean))];
    console.log('all classes:', allClasses.join(', '));

    return records;
  });
}

// Parse Firestore's chunked streaming format
// Format: <length>\n[[id,[type,...]], ...]
function parseFirestoreStream(responses) {
  const records = [];
  for (const { text } of responses) {
    // Strip the leading number (byte count)
    const lines = text.split('\n').filter(l => l.trim());
    for (const line of lines) {
      if (!line.startsWith('[') && !line.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(line);
        const found = walkForRecords(parsed);
        records.push(...found);
      } catch (_) {}
    }
  }
  return records;
}

function walkForRecords(obj) {
  const records = [];
  if (!obj || typeof obj !== 'object') return records;

  // Check if this looks like a Firestore document with fields
  if (obj.fields && typeof obj.fields === 'object') {
    const f = obj.fields;
    const get = (k) => {
      const v = f[k];
      if (!v) return '';
      return v.stringValue ?? v.integerValue ?? v.doubleValue ?? v.booleanValue ?? '';
    };
    console.log('[firestore-doc] fields:', Object.keys(f).join(', '));
    records.push({
      division:    get('division') || get('div') || get('age_class') || '',
      gender:      get('gender') || get('sex') || '',
      weightClass: get('weightClass') || get('weight_class') || get('wc') || '',
      name:        get('lifterName') || get('name') || get('lifter') || '',
      squat:       parseFloat(get('squat') || get('sq') || 0) || 0,
      bench:       parseFloat(get('bench') || get('bp') || 0) || 0,
      deadlift:    parseFloat(get('deadlift') || get('dl') || 0) || 0,
      total:       parseFloat(get('total') || 0) || 0,
      date:        get('date') || get('meetDate') || '',
      meet:        get('meet') || get('meetName') || get('competition') || '',
    });
    return records;
  }

  // Recurse into arrays and objects
  if (Array.isArray(obj)) {
    obj.forEach(item => records.push(...walkForRecords(item)));
  } else {
    Object.values(obj).forEach(val => records.push(...walkForRecords(val)));
  }
  return records;
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', cached: !!cachedRecords, recordCount: cachedRecords?.length ?? 0 });
});

app.get('/records', async (req, res) => {
  try {
    if (cachedRecords && cacheTime && (Date.now() - cacheTime) < CACHE_TTL_MS) {
      return res.json({ records: cachedRecords, cached: true, cacheAge: Math.round((Date.now() - cacheTime) / 1000) + 's' });
    }
    const records = await scrapeRecords();
    if (records.length === 0) {
      return res.status(503).json({ error: 'No records found — check Render logs for [dom] and [firestore] output.' });
    }
    cachedRecords = records;
    cacheTime = Date.now();
    res.json({ records, cached: false });
  } catch (err) {
    console.error('[error]', err.message);
    if (cachedRecords) return res.json({ records: cachedRecords, cached: true, stale: true });
    res.status(500).json({ error: err.message });
  }
});

app.post('/refresh', async (req, res) => {
  cachedRecords = null; cacheTime = null;
  try {
    const records = await scrapeRecords();
    cachedRecords = records; cacheTime = Date.now();
    res.json({ ok: true, recordCount: records.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`USPA proxy on port ${PORT}`));
