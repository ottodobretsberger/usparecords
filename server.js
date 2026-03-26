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
    console.log('[scrape] Already in progress, skipping');
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

    console.log('[scrape] Waiting for initial render (6s)...');
    await new Promise(r => setTimeout(r, 6000));

    // Click all pointer-cursor elements to expand all divisions
    await page.evaluate(() => {
      document.querySelectorAll('*').forEach(el => {
        try {
          if (window.getComputedStyle(el).cursor === 'pointer') el.click();
        } catch (_) {}
      });
    });

    console.log('[scrape] Waiting for expanded data (8s)...');
    await new Promise(r => setTimeout(r, 8000));

    // Extract the full innerText of the page — this contains everything
    // Structure in text:
    //   "keyboard_arrow_downOPEN MEN" → new division section
    //   "52kg/114.5lb"                → new weight class
    //   "Luis Sotelo"                 → lifter name (bold)
    //   "Squat - 2025-07-07"          → lift type + date
    //   "142.50 kgs / 314.16 lbs"     → weight
    //   "certificate"                 → skip
    //   (repeat for Bench, Deadlift, Total)
    const pageText = await page.evaluate(() => document.body.innerText);
    console.log('[scrape] innerText length:', pageText.length);

    const records = parsePageText(pageText);
    console.log(`[scrape] Parsed ${records.length} records`);
    if (records[0]) console.log('[scrape] Sample:', JSON.stringify(records[0]));

    await page.close();
    return records;
  } finally {
    await browser.close();
    scrapeInProgress = false;
  }
}

// ─── PARSER ───────────────────────────────────────────────────────────────────
function parsePageText(text) {
  const records = [];

  // Split on division headers: "OPEN MEN", "OPEN WOMEN", "MASTER 1 MEN", etc.
  // They appear as "keyboard_arrow_downDIVISION NAME" in innerText
  // Also handle "keyboard_arrow_right" for collapsed sections
  const divisionPattern = /keyboard_arrow_(?:down|right)([\w\s]+(?:MEN|WOMEN))/gi;

  // First pass: find all division headers and their positions
  const divisionBlocks = [];
  let match;
  const re = /keyboard_arrow_(?:down|right)([\w\s]+?(?:MEN|WOMEN))\b/gi;
  while ((match = re.exec(text)) !== null) {
    divisionBlocks.push({ label: match[1].trim(), pos: match.index + match[0].length });
  }

  if (divisionBlocks.length === 0) {
    console.log('[parse] No division headers found, trying fallback...');
    return parseFallback(text);
  }

  console.log(`[parse] Found ${divisionBlocks.length} divisions:`, divisionBlocks.map(d => d.label).join(', '));

  // Process each division block
  for (let di = 0; di < divisionBlocks.length; di++) {
    const { label, pos } = divisionBlocks[di];
    const blockEnd = di + 1 < divisionBlocks.length ? divisionBlocks[di + 1].pos : text.length;
    const blockText = text.slice(pos, blockEnd);

    // Parse gender and division from label like "OPEN MEN", "MASTER 1 WOMEN", "SUBMASTER MEN"
    const genderMatch = label.match(/(MEN|WOMEN)$/i);
    const gender = genderMatch ? (genderMatch[1] === 'MEN' ? 'Men' : 'Women') : 'Unknown';
    const division = label.replace(/(MEN|WOMEN)$/i, '').trim();
    const divisionClean = toTitleCase(division); // "OPEN" → "Open", "MASTER 1" → "Master 1"

    // Within this division block, find weight class sections
    // Weight classes appear as "52kg/114.5lb" or "140+kg/SHW"
    const wcPattern = /(\d+(?:\.\d+)?(?:\+)?)\s*kg\/[\d.]+\s*(?:lb|SHW)/gi;
    const wcBlocks = [];
    let wcMatch;
    while ((wcMatch = wcPattern.exec(blockText)) !== null) {
      wcBlocks.push({ wc: wcMatch[1] + (wcMatch[0].includes('+') ? '+' : ''), pos: wcMatch.index + wcMatch[0].length });
    }

    // Process each weight class block
    for (let wi = 0; wi < wcBlocks.length; wi++) {
      const { wc, pos: wcPos } = wcBlocks[wi];
      const wcEnd = wi + 1 < wcBlocks.length ? wcBlocks[wi + 1].pos : blockText.length;
      const wcText = blockText.slice(wcPos, wcEnd);

      // Within this weight class block, find lift records
      // Pattern: lifterName \n LiftType - Date \n X.XX kgs / Y.YY lbs \n certificate
      const liftPattern = /(.+?)\n((?:Squat|Bench|Deadlift|TOTAL)\s*-\s*[\d/\-]+)\n([\d.]+)\s*kgs?\s*\/\s*[\d.]+\s*(?:lbs?|SHW)/gi;
      const lifts = {};

      let liftMatch;
      while ((liftMatch = liftPattern.exec(wcText)) !== null) {
        const lifterName = liftMatch[1].trim().replace(/^certificate\s*/i, '').trim();
        const liftDateStr = liftMatch[2].trim();
        const kg = parseFloat(liftMatch[3]);

        const liftTypeMatch = liftDateStr.match(/^(squat|bench|deadlift|total)/i);
        if (!liftTypeMatch) continue;
        const liftType = liftTypeMatch[1].toLowerCase();
        const dateMatch = liftDateStr.match(/[-–]\s*(.+)$/);
        const date = dateMatch ? dateMatch[1].trim() : '';

        if (lifterName && kg > 0) {
          lifts[liftType] = { name: lifterName, kg, date };
        }
      }

      if (Object.keys(lifts).length > 0) {
        records.push({
          gender,
          division: divisionClean,
          weightClass: wc,
          name_squat:    lifts.squat?.name     || '',
          squat:         lifts.squat?.kg        || 0,
          date_squat:    lifts.squat?.date      || '',
          name_bench:    lifts.bench?.name      || '',
          bench:         lifts.bench?.kg        || 0,
          date_bench:    lifts.bench?.date      || '',
          name_deadlift: lifts.deadlift?.name   || '',
          deadlift:      lifts.deadlift?.kg     || 0,
          date_deadlift: lifts.deadlift?.date   || '',
          name_total:    lifts.total?.name      || '',
          total:         lifts.total?.kg        || 0,
          date_total:    lifts.total?.date      || '',
        });
      }
    }
  }

  return records;
}

