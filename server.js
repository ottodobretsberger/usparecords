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
const CACHE_TTL_MS = 60 * 60 * 1000;

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

    // Collect ALL network responses (not just Firestore)
    const allResponses = [];
    page.on('response', async (response) => {
      const url = response.url();
      const status = response.status();
      const ct = response.headers()['content-type'] || '';
      // Skip fonts, images, css
      if (url.includes('fonts.g') || url.includes('.woff') || url.includes('.png') || url.includes('.css')) return;
      try {
        const text = await response.text();
        allResponses.push({ url, status, ct, text });
        console.log(`[net] ${status} ${ct.split(';')[0].padEnd(20)} ${url.substring(0, 100)}`);
        if (text.length > 10 && text.length < 50000) {
          console.log(`[net-body] ${text.substring(0, 600)}`);
        }
      } catch (_) {}
    });

    console.log('[scrape] Navigating to embed...');
    await page.goto(EMBED_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Phase 1: wait for initial render
    console.log('[scrape] Phase 1: waiting 6s for initial render...');
    await new Promise(r => setTimeout(r, 6000));

    // Log DOM state
    const dom1 = await page.evaluate(() => ({
      bodyLen: document.body.innerHTML.length,
      innerText: document.body.innerText.substring(0, 1000),
      allClasses: [...new Set([...document.querySelectorAll('[class]')].flatMap(el => [...el.classList]))].join(', '),
      tableCount: document.querySelectorAll('table').length,
      divCount: document.querySelectorAll('div').length,
      clickableText: [...document.querySelectorAll('div, li, button, h2, h3, span')].map(el => el.textContent.trim()).filter(t => t.length > 2 && t.length < 60).slice(0, 40),
    }));
    console.log('[dom1] bodyLen:', dom1.bodyLen);
    console.log('[dom1] innerText:', dom1.innerText);
    console.log('[dom1] classes:', dom1.allClasses);
    console.log('[dom1] tables:', dom1.tableCount, 'divs:', dom1.divCount);
    console.log('[dom1] clickable text items:', JSON.stringify(dom1.clickableText));

    // Phase 2: try clicking everything that looks like a division header
    console.log('[scrape] Phase 2: clicking division headers...');
    const clicked = await page.evaluate(() => {
      const clicked = [];
      // Click anything with text that looks like a division name
      document.querySelectorAll('div, li, button, span, h2, h3, p').forEach(el => {
        const text = el.textContent.trim();
        if (
          text.length > 2 && text.length < 80 &&
          (text.match(/men|women|open|master|junior|teen|sub/i) ||
           text.match(/^\d+(\.\d+)?\s*(kg|\+)?$/) )
        ) {
          try { el.click(); clicked.push(text); } catch (_) {}
        }
      });
      return clicked;
    });
    console.log('[scrape] Clicked:', clicked.join(' | '));

    // Phase 3: wait for data to load after clicks
    console.log('[scrape] Phase 3: waiting 8s for data after clicks...');
    await new Promise(r => setTimeout(r, 8000));

    // Log DOM state again
    const dom2 = await page.evaluate(() => ({
      bodyLen: document.body.innerHTML.length,
      innerText: document.body.innerText.substring(0, 2000),
      tableCount: document.querySelectorAll('table').length,
      tableHTML: [...document.querySelectorAll('table')].map(t => t.outerHTML.substring(0, 500)).join('\n---\n'),
      allText: [...document.querySelectorAll('td, th, [class*="record"], [class*="lift"], [class*="result"]')].map(el => el.textContent.trim()).filter(Boolean).join(' | ').substring(0, 2000),
    }));
    console.log('[dom2] bodyLen:', dom2.bodyLen);
    console.log('[dom2] innerText:', dom2.innerText);
    console.log('[dom2] tables:', dom2.tableCount);
    console.log('[dom2] tableHTML:', dom2.tableHTML);
    console.log('[dom2] record elements text:', dom2.allText);

    // Phase 4: try clicking MORE specifically - scroll and click each item
    if (dom2.tableCount === 0) {
      console.log('[scrape] Phase 4: no tables yet, trying aggressive expand...');
      await page.evaluate(() => {
        // Try every single clickable element
        document.querySelectorAll('*').forEach(el => {
          const style = window.getComputedStyle(el);
          if (style.cursor === 'pointer') {
            try { el.click(); } catch (_) {}
          }
        });
      });
      await new Promise(r => setTimeout(r, 6000));

      const dom3 = await page.evaluate(() => ({
        bodyLen: document.body.innerHTML.length,
        innerText: document.body.innerText.substring(0, 3000),
        tableCount: document.querySelectorAll('table').length,
        fullHTML: document.body.innerHTML.substring(0, 5000),
      }));
      console.log('[dom3] bodyLen:', dom3.bodyLen);
      console.log('[dom3] innerText:', dom3.innerText);
      console.log('[dom3] tables:', dom3.tableCount);
      console.log('[dom3] fullHTML:', dom3.fullHTML);
    }

    // Extract whatever we can find
    const records = await page.evaluate(() => {
      const records = [];

      // Tables
      document.querySelectorAll('table').forEach((table, ti) => {
        const headerRow = table.querySelector('thead tr, tr:first-child');
        const headers = headerRow
          ? [...headerRow.querySelectorAll('th, td')].map(h => h.textContent.trim().toLowerCase().replace(/[\s/]+/g, '_'))
          : [];
        console.log(`table[${ti}] headers: ${headers.join(', ')}`);

        const bodyRows = table.querySelectorAll('tbody tr') || table.querySelectorAll('tr:not(:first-child)');
        bodyRows.forEach(tr => {
          const cells = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
          if (cells.length < 2) return;
          const row = { _source: 'table' };
          if (headers.length) {
            headers.forEach((h, i) => { if (cells[i] !== undefined) row[h] = cells[i]; });
          } else {
            cells.forEach((c, i) => { row[`col_${i}`] = c; });
          }
          records.push(row);
        });
      });

      // Fallback: grab all text nodes that look like structured data
      if (records.length === 0) {
        document.querySelectorAll('[class]').forEach(el => {
          const cls = el.className;
          if (typeof cls === 'string' && (cls.includes('row') || cls.includes('record') || cls.includes('item') || cls.includes('entry') || cls.includes('result'))) {
            const cells = [...el.querySelectorAll('span, div, td, p')].map(c => c.textContent.trim()).filter(Boolean);
            if (cells.length >= 3) records.push({ _source: 'div', _class: cls, cells: cells.join(' | ') });
          }
        });
      }

      return records;
    });

    console.log(`[scrape] Extracted ${records.length} records`);
    if (records.length > 0) console.log('[scrape] Sample:', JSON.stringify(records[0]));

    await page.close();
    return records.map(normalizeRecord).filter(Boolean);

  } finally {
    await browser.close();
  }
}

function normalizeRecord(item) {
  if (!item || typeof item !== 'object') return null;
  const get = (...keys) => {
    for (const k of keys) {
      const found = Object.keys(item).find(ik => ik.toLowerCase() === k.toLowerCase());
      if (found && item[found] !== undefined && item[found] !== '') return item[found];
    }
    return '';
  };
  const name  = get('lifterName','lifter_name','name','athlete','lifter');
  const total = parseFloat(get('total')) || 0;
  const squat = parseFloat(get('squat','sq','best_squat')) || 0;
  const bench = parseFloat(get('bench','bp','bench_press')) || 0;
  const dl    = parseFloat(get('deadlift','dl','best_deadlift')) || 0;
  if (!name && !total && !squat) return null;
  return {
    division:    String(get('division','div','age_class','age_division')),
    gender:      String(get('gender','sex')),
    weightClass: String(get('weightClass','weight_class','wc','bodyweight','bwt')),
    name:        String(name),
    squat, bench, deadlift: dl,
    total:       total || squat + bench + dl,
    date:        String(get('date','meetDate','meet_date','date_set')),
    meet:        String(get('meet','meetName','meet_name','competition')),
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
      return res.status(503).json({ error: 'No records parsed — check Render logs.' });
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
