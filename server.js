const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow requests from any origin (so your HTML page can call this)
app.use(cors());
app.use(express.json());

// Cache records in memory so we don't re-scrape on every request
let cachedRecords = null;
let cacheTime = null;
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour

// The USPA embed URLs to scrape — add more as needed
const EMBED_CONFIGS = [
  {
    label: 'IPL World · Raw Full Power · Drug Tested',
    url: 'https://records.uspa.net/records.php?location=ipl-world&status=drug-tested&event=raw-powerlifting',
    location: 'ipl-world',
    status: 'drug-tested',
    event: 'raw-powerlifting',
  },
];

// ─── SCRAPE ──────────────────────────────────────────────────────────────────
async function scrapeRecords() {
  console.log('[scrape] Launching browser…');

  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });

  const allRecords = [];

  try {
    for (const config of EMBED_CONFIGS) {
      console.log(`[scrape] Loading: ${config.url}`);
      const page = await browser.newPage();

      // Collect all XHR/fetch responses that look like Firestore data
      const firestoreResponses = [];

      page.on('response', async (response) => {
        const url = response.url();
        if (
          url.includes('firestore.googleapis.com') ||
          url.includes('firebase') ||
          url.includes('embedloader')
        ) {
          try {
            const text = await response.text();
            firestoreResponses.push({ url, text });
          } catch (_) {}
        }
      });

      // Load the page and wait for the embed to render
      await page.goto(config.url, { waitUntil: 'networkidle2', timeout: 30000 });

      // Wait a bit for any lazy-loaded content
      await new Promise(r => setTimeout(r, 3000));

      // Try to expand all division sections (click them)
      try {
        const expandables = await page.$$('[class*="division"], [class*="accordion"], [class*="expand"], details');
        for (const el of expandables) {
          try { await el.click(); } catch (_) {}
        }
        await new Promise(r => setTimeout(r, 1500));
      } catch (_) {}

      // Extract table data from the rendered DOM
      const tableRecords = await page.evaluate((cfg) => {
        const rows = [];

        // Try standard HTML tables first
        document.querySelectorAll('table').forEach(table => {
          const headers = [...table.querySelectorAll('thead th, thead td')]
            .map(h => h.textContent.trim().toLowerCase());

          table.querySelectorAll('tbody tr').forEach(tr => {
            const cells = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
            if (cells.length < 3) return;

            const row = {
              location: cfg.location,
              status: cfg.status,
              event: cfg.event,
            };

            // Map cells to fields using headers if available
            if (headers.length) {
              headers.forEach((h, i) => {
                if (cells[i] !== undefined) row[h] = cells[i];
              });
            } else {
              // Fallback: try to guess by position
              row.raw = cells;
            }
            rows.push(row);
          });
        });

        // Also try list/div-based layouts
        document.querySelectorAll('[class*="record-row"], [class*="recordRow"], [class*="record_row"]').forEach(el => {
          rows.push({ raw_text: el.textContent.trim(), location: cfg.location, status: cfg.status, event: cfg.event });
        });

        return rows;
      }, config);

      console.log(`[scrape] Found ${tableRecords.length} table rows, ${firestoreResponses.length} Firebase responses`);

      // Parse Firebase JSON responses
      let parsedFromFirebase = false;
      for (const { url, text } of firestoreResponses) {
        try {
          const json = JSON.parse(text);
          const parsed = parseFirestoreResponse(json, config);
          if (parsed.length > 0) {
            allRecords.push(...parsed);
            parsedFromFirebase = true;
            console.log(`[scrape] Parsed ${parsed.length} records from Firebase response`);
          }
        } catch (_) {}
      }

      // Fall back to table data if Firebase parsing didn't work
      if (!parsedFromFirebase && tableRecords.length > 0) {
        const normalized = tableRecords.map(r => normalizeTableRow(r, config));
        allRecords.push(...normalized.filter(Boolean));
        console.log(`[scrape] Using ${normalized.length} table-scraped records`);
      }

      await page.close();
    }
  } finally {
    await browser.close();
  }

  console.log(`[scrape] Total records: ${allRecords.length}`);
  return allRecords;
}

