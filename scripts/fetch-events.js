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
const SEATGEEK_ID = process.env.SEATGEEK_CLIENT_ID || '';
const CENTER = '45.5231,-122.6765'; // Portland
const RADIUS_MILES = 30;
const DAYS_AHEAD = 365;
const MAX_EVENTS = 600;

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
  for (let page = 0; page < 5; page++) {
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
