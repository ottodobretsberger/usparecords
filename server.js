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
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const EMBED_URL = 'https://infoweave-13b9d.web.app/embed/4gOIDt1q7qH90ThM7Jm8/re7F1Kzp2tnBQfUAdCDa/YWTgjBEqMLHAx3NjjJKY';

// ─── SCRAPE ───────────────────────────────────────────────────────────────────
async function scrapeRecords() {
  if (scrapeInProgress) {
    console.log('[scrape] Already in progress, waiting...');
    await new Promise(resolve => {
      const check = setInterval(() => {
        if (!scrapeInProgress) { clearInterval(check); resolve(); }
      }, 1000);
      setTimeout(() => { clearInterval(check); resolve(); }, 120000);
    });
    return cachedRecords || [];
  }

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

    console.log('[scrape] Waiting 6s for initial render...');
    await new Promise(r => setTimeout(r, 6000));

    // Expand all divisions
    await page.evaluate(() => {
      document.querySelectorAll('*').forEach(el => {
        try { if (window.getComputedStyle(el).cursor === 'pointer') el.click(); } catch (_) {}
      });
    });

    console.log('[scrape] Waiting 8s for expanded data...');
    await new Promise(r => setTimeout(r, 8000));

    // Parse directly from DOM — walk hierarchy-depth-0 → depth-1 → table
    const records = await page.evaluate(() => {
      const results = [];

      // Each .hierarchy-depth-0 div = one division (e.g. "OPEN MEN")
      document.querySelectorAll('.hierarchy-depth-0').forEach(depth0 => {
        // Get the label text: "OPEN MEN", "MASTER 1 WOMEN", etc.
        const labelEl = depth0.querySelector('.hierarchy-label');
        if (!labelEl) return;
        const labelText = labelEl.textContent.replace('keyboard_arrow_down', '').replace('keyboard_arrow_right', '').trim();

        // Parse gender and division from label
        const genderMatch = labelText.match(/\b(MEN|WOMEN)\b/i);
        if (!genderMatch) return;
        const gender = genderMatch[1].toUpperCase() === 'MEN' ? 'Men' : 'Women';
        const division = labelText.replace(/\b(MEN|WOMEN)\b/i, '').trim();
        const divisionClean = division.replace(/\b\w/g, c => c.toUpperCase()).trim() || 'Open';

        // Each .hierarchy-depth-1 = one weight class row
        depth0.querySelectorAll('.hierarchy-depth-1').forEach(depth1 => {
          const wcLabel = depth1.querySelector('.hierarchy-label');
          if (!wcLabel) return;
          // Weight class label: "52kg/114.5lb" → extract "52"
          const wcText = wcLabel.textContent.trim();
          const wcMatch = wcText.match(/^(\d+(?:\.\d+)?(?:\+)?)\s*kg/i);
          if (!wcMatch) return;
          const weightClass = wcMatch[1] + (wcText.includes('+') ? '+' : '');

          // The horizontal table has 4 cells: Squat, Bench, Deadlift, Total
          const table = depth1.querySelector('table.hierarchy-horizontal-table');
          if (!table) return;

          const liftMap = {};
          table.querySelectorAll('td').forEach(td => {
            const nameEl  = td.querySelector('.mb-5.bold');
            const liftEl  = td.querySelector('.mb-5:not(.bold)');
            const weightEl = td.querySelector('div:not(.mb-5):not([style*="margin-bottom"])');

            // Get weight from the div that contains "kgs"
            let kg = 0;
            td.querySelectorAll('div').forEach(div => {
              if (div.children.length === 0 && div.textContent.includes('kgs')) {
                const m = div.textContent.match(/([\d.]+)\s*kgs/i);
                if (m) kg = parseFloat(m[1]);
              }
            });

            const name = nameEl ? nameEl.textContent.trim() : '';
            const liftDate = liftEl ? liftEl.textContent.trim() : '';
            const liftTypeMatch = liftDate.match(/^(Squat|Bench|Deadlift|TOTAL)\s*-\s*(.+)$/i);
            if (!liftTypeMatch || !name || kg === 0) return;

            const liftType = liftTypeMatch[1].toLowerCase();
            const date = liftTypeMatch[2].trim();
            liftMap[liftType] = { name, kg, date };
          });

          if (Object.keys(liftMap).length > 0) {
            results.push({
              gender,
              division: divisionClean,
              weightClass,
              name_squat:    liftMap.squat?.name     || '',
              squat:         liftMap.squat?.kg        || 0,
              date_squat:    liftMap.squat?.date      || '',
              name_bench:    liftMap.bench?.name      || '',
              bench:         liftMap.bench?.kg        || 0,
              date_bench:    liftMap.bench?.date      || '',
              name_deadlift: liftMap.deadlift?.name   || '',
              deadlift:      liftMap.deadlift?.kg     || 0,
              date_deadlift: liftMap.deadlift?.date   || '',
              name_total:    liftMap.total?.name      || '',
              total:         liftMap.total?.kg        || 0,
              date_total:    liftMap.total?.date      || '',
            });
          }
        });
      });

      return results;
    });

    console.log(`[scrape] Parsed ${records.length} records`);
    if (records[0]) console.log('[scrape] Sample:', JSON.stringify(records[0]));
    if (records[1]) console.log('[scrape] Sample2:', JSON.stringify(records[1]));

    await page.close();
    return records;

  } finally {
    await browser.close();
    scrapeInProgress = false;
  }
}

// ─── WARM CACHE ON STARTUP ────────────────────────────────────────────────────
async function warmCache() {
  try {
    console.log('[warmup] Starting background scrape...');
    const records = await scrapeRecords();
    if (records.length > 0) {
      cachedRecords = records;
      cacheTime = Date.now();
      console.log(`[warmup] Cache warmed with ${records.length} records`);
    }
  } catch (err) {
    console.error('[warmup] Error:', err.message);
  }
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    cached: !!cachedRecords,
    recordCount: cachedRecords?.length ?? 0,
    cacheAge: cacheTime ? Math.round((Date.now() - cacheTime) / 1000) + 's' : null,
  });
});

app.get('/records', async (req, res) => {
  try {
    if (cachedRecords && cacheTime && (Date.now() - cacheTime) < CACHE_TTL_MS) {
      console.log(`[cache] Serving ${cachedRecords.length} cached records`);
      return res.json({ records: cachedRecords, cached: true, cacheAge: Math.round((Date.now() - cacheTime) / 1000) + 's' });
    }
    if (scrapeInProgress) {
      // Wait for in-progress scrape
      await new Promise(resolve => {
        const check = setInterval(() => {
          if (!scrapeInProgress) { clearInterval(check); resolve(); }
        }, 1000);
        setTimeout(() => { clearInterval(check); resolve(); }, 120000);
      });
      if (cachedRecords) return res.json({ records: cachedRecords, cached: true });
    }
    const records = await scrapeRecords();
    if (records.length === 0) {
      if (cachedRecords) return res.json({ records: cachedRecords, cached: true, stale: true });
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
  cachedRecords = null;
  cacheTime = null;
  try {
    const records = await scrapeRecords();
    cachedRecords = records;
    cacheTime = Date.now();
    res.json({ ok: true, recordCount: records.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`USPA proxy on port ${PORT}`);
  setTimeout(warmCache, 3000);
});
