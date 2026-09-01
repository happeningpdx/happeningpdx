bash

echo '========== BEGIN scripts/fetch-events.js =========='
cat /mnt/user-data/outputs/happeningpdx-repo/scripts/fetch-events.js
echo '========== END scripts/fetch-events.js =========='
Output

========== BEGIN scripts/fetch-events.js ==========
#!/usr/bin/env node
/**
 * happeningpdx event pipeline
 * Pulls Portland events from Ticketmaster Discovery API, merges with
 * data/curated.json (recurring fixtures + featured), writes events.json.
 * No dependencies - Node 18+ built-in fetch.
 *
 * Usage:  TM_API_KEY=yourkey node scripts/fetch-events.js
 * Without a key it still writes events.json from curated data alone.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KEY = process.env.TM_API_KEY || '';
const CENTER = '45.5231,-122.6765'; // Portland
const RADIUS_MILES = 30;
const DAYS_AHEAD = 60;
const MAX_EVENTS = 160;

// Ticketmaster segment/genre -> happeningpdx category
function mapCategory(cls) {
  const seg = (cls?.segment?.name || '').toLowerCase();
  const genre = (cls?.genre?.name || '').toLowerCase();
  if (genre.includes('festival')) return 'festival';
  if (seg === 'music') return 'music';
  if (seg === 'sports') return 'sports';
  if (seg === 'arts & theatre') {
    if (genre.includes('comedy')) return 'comedy';
    return 'art';
  }
  if (seg === 'family') return 'community';
  return 'community';
}

function fmtDate(localDate, localTime) {
  if (!localDate) return null;
  const d = new Date(localDate + 'T12:00:00');
  if (isNaN(d)) return null;
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
  const year = localDate.slice(0, 4);
  let out = `${day} ${year}`;
  if (localTime) {
    const [h, m] = localTime.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    out += ` - ${h12}:${String(m).padStart(2, '0')} ${ampm}`;
  }
  return out;
}

function fmtPrice(ranges) {
  if (!ranges || !ranges.length) return 'See tickets';
  const r = ranges[0];
  const min = r.min != null ? Math.round(r.min) : null;
  const max = r.max != null ? Math.round(r.max) : null;
  if (min != null && max != null && max > min) return `$${min}-$${max}`;
  if (min != null) return `$${min}+`;
  return 'See tickets';
}

// Pick the best event image: real art (not TM's generic fallback),
// 16:9, closest to 640px wide - right for popups and detail heroes
function pickImage(images) {
  if (!Array.isArray(images) || !images.length) return '';
  const usable = images.filter(i => i && i.url && !i.fallback);
  const pool = usable.length ? usable : images.filter(i => i && i.url);
  if (!pool.length) return '';
  const wide = pool.filter(i => i.ratio === '16_9');
  const pick = (wide.length ? wide : pool)
    .slice()
    .sort((a, b) => Math.abs((a.width || 0) - 640) - Math.abs((b.width || 0) - 640))[0];
  return pick ? pick.url : '';
}

// Stable numeric id from TM's string id, so user saves persist across refreshes
function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return 100000 + Math.abs(h % 900000);
}

function normKey(name, date) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40) + '|' + (date || '').slice(0, 15);
}

async function fetchTM() {
  if (!KEY) {
    console.log('No TM_API_KEY set - writing curated events only.');
    return [];
  }
  const start = new Date();
  const end = new Date(Date.now() + DAYS_AHEAD * 86400000);
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const out = [];
  for (let page = 0; page < 3; page++) {
    const url = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${KEY}` +
      `&latlong=${CENTER}&radius=${RADIUS_MILES}&unit=miles` +
      `&startDateTime=${iso(start)}&endDateTime=${iso(end)}` +
      `&size=200&page=${page}&sort=date,asc`;
    const res = await fetch(url);
    if (!res.ok) { console.error('TM API error', res.status, await res.text().catch(()=>'')); break; }
    const data = await res.json();
    const events = data?._embedded?.events || [];
    out.push(...events);
    const totalPages = data?.page?.totalPages ?? 1;
    if (page + 1 >= totalPages) break;
  }
  console.log(`Ticketmaster returned ${out.length} raw events.`);
  return out;
}

function normalizeTM(raw) {
  const seen = new Set();
  const events = [];
  for (const ev of raw) {
    try {
      const venue = ev._embedded?.venues?.[0];
      const lat = parseFloat(venue?.location?.latitude);
      const lng = parseFloat(venue?.location?.longitude);
      if (!venue || isNaN(lat) || isNaN(lng)) continue;
      if (ev.dates?.status?.code === 'cancelled') continue;
      const d = fmtDate(ev.dates?.start?.localDate, ev.dates?.start?.localTime);
      if (!d) continue;
      const key = normKey(ev.name, d);
      if (seen.has(key)) continue;
      seen.add(key);
      const cls = ev.classifications?.[0];
      const genre = cls?.genre?.name && cls.genre.name !== 'Undefined' ? cls.genre.name : '';
      const addrLine = [venue.address?.line1, venue.city?.name].filter(Boolean).join(', ');
      events.push({
        id: hashId(ev.id),
        url: ev.url || '',
        img: pickImage(ev.images),
        t: mapCategory(cls),
        n: ev.name,
        v: venue.name || 'Venue TBA',
        a: addrLine || 'Portland, OR',
        d,
        p: fmtPrice(ev.priceRanges),
        age: ev.ageRestrictions?.legalAgeEnforced ? '21+' : 'All ages',
        src: 'Ticketmaster',
        promo: false,
        lat, lng,
        desc: (ev.info || ev.pleaseNote || (genre ? `${genre} at ${venue.name}.` : `Live at ${venue.name}.`)).replace(/\s+/g, ' ').slice(0, 160),
        tags: [genre, cls?.subGenre?.name].filter(x => x && x !== 'Undefined').map(x => x.toLowerCase()),
      });
    } catch (e) { /* skip malformed */ }
  }
  return events;
}

