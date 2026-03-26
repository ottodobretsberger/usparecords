const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let cachedRecords = null;
let cacheTime = null;
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour

// The real Infoweave REST API discovered from network logs
// hierarchy_category_id=55 = IPL World, hierarchy_item_id=1 = Drug Tested, sub_hierarchy_item_id=58 = Raw Full Power
const API_URL = 'https://app.infoweave.io/embed/uspa/ais/public/records/queryget?hierarchy_category_id=55&hierarchy_item_id=1&sub_hierarchy_item_id=58';

async function fetchRecords() {
  console.log('[fetch] Calling Infoweave API...');

  const res = await fetch(API_URL, {
    headers: {
      'Accept': 'application/json',
      'Origin': 'https://infoweave-13b9d.web.app',
      'Referer': 'https://infoweave-13b9d.web.app/',
      'User-Agent': 'Mozilla/5.0 (compatible; USPA-Proxy/1.0)',
    }
  });

  if (!res.ok) throw new Error(`API returned HTTP ${res.status}`);

  const text = await res.text();
  console.log(`[fetch] Response length: ${text.length}`);
  console.log(`[fetch] Preview: ${text.substring(0, 500)}`);

  const json = JSON.parse(text);
  const records = parseResponse(json);
  console.log(`[fetch] Parsed ${records.length} records`);
  return records;
}

function parseResponse(json) {
  // Log the top-level shape so we can see what we're working with
  if (Array.isArray(json)) {
    console.log(`[parse] Top-level array, ${json.length} items`);
    if (json.length > 0) console.log(`[parse] First item keys: ${Object.keys(json[0]).join(', ')}`);
    if (json.length > 0) console.log(`[parse] First item: ${JSON.stringify(json[0]).substring(0, 400)}`);
  } else if (typeof json === 'object') {
    console.log(`[parse] Top-level object keys: ${Object.keys(json).join(', ')}`);
    // Log shape of each key
    for (const key of Object.keys(json)) {
      const val = json[key];
      if (Array.isArray(val)) {
        console.log(`[parse] key "${key}": array of ${val.length}`);
        if (val.length > 0) console.log(`[parse] key "${key}" first item: ${JSON.stringify(val[0]).substring(0, 300)}`);
      } else {
        console.log(`[parse] key "${key}": ${JSON.stringify(val).substring(0, 100)}`);
      }
    }
  }

  const records = [];

  // Try flat array
  if (Array.isArray(json)) {
    json.forEach(item => { const r = normalizeRecord(item); if (r) records.push(r); });
    return records;
  }

  // Try common wrapper keys
  const candidates = ['records','data','results','items','rows','list','powerlifting','lifts'];
  for (const key of candidates) {
    if (json[key] && Array.isArray(json[key]) && json[key].length > 0) {
      console.log(`[parse] Using key "${key}"`);
      json[key].forEach(item => { const r = normalizeRecord(item); if (r) records.push(r); });
      return records;
    }
  }

  // Try any array-valued key
  for (const key of Object.keys(json)) {
    if (Array.isArray(json[key]) && json[key].length > 0) {
      console.log(`[parse] Falling back to key "${key}"`);
      json[key].forEach(item => { const r = normalizeRecord(item); if (r) records.push(r); });
      if (records.length > 0) return records;
    }
  }

  return records;
}

function normalizeRecord(item) {
  if (!item || typeof item !== 'object') return null;

  // Log every unique key set we see (first time only)
  const keyStr = Object.keys(item).join(', ');
  if (!normalizeRecord._seenKeys) normalizeRecord._seenKeys = new Set();
  if (!normalizeRecord._seenKeys.has(keyStr)) {
    normalizeRecord._seenKeys.add(keyStr);
    console.log(`[normalize] New key pattern: ${keyStr}`);
    console.log(`[normalize] Sample: ${JSON.stringify(item).substring(0, 300)}`);
  }

  const get = (...keys) => {
    for (const k of keys) {
      // Exact match
      if (item[k] !== undefined && item[k] !== null && item[k] !== '') return item[k];
      // Case-insensitive match
      const found = Object.keys(item).find(ik => ik.toLowerCase() === k.toLowerCase());
      if (found && item[found] !== undefined && item[found] !== null && item[found] !== '') return item[found];
    }
    return '';
  };

  const name  = get('lifterName','lifter_name','name','athlete','lifter','Lifter','Name');
  const total = parseFloat(get('total','Total','total_kg')) || 0;
  const squat = parseFloat(get('squat','Squat','sq','best_squat','squat_kg')) || 0;
  const bench = parseFloat(get('bench','Bench','bp','best_bench','bench_kg','benchPress','bench_press')) || 0;
  const dl    = parseFloat(get('deadlift','Deadlift','dl','best_deadlift','deadlift_kg')) || 0;

  if (!name && !total && !squat && !bench && !dl) return null;

  return {
    division:    String(get('division','Division','div','age_class','ageClass','age class','ageDivision')),
    gender:      String(get('gender','Gender','sex','Sex')),
    weightClass: String(get('weightClass','weight_class','wc','WeightClass','weight class','bwt','bodyweight','Bodyweight')),
    name:        String(name),
    squat,
    bench,
    deadlift:    dl,
    total:       total || (squat + bench + dl) || 0,
    date:        String(get('date','Date','meetDate','meet_date','dateSet','date_set')),
    meet:        String(get('meet','Meet','meetName','meet_name','competition','Competition','meetLocation','meet_location')),
  };
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'USPA Records Proxy — Infoweave API',
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
    const records = await fetchRecords();
    if (records.length === 0) {
      return res.status(503).json({ error: 'API returned no parseable records — check logs for [parse] and [normalize] output.' });
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
    const records = await fetchRecords();
    cachedRecords = records;
    cacheTime = Date.now();
    res.json({ ok: true, recordCount: records.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`USPA proxy on port ${PORT}`));