// ─── PARSERS ─────────────────────────────────────────────────────────────────
function parseFirestoreResponse(json, config) {
  const records = [];

  // Handle Firestore REST API response shape
  const docs = json.documents || (Array.isArray(json) ? json : []);
  docs.forEach(doc => {
    const f = doc.fields || doc;
    const get = (k) => {
      const v = f[k];
      if (!v) return '';
      if (typeof v === 'object') {
        return v.stringValue ?? v.integerValue ?? v.doubleValue ?? v.booleanValue ?? '';
      }
      return v;
    };

    records.push({
      division:    get('division') || get('div') || '',
      gender:      get('gender') || get('sex') || '',
      weightClass: get('weightClass') || get('weight_class') || get('wc') || '',
      name:        get('lifterName') || get('name') || get('lifter') || '',
      squat:       parseFloat(get('squat') || get('sq') || 0) || 0,
      bench:       parseFloat(get('bench') || get('bp') || 0) || 0,
      deadlift:    parseFloat(get('deadlift') || get('dl') || 0) || 0,
      total:       parseFloat(get('total') || 0) || 0,
      date:        get('date') || get('meetDate') || '',
      meet:        get('meet') || get('meetName') || get('competition') || '',
      location:    config.location,
      status:      config.status,
      event:       config.event,
    });
  });

  return records;
}

function normalizeTableRow(row, config) {
  if (!row) return null;

  // Try to map common column names
  const f = (keys) => {
    for (const k of keys) {
      if (row[k] !== undefined && row[k] !== '') return row[k];
    }
    return '';
  };

  const squat    = parseFloat(f(['squat','sq','squat (kg)','squat(kg)'])) || 0;
  const bench    = parseFloat(f(['bench','bp','bench press','bench (kg)'])) || 0;
  const deadlift = parseFloat(f(['deadlift','dl','deadlift (kg)'])) || 0;
  const total    = parseFloat(f(['total','total (kg)'])) || (squat + bench + deadlift);

  return {
    division:    f(['division','div','age division','age class']),
    gender:      f(['gender','sex','m/f']),
    weightClass: f(['weight class','weightclass','wc','bwt','body weight','weight']),
    name:        f(['name','lifter','athlete','lifter name']),
    squat,
    bench,
    deadlift,
    total,
    date:        f(['date','meet date','meetdate']),
    meet:        f(['meet','competition','meet name','meetname','event']),
    location:    config.location,
    status:      config.status,
    event:       config.event,
  };
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'USPA Records Proxy',
    cached: !!cachedRecords,
    cacheAge: cacheTime ? Math.round((Date.now() - cacheTime) / 1000) + 's' : null,
    recordCount: cachedRecords?.length ?? 0,
  });
});

// Main records endpoint
app.get('/records', async (req, res) => {
  try {
    // Serve from cache if fresh
    if (cachedRecords && cacheTime && (Date.now() - cacheTime) < CACHE_TTL_MS) {
      console.log(`[cache] Serving ${cachedRecords.length} cached records`);
      return res.json({ records: cachedRecords, cached: true, cacheAge: Math.round((Date.now() - cacheTime) / 1000) });
    }

    // Otherwise scrape fresh
    console.log('[cache] Cache miss — scraping fresh data…');
    const records = await scrapeRecords();

    if (records.length === 0) {
      return res.status(503).json({ error: 'Scrape returned no records. USPA site may have changed.' });
    }

    cachedRecords = records;
    cacheTime = Date.now();
    res.json({ records, cached: false });
  } catch (err) {
    console.error('[error]', err);
    // Return cached data even if stale on error
    if (cachedRecords) {
      return res.json({ records: cachedRecords, cached: true, stale: true, error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// Force refresh endpoint
app.post('/refresh', async (req, res) => {
  try {
    cachedRecords = null;
    cacheTime = null;
    const records = await scrapeRecords();
    cachedRecords = records;
    cacheTime = Date.now();
    res.json({ ok: true, recordCount: records.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`USPA Records Proxy running on port ${PORT}`);
});
