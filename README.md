# happeningpdx

Portland event discovery map. Static site + daily self-refreshing event data.

## How it works
- `index.html` — the whole app. Loads `events.json` at runtime; falls back to embedded events if it can't.
- `scripts/fetch-events.js` — pulls Portland events from Ticketmaster Discovery API, merges `data/curated.json`, writes `events.json`.
- `.github/workflows/refresh-events.yml` — runs the script every morning and commits the result. Netlify redeploys automatically.
- `data/curated.json` — recurring fixtures (markets, weeklies) and hand-added events. **Set `"promo": true` on any entry to make it Featured** — this is the paid-placement lever.
- `data/feeds.json` — **any public iCal/.ics link becomes an automated source.** Most venue Google Calendars and org sites expose one ("Add to calendar"). Add `{"url": "...", "category": "community"}`, optionally `venue`/`lat`/`lng` for feeds missing location data. This is the most reliable way to ingest community calendars.
- `data/venues.json` — venue-name → coordinates registry (52 seeded). Events from feeds or EverOut at unrecognized venues are skipped and logged; add the venue here once and every future event there resolves.
- `data/venue-pages.json` — **independent venue calendars.** Most venue sites embed schema.org Event data for Google; the pipeline reads it. Ten Portland venues are seeded (Doug Fir, Mississippi Studios, Holocene, Aladdin, Revolution Hall, Crystal, Wonder, Alberta Rose, Hollywood Theatre, Polaris). Add any venue with `{"url": "...", "venue": "...", "category": "music", "lat": ..., "lng": ...}`. Check `[jsonld]` lines in the Action log — sites that publish structured data show `N found, N kept`; ones that don't show `0 found` and can be disabled with `"enabled": false`.
- **Calagator** (calagator.org) is pulled automatically — a community-run, CC-licensed Portland calendar with an open JSON API. No key, no config.
- The pipeline also attempts EverOut (Portland Mercury's calendar) across six categories. It's experimental — if their site blocks the runner you'll see `[everout] ... -> HTTP 4xx` in the Action log and everything else proceeds normally. Dedupe priority: curated > Ticketmaster > calendar feeds > venue pages > Calagator > EverOut.

## One-time setup (~15 minutes)
1. **Ticketmaster API key** (free): developer.ticketmaster.com → create account → new app → copy the Consumer Key.
2. **GitHub**: create a repo (e.g. `happeningpdx`) and upload this folder's contents.
3. **Repo secret**: GitHub repo → Settings → Secrets and variables → Actions → New repository secret → name `TM_API_KEY`, value = your key.
4. **Netlify**: app.netlify.com → Add new site → **Import an existing project** → pick the GitHub repo. Build command: none. Publish directory: `.`
5. **First run**: GitHub repo → Actions tab → "Refresh events" → Run workflow. Within a minute `events.json` updates and Netlify deploys it.

From then on it refreshes itself daily. To add or feature an event, edit `data/curated.json` in GitHub and commit.

## Local run
```
TM_API_KEY=yourkey node scripts/fetch-events.js
```
Without a key it writes curated events only (still valid — the site works day one).