// ---------- SHARED: venue coordinate resolution ----------
const VENUES = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'venues.json'), 'utf8'));
function normVenue(s) {
  return (s || '').toLowerCase()
    .replace(/&amp;/g, '&').replace(/[\u2018\u2019']/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^the /, '').replace(/ portland$/, '');
}
function venueCoords(name) {
  const key = normVenue(name);
  if (VENUES[key]) return VENUES[key];
  // loose contains-match for suffixed names ("Doug Fir Lounge - Upstairs")
  for (const k of Object.keys(VENUES)) {
    if (key.includes(k) || k.includes(key)) return VENUES[k];
  }
  return null;
}
function decodeEntities(s) {
  return (s || '').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}
function guessCategory(name) {
  const s = (name || '').toLowerCase();
  if (/comedy|improv|stand-?up/.test(s)) return 'comedy';
  if (/market|bazaar|swap|flea/.test(s)) return 'market';
  if (/street fair|festival|fest\b/.test(s)) return 'festival';
  if (/gallery|art walk|exhibit|museum/.test(s)) return 'art';
  if (/run\b|hike|bike|5k|10k|yoga/.test(s)) return 'outdoor';
  if (/beer|wine|food|tasting|brunch|dinner/.test(s)) return 'food';
  if (/concert|live music|band|dj |orchestra|symphony/.test(s)) return 'music';
  return 'community';
}
const MONTH_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles',
  weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
function fmtLocal(dt, hasTime) {
  const parts = {};
  MONTH_FMT.formatToParts(dt).forEach(p => parts[p.type] = p.value);
  let out = `${parts.weekday} ${parts.month} ${parts.day} ${parts.year}`;
  if (hasTime) out += ` - ${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
  return out;
}

// ---------- SOURCE: iCal feeds (data/feeds.json) ----------
function parseICS(raw) {
  const unfolded = raw.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const [keyPart, value] = [line.slice(0, idx), line.slice(idx + 1)];
    const key = keyPart.split(';')[0].toUpperCase();
    const params = keyPart.toUpperCase();
    if (key === 'SUMMARY') cur.summary = value.replace(/\\,/g, ',').replace(/\\n/g, ' ').trim();
    else if (key === 'DTSTART') { cur.dtstart = value.trim(); cur.allday = params.includes('VALUE=DATE') || /^\d{8}$/.test(value.trim()); cur.utc = /Z$/.test(value.trim()); }
    else if (key === 'DTEND') cur.dtend = value.trim();
    else if (key === 'LOCATION') cur.location = value.replace(/\\,/g, ',').replace(/\\n/g, ' ').trim();
    else if (key === 'URL') cur.icsurl = value.trim();
    else if (key === 'GEO') cur.geo = value.trim();
    else if (key === 'UID') cur.uid = value.trim();
  }
  return events;
}
function icsDate(v, allday, utc) {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?/);
  if (!m) return null;
  const [y, mo, d, h, mi] = [+m[1], +m[2], +m[3], +(m[4] || 12), +(m[5] || 0)];
  if (utc) return new Date(Date.UTC(y, mo - 1, d, h, mi));
  return new Date(y, mo - 1, d, h, mi); // floating/TZID: treat as local (runner converts via fmtLocal's LA tz for UTC only)
}
async function fetchFeeds() {
  let cfg = [];
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'feeds.json'), 'utf8')); } catch (e) { return []; }
  const feeds = cfg.filter(f => f && f.url && f.enabled !== false && !f._comment);
  const out = [];
  const horizon = Date.now() + DAYS_AHEAD * 86400000;
  for (const feed of feeds) {
    try {
      const res = await fetch(feed.url, { headers: { 'User-Agent': 'happeningpdxBot/1.0 (+https://happeningpdx.netlify.app)' } });
      if (!res.ok) { console.log(`[ics] ${feed.url} -> HTTP ${res.status}`); continue; }
      const raw = await res.text();
      let kept = 0;
      for (const ev of parseICS(raw)) {
        if (!ev.summary || !ev.dtstart) continue;
        const start = icsDate(ev.dtstart, ev.allday, ev.utc);
        if (!start || start.getTime() < Date.now() - 86400000 || start.getTime() > horizon) continue;
        let lat = feed.lat, lng = feed.lng, vname = feed.venue || ev.location || 'Portland';
        if (ev.geo) { const g = ev.geo.split(';'); lat = parseFloat(g[0]); lng = parseFloat(g[1]); }
        if (lat == null || lng == null) {
          const c = venueCoords(ev.location || feed.venue);
          if (c) { lat = c[0]; lng = c[1]; }
        }
        if (lat == null || lng == null) continue;
        out.push({
          id: hashId('ics:' + (ev.uid || feed.url + ev.summary + ev.dtstart)),
          url: ev.icsurl || feed.url, t: feed.category || guessCategory(ev.summary),
          n: decodeEntities(ev.summary), v: vname, a: ev.location || 'Portland, OR',
          d: fmtLocal(start, !ev.allday && ev.utc), p: 'See listing', age: 'All ages',
          src: 'Calendar', promo: false, lat, lng,
          desc: `From the ${vname} calendar.`, tags: [],
        });
        if (++kept >= 40) break;
      }
      console.log(`[ics] ${feed.url} -> ${kept} events`);
    } catch (e) { console.log(`[ics] ${feed.url} failed: ${e.message}`); }
  }
  return out;
}

// ---------- SOURCE: venue pages via schema.org JSON-LD (data/venue-pages.json) ----------
// Most venue sites embed machine-readable Event data for Google. One parser, many venues.
function jsonLdEvents(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim().replace(/^\uFEFF/, '')); } catch (e) { continue; }
    const stack = Array.isArray(data) ? data.slice() : [data];
    while (stack.length) {
      const n = stack.shift();
      if (!n || typeof n !== 'object') continue;
      if (Array.isArray(n['@graph'])) stack.push(...n['@graph']);
      if (Array.isArray(n.subEvent)) stack.push(...n.subEvent);
      if (Array.isArray(n.itemListElement)) {
        stack.push(...n.itemListElement.map(i => (i && i.item) ? i.item : i));
      }
      const types = [].concat(n['@type'] || []);
      if (!types.some(t => typeof t === 'string' && /Event$/i.test(t))) continue;
      if (!n.name || !n.startDate) continue;
      out.push(n);
    }
  }
  return out;
}
function ldPrice(offers) {
  const list = [].concat(offers || []).filter(Boolean);
  const nums = list.map(o => parseFloat(o.price != null ? o.price : (o.lowPrice != null ? o.lowPrice : NaN)))
                   .filter(v => !isNaN(v));
  if (!nums.length) return 'See tickets';
  const min = Math.min(...nums), max = Math.max(...nums);
  if (min === 0 && max === 0) return 'Free';
  if (max > min) return `$${Math.round(min)}-$${Math.round(max)}`;
  return `$${Math.round(min)}`;
}
function ldImage(img) {
  if (!img) return '';
  if (typeof img === 'string') return img;
  if (Array.isArray(img)) return ldImage(img[0]);
  return img.url || '';
}
// Etix venue upcoming-events pages list shows as anchor links. Extract title + date + id.
// Returns objects shaped like schema.org Events so the main loop handles them uniformly.
function parseEtixList(html, page) {
  const out = [];
  const seen = new Set();
  // Each show links to /ticket/p/{numericId}/{slug}; title is the anchor text.
  const re = /<a[^>]+href="([^"]*\/ticket\/p\/(\d+)\/[^"]*)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,400}?)(?=<a[^>]+href="[^"]*\/ticket\/p\/|$)/g;
  let m;
  const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  while ((m = re.exec(html))) {
    const href = m[1], id = m[2];
    const title = decodeEntities(m[3].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
    if (!title || title.length < 3 || seen.has(id)) continue;
    // Look for a date in the trailing chunk: "Fri, Aug 21, 2026" / "Aug 21" / "8/21/2026"
    const chunk = m[4].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    let dt = null;
    let dm = chunk.match(/([A-Za-z]{3,})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/);
    if (dm && MONTHS[dm[1].slice(0,3).toLowerCase()] !== undefined) {
      const mo = MONTHS[dm[1].slice(0,3).toLowerCase()];
      const day = +dm[2];
      let yr = dm[3] ? +dm[3] : new Date().getFullYear();
      dt = new Date(yr, mo, day, 20, 0);
      if (!dm[3] && dt.getTime() < Date.now() - 45 * 86400000) dt = new Date(yr + 1, mo, day, 20, 0);
    } else {
      dm = chunk.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (dm) dt = new Date(+dm[3], +dm[1] - 1, +dm[2], 20, 0);
    }
    if (!dt || isNaN(dt)) continue;
    seen.add(id);
    out.push({
      '@type': 'Event',
      name: title,
      startDate: dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0') + 'T20:00',
      url: href.startsWith('http') ? href : 'https://www.etix.com' + href,
      location: { name: page.venue },
    });
    if (out.length >= 40) break;
  }
  return out;
}

async function fetchVenuePages() {
  let cfg = [];
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'venue-pages.json'), 'utf8')); } catch (e) { return []; }
  const pages = cfg.filter(p => p && p.url && p.enabled !== false && !p._comment);
  const out = [];
  const horizon = Date.now() + DAYS_AHEAD * 86400000;
  for (const page of pages) {
    try {
      const res = await fetch(page.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; happeningpdxBot/1.0; +https://happeningpdx.netlify.app)' } });
      if (!res.ok) { console.log(`[jsonld] ${page.url} -> HTTP ${res.status}`); continue; }
      const html = await res.text();
      let found = jsonLdEvents(html);
      // Etix fallback: their venue upcoming-events page lists shows as /ticket/p/{id}/{slug}
      // links with the show title as anchor text and a nearby date. Parse when JSON-LD is thin.
      if (found.length === 0 && /etix\.com/.test(page.url)) {
        found = parseEtixList(html, page);
      }
      let kept = 0, noCoords = 0;
      for (const n of found) {
        const sd = String(n.startDate).match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
        if (!sd) continue;
        const start = new Date(+sd[1], +sd[2] - 1, +sd[3], +(sd[4] || 12), +(sd[5] || 0));
        if (start.getTime() < Date.now() - 86400000 || start.getTime() > horizon) continue;
        const loc = n.location || {};
        const vname = decodeEntities(page.venue || (typeof loc === 'string' ? loc : loc.name) || '');
        const geo = (loc && loc.geo) || {};
        let lat = parseFloat(geo.latitude), lng = parseFloat(geo.longitude);
        if (isNaN(lat) || isNaN(lng)) {
          if (page.lat != null && page.lng != null) { lat = page.lat; lng = page.lng; }
          else {
            const c = venueCoords(vname);
            if (c) { lat = c[0]; lng = c[1]; } else { noCoords++; continue; }
          }
        }
        const addr = (loc && loc.address) || {};
        const street = typeof addr === 'string' ? addr : addr.streetAddress;
        out.push({
          id: hashId('ld:' + (n.url || page.url + n.name + n.startDate)),
          url: n.url || page.url,
          img: ldImage(n.image),
          t: page.category || guessCategory(n.name),
          n: decodeEntities(String(n.name)).slice(0, 90),
          v: vname || 'Portland',
          a: street ? `${street}${addr.addressLocality ? ', ' + addr.addressLocality : ''}` : (vname + ', Portland, OR'),
          d: fmtLocal(start, !!sd[4]),
          p: ldPrice(n.offers),
          age: 'See listing',
          src: 'Venue',
          promo: false,
          lat, lng,
          desc: decodeEntities(String(n.description || `${vname} presents ${n.name}.`)).replace(/<[^>]*>/g, '').slice(0, 160),
          tags: [],
        });
        if (++kept >= 30) break;
      }
      console.log(`[jsonld] ${page.url} -> ${found.length} found, ${kept} kept${noCoords ? `, ${noCoords} skipped (no venue coords)` : ''}`);
      await new Promise(r => setTimeout(r, 700));
    } catch (e) { console.log(`[jsonld] ${page.url} failed: ${e.message}`); }
  }
  return out;
}

// ---------- SOURCE: Calagator (Portland community calendar, open API) ----------
// Community-run, CC-licensed, publishes clean JSON. No key required.
async function fetchCalagator() {
  const out = [];
  try {
    const res = await fetch('https://calagator.org/events.json', {
      headers: { 'User-Agent': 'happeningpdxBot/1.0 (+https://happeningpdx.netlify.app)' } });
    if (!res.ok) { console.log(`[calagator] HTTP ${res.status}`); return []; }
    const rows = await res.json();
    if (!Array.isArray(rows)) return [];
    const horizon = Date.now() + DAYS_AHEAD * 86400000;
    for (const r of rows) {
      if (!r || !r.title || !r.start_time) continue;
      const start = new Date(r.start_time);
      if (isNaN(start) || start.getTime() < Date.now() - 86400000 || start.getTime() > horizon) continue;
      const v = r.venue || {};
      let lat = parseFloat(v.latitude), lng = parseFloat(v.longitude);
      if (isNaN(lat) || isNaN(lng)) {
        const c = venueCoords(v.title);
        if (c) { lat = c[0]; lng = c[1]; } else continue;
      }
      // Portland metro only
      if (lat < 45.2 || lat > 45.8 || lng < -123.2 || lng > -122.2) continue;
      out.push({
        id: hashId('cal:' + r.id),
        url: r.url || `https://calagator.org/events/${r.id}`,
        t: guessCategory(r.title + ' ' + (r.description || '')),
        n: decodeEntities(String(r.title)).slice(0, 90),
        v: decodeEntities(v.title || 'Portland'),
        a: [v.street_address, v.locality].filter(Boolean).join(', ') || 'Portland, OR',
        d: fmtLocal(start, true),
        p: 'See listing', age: 'All ages', src: 'Calagator', promo: false,
        lat, lng,
        desc: decodeEntities(String(r.description || '')).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').slice(0, 160) || `Community event at ${v.title || 'a Portland venue'}.`,
        tags: [],
      });
      if (out.length >= 40) break;
    }
    console.log(`[calagator] ${out.length} events`);
  } catch (e) { console.log(`[calagator] failed: ${e.message}`); }
  return out;
}

