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
const CACHE_TTL_MS = 1000 * 60 * 60;

const TARGET_URL = 'https://records.uspa.net/records.php?location=ipl-world&status=drug-tested&event=raw-powerlifting';

async function scrapeRecords() {
  console.log('[scrape] Launching browser...');
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });

  try {
    const page = await browser.newPage();
    const capturedResponses = [];

    page.on('response', async (response) => {
      const url = response.url();
      const ct = response.headers()['content-type'] || '';
      if (ct.includes('json') || url.includes('firestore') || url.includes('firebase') || url.includes('googleapis') || url.includes('embedloader')) {
        try {
          const text = await response.text();
          capturedResponses.push({ url, status: response.status(), text });
          console.log(`[net] ${response.status()} ${url.substring(0, 120)}`);
          console.log(`[net] preview: ${text.substring(0, 600)}`);
        } catch (e) {
          console.log(`[net] body read error for ${url}: ${e.message}`);
        }
      }
    });

    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 5000));

    // Log DOM and iframes
    const bodyPreview = await page.evaluate(() => document.body.innerHTML.substring(0, 3000));
    console.log('[dom]', bodyPreview);

    const scripts = await page.evaluate(() =>
      [...document.querySelectorAll('script[src], iframe[src]')].map(e => e.src || e.getAttribute('src'))
    );
    console.log('[scripts/iframes]', JSON.stringify(scripts));

    // Try clicking divs that look like accordion headers
    try {
      await page.evaluate(() => {
        document.querySelectorAll('div, section, li').forEach(el => {
          if (el.children.length < 5) el.click();
        });
      });
      await new Promise(r => setTimeout(r, 3000));
    } catch (_) {}

    // Second wave of responses after clicking
    const bodyAfter = await page.evaluate(() => document.body.innerHTML.substring(0, 3000));
    console.log('[dom-after-click]', bodyAfter);

    console.log(`[scrape] ${capturedResponses.length} network responses captured`);
    capturedResponses.forEach(({url, text}) => {
      console.log(`[full-response] URL: ${url}`);
      console.log(`[full-response] Body (1200 chars): ${text.substring(0, 1200)}`);
    });

    const allRecords = [];
    for (const { url, text } of capturedResponses) {
      const parsed = tryParseRecords(url, text);
      if (parsed.length > 0) {
        console.log(`[parse] ${parsed.length} records from ${url.substring(0, 80)}`);
        allRecords.push(...parsed);
      }
    }

    await page.close();
    console.log(`[scrape] Total: ${allRecords.length}`);
    return allRecords;
  } finally {
    await browser.close();
  }
}

function tryParseRecords(url, text) {
  if (!text || text.length < 10) return [];
  let json;
  try { json = JSON.parse(text); } catch (_) { return []; }

  const records = [];

  // Log full structure for any object
  if (typeof json === 'object' && !Array.isArray(json)) {
    console.log(`[shape] keys: ${Object.keys(json).join(', ')}`);
  }

  // Firestore REST: { documents: [...] }
  if (json.documents && Array.isArray(json.documents)) {
    console.log(`[shape] Firestore REST, ${json.documents.length} docs`);
    json.documents.forEach(doc => {
      if (doc.fields) {
        console.log(`[shape] doc fields: ${Object.keys(doc.fields).join(', ')}`);
        records.push(...firestoreDocToRecord(doc));
      }
    });
    return records;
  }

  // Firestore runQuery: [{ document: {...} }]
  if (Array.isArray(json)) {
    console.log(`[shape] array of ${json.length}, first keys: ${json[0] ? Object.keys(json[0]).join(', ') : 'empty'}`);
    json.forEach(item => {
      if (item && item.document && item.document.fields) {
        console.log(`[shape] runQuery doc fields: ${Object.keys(item.document.fields).join(', ')}`);
        records.push(...firestoreDocToRecord(item.document));
      } else if (item && typeof item === 'object') {
        const r = flexRecord(item);
        if (r) records.push(r);
      }
    });
    return records;
  }

  // Any other object — try all array-valued keys
  if (typeof json === 'object') {
    for (const key of Object.keys(json)) {
      if (Array.isArray(json[key]) && json[key].length > 0) {
        console.log(`[shape] key "${key}" has ${json[key].length} items, first: ${JSON.stringify(json[key][0]).substring(0, 200)}`);
        json[key].forEach(item => {
          if (item && item.document) records.push(...firestoreDocToRecord(item.document));
          else { const r = flexRecord(item); if (r) records.push(r); }
        });
      }
    }
  }

  return records;
}

function firestoreDocToRecord(doc) {
  if (!doc || !doc.fields) return [];
  const f = doc.fields;
  const get = (k) => {
    const v = f[k];
    if (!v) return '';
    return v.stringValue ?? v.integerValue ?? v.doubleValue ?? v.booleanValue ?? '';
  };
  console.log('[firestore fields]', Object.keys(f).join(', '));
  return [{
    division:    get('division') || get('div') || get('age_class') || get('ageClass') || '',
    gender:      get('gender') || get('sex') || '',
    weightClass: get('weightClass') || get('weight_class') || get('wc') || get('bodyweight') || '',
    name:        get('lifterName') || get('name') || get('lifter') || get('athlete') || '',
    squat:       parseFloat(get('squat') || get('sq') || get('best_squat') || 0) || 0,
    bench:       parseFloat(get('bench') || get('bp') || get('best_bench') || 0) || 0,
    deadlift:    parseFloat(get('deadlift') || get('dl') || get('best_deadlift') || 0) || 0,
    total:       parseFloat(get('total') || 0) || 0,
    date:        get('date') || get('meetDate') || get('meet_date') || '',
    meet:        get('meet') || get('meetName') || get('meet_name') || get('competition') || '',
  }];
}

function flexRecord(item) {
  if (!item || typeof item !== 'object') return null;
  const get = (...candidates) => {
    for (const c of candidates) {
      for (const k of Object.keys(item)) {
        if (k.toLowerCase() === c.toLowerCase()) return item[k];
      }
    }
    return '';
  };
  const name = get('name','lifter','lifterName','athlete');
  const total = parseFloat(get('total')) || 0;
  const squat = parseFloat(get('squat','sq','best_squat')) || 0;
  if (!name && !total && !squat) return null;
  return {
    division:    get('division','div','age_class','ageClass'),
    gender:      get('gender','sex'),
    weightClass: String(get('weightClass','weight_class','wc','bodyweight','bwt')),
    name:        String(name),
    squat,
    bench:       parseFloat(get('bench','bp','best_bench')) || 0,
    deadlift:    parseFloat(get('deadlift','dl','best_deadlift')) || 0,
    total,
    date:        get('date','meetDate','meet_date'),
    meet:        get('meet','meetName','meet_name','competition'),
  };
}

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
      return res.status(503).json({ error: 'No records parsed — check Render logs for [shape] and [full-response] output.' });
    }
    cachedRecords = records;
    cacheTime = Date.now();
    res.json({ records, cached: false });
  } catch (err) {
    console.error('[error]', err);
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