// Fallback: parse the big blob we saw in Sample[] using regex on the raw text
function parseFallback(text) {
  const records = [];
  // Match pattern from the blob: "Name\nLiftType - Date\nXX.XX kgs / YY.YY lbs\ncertificate"
  // Group by weight class markers like "52kg/114.5lb"
  const sections = text.split(/\d+(?:\.\d+)?(?:\+)?kg\/[\d.]+(?:lb|SHW)/);
  const wcMatches = [...text.matchAll(/(\d+(?:\.\d+)?(?:\+)?)kg\/([\d.]+(?:lb|SHW))/g)];

  sections.slice(1).forEach((section, i) => {
    const wc = wcMatches[i]?.[1] || '?';
    const lifts = {};
    const liftRe = /(.+?)\n((?:Squat|Bench|Deadlift|TOTAL)\s*-\s*[\d/\-]+)\n([\d.]+)\s*kgs?\s*\//gi;
    let m;
    while ((m = liftRe.exec(section)) !== null) {
      const name = m[1].trim().replace(/^certificate\s*/i, '').trim();
      const liftType = m[2].match(/^(\w+)/i)?.[1]?.toLowerCase();
      const date = m[2].match(/[-–]\s*(.+)$/)?.[1]?.trim() || '';
      const kg = parseFloat(m[3]);
      if (name && liftType && kg > 0) lifts[liftType] = { name, kg, date };
    }
    if (Object.keys(lifts).length > 0) {
      records.push({
        gender: 'Unknown', division: 'Unknown', weightClass: wc,
        name_squat: lifts.squat?.name || '', squat: lifts.squat?.kg || 0, date_squat: lifts.squat?.date || '',
        name_bench: lifts.bench?.name || '', bench: lifts.bench?.kg || 0, date_bench: lifts.bench?.date || '',
        name_deadlift: lifts.deadlift?.name || '', deadlift: lifts.deadlift?.kg || 0, date_deadlift: lifts.deadlift?.date || '',
        name_total: lifts.total?.name || '', total: lifts.total?.kg || 0, date_total: lifts.total?.date || '',
      });
    }
  });
  return records;
}

function toTitleCase(str) {
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).trim();
}

// ─── BACKGROUND SCRAPE ON STARTUP ────────────────────────────────────────────
// Scrape immediately on boot so first request is instant
async function warmCache() {
  try {
    console.log('[warmup] Starting background scrape...');
    const records = await scrapeRecords();
    if (records.length > 0) {
      cachedRecords = records;
      cacheTime = Date.now();
      console.log(`[warmup] Cache warmed with ${records.length} records`);
    } else {
      console.log('[warmup] No records returned, will retry on first request');
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
    // Serve from cache if fresh
    if (cachedRecords && cacheTime && (Date.now() - cacheTime) < CACHE_TTL_MS) {
      console.log(`[cache] Serving ${cachedRecords.length} cached records`);
      return res.json({
        records: cachedRecords,
        cached: true,
        cacheAge: Math.round((Date.now() - cacheTime) / 1000) + 's'
      });
    }

    // If scrape is in progress, wait for it
    if (scrapeInProgress) {
      console.log('[request] Scrape in progress, waiting...');
      await new Promise(resolve => {
        const check = setInterval(() => {
          if (!scrapeInProgress) { clearInterval(check); resolve(); }
        }, 1000);
        setTimeout(() => { clearInterval(check); resolve(); }, 60000);
      });
      if (cachedRecords) {
        return res.json({ records: cachedRecords, cached: true });
      }
    }

    // Fresh scrape
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
  // Warm cache in background after a short delay so server is ready first
  setTimeout(warmCache, 3000);
});