// ---------- SOURCE: EverOut (experimental - content-anchored, fail-soft) ----------
const EVEROUT_CATS = [
  ['community', 'community'], ['festivals', 'festival'], ['live-music', 'music'],
  ['food-drink', 'food'], ['parties-nightlife', 'nightlife'], ['visual-art', 'art'],
];
const DATE_RE = /(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})/;
function parseEverOut(html, cat) {
  const out = [];
  // Prefer schema.org JSON-LD when present
  const ldre = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = ldre.exec(html))) {
    try {
      const data = JSON.parse(m[1].trim());
      const nodes = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const n of nodes) {
        const t = [].concat(n && n['@type'] || []);
        if (!t.some(x => /Event$/i.test(x))) continue;
        const loc = n.location || {};
        const vname = decodeEntities(typeof loc === 'string' ? loc : loc.name || '');
        const geo = loc.geo || {};
        let lat = parseFloat(geo.latitude), lng = parseFloat(geo.longitude);
        if (isNaN(lat) || isNaN(lng)) { const c = venueCoords(vname); if (c) { lat = c[0]; lng = c[1]; } else continue; }
        const sd = (n.startDate || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
        if (!sd) continue;
        const dt = new Date(+sd[1], +sd[2] - 1, +sd[3], +(sd[4] || 12), +(sd[5] || 0));
        out.push({ name: decodeEntities(n.name), venue: vname, lat, lng, dt, hasTime: !!sd[4],
          href: n.url || '', });
      }
    } catch (e) { /* tolerate */ }
  }
  if (out.length) return out;
  // Fallback: anchor on rendered content patterns ("Event Name" ... "Sat Jul 11 ... at Venue")
  const are = /<a[^>]+href="([^"]*\/portland\/events\/[^"?#]+)"[^>]*>\s*([^<][\s\S]{2,120}?)\s*<\/a>([\s\S]{0,700}?)(?=<a[^>]+href="[^"]*\/portland\/events\/|$)/g;
  const seen = new Set();
  while ((m = are.exec(html))) {
    const href = m[1], name = decodeEntities(m[2].replace(/<[^>]+>/g, ''));
    if (seen.has(href) || name.length < 3) continue;
    const tail = m[3].replace(/<[^>]+>/g, ' ');
    const dm = tail.match(DATE_RE);
    if (!dm) continue;
    const vm = tail.match(/\bat\s+([A-Z][^|\n]{2,60}?)(?:\s{2,}|\||$|\n)/);
    const vname = decodeEntities(vm ? vm[1] : '');
    const c = venueCoords(vname);
    if (!c) continue;
    const yr = new Date().getFullYear();
    let dt = new Date(`${dm[2]} ${dm[3]} ${yr} 12:00`);
    if (dt.getTime() < Date.now() - 45 * 86400000) dt = new Date(`${dm[2]} ${dm[3]} ${yr + 1} 12:00`);
    seen.add(href);
    out.push({ name, venue: vname, lat: c[0], lng: c[1], dt, hasTime: false,
      href: href.startsWith('http') ? href : 'https://everout.com' + href });
  }
  return out;
}
async function fetchEverOut() {
  const all = [];
  for (const [slug, cat] of EVEROUT_CATS) {
    try {
      const res = await fetch(`https://everout.com/portland/events/?category=${slug}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; happeningpdxBot/1.0; +https://happeningpdx.netlify.app)' } });
      if (!res.ok) { console.log(`[everout] ${slug} -> HTTP ${res.status}`); continue; }
      const html = await res.text();
      const parsed = parseEverOut(html, cat);
      console.log(`[everout] ${slug} -> ${parsed.length} events`);
      for (const p of parsed.slice(0, 25)) {
        if (p.dt.getTime() < Date.now() - 86400000) continue;
        all.push({
          id: hashId('eo:' + (p.href || p.name + p.dt)), url: p.href || 'https://everout.com/portland/events/',
          t: cat, n: p.name, v: p.venue, a: p.venue + ', Portland, OR',
          d: fmtLocal(p.dt, p.hasTime), p: 'See listing', age: 'All ages',
          src: 'EverOut', promo: false, lat: p.lat, lng: p.lng,
          desc: `${p.venue} event - full details and dates on EverOut.`, tags: [],
        });
      }
      await new Promise(r => setTimeout(r, 800));
    } catch (e) { console.log(`[everout] ${slug} failed: ${e.message}`); }
  }
  return all;
}

function main() {
  return fetchTM().then(async raw => {
    const tm = normalizeTM(raw);
    const ics = await fetchFeeds();
    const venuePages = await fetchVenuePages();
    const calagator = await fetchCalagator();
    const everout = await fetchEverOut();
    const curated = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'curated.json'), 'utf8'));

    // Dedupe: curated > Ticketmaster > calendar feeds > EverOut
    const seen = new Set(curated.map(e => normKey(e.n, e.d)));
    const merged = [...curated];
    for (const list of [tm, ics, venuePages, calagator, everout]) {
      for (const e of list) {
        const k = normKey(e.n, e.d);
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(e);
      }
    }
    merged.length = Math.min(merged.length, MAX_EVENTS);
    console.log(`Sources: curated ${curated.length}, ticketmaster ${tm.length}, ics ${ics.length}, venue-pages ${venuePages.length}, calagator ${calagator.length}, everout ${everout.length}`);

    // Prune past one-off events (recurring entries without a year always stay).
    // Multi-day ranges are kept through their end day.
    function isCurrent(e) {
      const s = e.d || '';
      if (!/\d{4}/.test(s)) return true;
      const c = s.replace(/·/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ');
      const m = c.match(/([A-Za-z]{3,})\s+(\d{1,2})(?:\s+(\d{1,2}))?\s+(\d{4})/);
      if (!m) return true;
      const endDay = m[3] || m[2];
      const d = new Date(`${m[1]} ${endDay} ${m[4]} 23:59`);
      return isNaN(d) ? true : d.getTime() >= Date.now() - 86400000;
    }
    const current = merged.filter(isCurrent);

    // Nearest-3 neighbors for the "Nearby events" panel
    for (const ev of current) {
      ev.nb = current
        .filter(o => o.id !== ev.id)
        .map(o => [Math.hypot(ev.lat - o.lat, ev.lng - o.lng), o.id])
        .sort((a, b) => a[0] - b[0])
        .slice(0, 3)
        .map(x => x[1]);
    }

    // Safety guard: no past one-off events may ship. Recurring (no year) exempt.
    const stale = current.filter(e => {
      if (!/\d{4}/.test(e.d)) return false;
      const c = e.d.replace(/[·\-]/g, ' ').replace(/\s+/g, ' ').trim();
      const m = c.match(/([A-Za-z]{3,})\s+(\d{1,2})(?:\s+(\d{1,2}))?\s+(\d{4})/);
      if (!m) return false;
      const end = new Date(`${m[1]} ${m[3] || m[2]} ${m[4]} 23:59`);
      return !isNaN(end) && end.getTime() < Date.now() - 86400000;
    });
    if (stale.length) {
      console.error(`ABORT: ${stale.length} past events would ship: ${stale.map(e => e.n + ' (' + e.d + ')').join('; ')}`);
      process.exit(1);
    }

    const out = { updated: new Date().toISOString(), count: current.length, events: current };
    fs.writeFileSync(path.join(ROOT, 'events.json'), JSON.stringify(out));
    console.log(`Wrote events.json: ${current.length} events (${curated.length} curated, ${merged.length - current.length} past pruned).`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
========== END scripts/fetch-events.js ==========
