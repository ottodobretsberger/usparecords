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

    await page.goto(EMBED_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for initial render, then click everything to expand all divisions
    console.log('[scrape] Waiting for initial render...');
    await new Promise(r => setTimeout(r, 6000));

    // Click all pointer-cursor elements to expand divisions
    await page.evaluate(() => {
      document.querySelectorAll('*').forEach(el => {
        if (window.getComputedStyle(el).cursor === 'pointer') {
          try { el.click(); } catch (_) {}
        }
      });
    });

    // Wait for all expanded data to load
    console.log('[scrape] Waiting for expanded data...');
    await new Promise(r => setTimeout(r, 8000));

    // Parse the hierarchy-horizontal-table structure
    const records = await page.evaluate(() => {
      const results = [];

      // The page structure:
      // .hierarchy-depth-0  = Gender (Men / Women)
      // .hierarchy-depth-1  = Division (Open, Master 1, etc.) + Weight Class label
      // .hierarchy-horizontal-table = one row per weight class
      //   each <td> = one lift type (Squat, Bench, Deadlift, Total)
      //   inside each td: name (bold), lift type - date, weight kgs/lbs

      // Walk up from each table to find its division/gender context
      document.querySelectorAll('table.hierarchy-horizontal-table').forEach(table => {
        // Find the nearest ancestor context labels
        let gender = '';
        let division = '';
        let weightClass = '';

        // Walk up the DOM to find hierarchy labels
        let el = table.parentElement;
        const contextTexts = [];
        while (el && el !== document.body) {
          // Look for sibling text nodes / header elements before this table
          const prev = el.previousElementSibling;
          if (prev) {
            const txt = prev.textContent.trim();
            if (txt) contextTexts.unshift(txt);
          }
          el = el.parentElement;
        }

        // Also look for preceding text in the same container
        const container = table.closest('[class*="hierarchy"]') || table.parentElement;
        if (container) {
          // Walk all preceding siblings
          let sib = container.previousElementSibling;
          while (sib) {
            const txt = sib.textContent.trim();
            if (txt && txt.length < 100) contextTexts.unshift(txt);
            sib = sib.previousElementSibling;
          }
        }

        // Find gender and division from page section headers
        // Strategy: find the closest .hierarchy-depth-0 and .hierarchy-depth-1 ancestors
        const depth0 = table.closest('[class]') 
          ? (() => {
              let p = table.parentElement;
              while (p && p !== document.body) {
                // Look for depth-0 siblings/ancestors with gender text
                const allDepth0 = document.querySelectorAll('[class*="depth-0"], [class*="depth0"]');
                for (const d0 of allDepth0) {
                  if (d0.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING) {
                    const t = d0.textContent.trim();
                    if (t.match(/men|women/i)) gender = t;
                  }
                }
                p = p.parentElement;
              }
            })()
          : null;

        // Simpler approach: scan all text visible above the table in DOM order
        const allElements = [...document.querySelectorAll('*')];
        const tableIdx = allElements.indexOf(table);
        
        for (let i = Math.max(0, tableIdx - 200); i < tableIdx; i++) {
          const el = allElements[i];
          const cls = el.className || '';
          const txt = el.textContent.trim();
          if (!txt || txt.length > 80 || el.children.length > 2) continue;
          
          if (typeof cls === 'string') {
            if (cls.includes('depth-0') || cls.includes('gender')) {
              if (txt.match(/^(men|women)$/i)) gender = txt;
            }
            if (cls.includes('depth-1') || cls.includes('division')) {
              if (txt.match(/open|master|junior|teen|submaster/i)) division = txt;
              if (txt.match(/^\d+(\.\d+)?(\+)?(\s*kg)?$/i)) weightClass = txt.replace(/\s*kg/i,'').trim();
            }
          }
          
          // Fallback pattern matching
          if (!gender && txt.match(/^(men|women)$/i)) gender = txt;
          if (!division && txt.match(/^(open|submaster|master \d|junior|teen \d)$/i)) division = txt;
          if (!weightClass && txt.match(/^\d+(\.\d+)?\+?$/)) weightClass = txt;
        }

        // Now parse each <td> in the table — each td = one lift record
        // Structure: [bold name] [lift type - date] [X.XX kgs / Y.YY lbs]
        const liftMap = {}; // { Squat: {name, weight, date}, Bench: {...}, ... }

        table.querySelectorAll('td').forEach(td => {
          const depth2 = td.querySelector('.hierarchy-depth-2');
          if (!depth2) return;
          const divs = [...depth2.querySelectorAll('div')].filter(d => d.children.length === 0 || d.querySelectorAll('a').length > 0);
          
          // Get all text nodes in order
          const texts = [];
          depth2.querySelectorAll('div, a').forEach(node => {
            const t = node.textContent.trim();
            if (t && t !== 'certificate' && node.children.length === 0) texts.push(t);
          });

          if (texts.length < 2) return;

          // texts[0] = name (bold/Record Preset label or lifter name)
          // texts[1] = "LiftType - Date" e.g. "Squat - 2025-07-07"
          // texts[2] = "142.50 kgs / 314.16 lbs"
          
          // Skip "Record Preset" placeholder entries with no real data
          const nameText = texts[0];
          const liftDateText = texts[1] || '';
          const weightText = texts[2] || '';

          if (!liftDateText.match(/squat|bench|deadlift|total/i)) return;

          const liftMatch = liftDateText.match(/^(squat|bench|deadlift|total)\s*[-–]\s*(.+)$/i);
          if (!liftMatch) return;

          const liftType = liftMatch[1].toLowerCase();
          const date = liftMatch[2].trim();

          // Parse kg value
          const kgMatch = weightText.match(/([\d.]+)\s*kgs?/i);
          const kg = kgMatch ? parseFloat(kgMatch[1]) : 0;

          if (kg > 0) {
            liftMap[liftType] = { name: nameText, date, kg };
          }
        });

        // Build a record from liftMap
        if (Object.keys(liftMap).length > 0) {
          results.push({
            gender: gender || 'Unknown',
            division: division || 'Unknown',
            weightClass: weightClass || 'Unknown',
            name_squat:    liftMap.squat?.name    || '',
            squat:         liftMap.squat?.kg       || 0,
            date_squat:    liftMap.squat?.date     || '',
            name_bench:    liftMap.bench?.name     || '',
            bench:         liftMap.bench?.kg       || 0,
            date_bench:    liftMap.bench?.date     || '',
            name_deadlift: liftMap.deadlift?.name  || '',
            deadlift:      liftMap.deadlift?.kg    || 0,
            date_deadlift: liftMap.deadlift?.date  || '',
            name_total:    liftMap.total?.name     || '',
            total:         liftMap.total?.kg       || 0,
            date_total:    liftMap.total?.date     || '',
          });
        }
      });

      return results;
    });

    console.log(`[scrape] Parsed ${records.length} weight-class records`);
    if (records.length > 0) console.log('[scrape] Sample:', JSON.stringify(records[0]));
    if (records.length > 1) console.log('[scrape] Sample2:', JSON.stringify(records[1]));

    await page.close();
    return records;

  } finally {
    await browser.close();
  }
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
