#!/usr/bin/env node
/**
 * Fetch upcoming games of a club from fussball.de and write into an output directory:
 *   games.json              all games
 *   games.ics               all games (kept for existing subscriptions)
 *   cal/alle[-heim|-auswaerts].ics
 *   cal/<team>[-heim|-auswaerts].ics   one feed per own team and home/away choice
 *
 * Usage:
 *   node scripts/fetch-games.js [--club <id>] [--name <club name>]
 *                               [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *                               [--months <n>] [--out <dir>]
 *                               [--html <file>] [--allow-empty]
 *
 * --html <file>   parse a saved fussball.de HTML fragment instead of fetching
 * --allow-empty   do not fail when no games are found
 *
 * Exits with code 1 when no games are found, so a broken fetch or a changed
 * page layout fails the workflow instead of publishing an empty schedule.
 *
 * No dependencies. Requires Node.js >= 18 (global fetch).
 */

const fs = require('fs');
const path = require('path');
const { filterGames, calendarName, slugify, feedPath, toIcs } = require('../public/ics.js');

const DEFAULT_CLUB_ID = '00ES8GN914000083VV0AG08LVUPGND5I'; // SV Vorgebirge 23/25/56 e.V.
const DEFAULT_CLUB_NAME = 'SV Vorgebirge';
const BASE = 'https://www.fussball.de';
const PAGE_SIZE = 500;
const USER_AGENT = 'Mozilla/5.0 (compatible; svvorgebirge-games/1.0; +https://github.com)';
const TZ = 'Europe/Berlin';
const FEED_DIR = 'cal';
const HA_CHOICES = ['', 'home', 'away'];

// ---------- CLI ----------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      args[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
  }
  return args;
}

/** Today's date in Europe/Berlin as YYYY-MM-DD. */
function todayBerlin() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, d));
  return dt.toISOString().slice(0, 10);
}

// ---------- Fetch ----------

function buildUrl(clubId, from, to, offset) {
  return (
    `${BASE}/ajax.club.matchplan.loadmore/-` +
    `/datum-bis/${to}/datum-von/${from}/id/${clubId}` +
    `/match-type/-1/mime-type/JSON/mode/PAGE/show-venues/true` +
    `/max/${PAGE_SIZE}/offset/${offset}`
  );
}

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const data = await res.json();
  if (!data.success) throw new Error(`fussball.de returned success=false for ${url}`);
  return data;
}

async function fetchAllHtml(clubId, from, to) {
  let offset = 0;
  let html = '';
  for (;;) {
    const data = await fetchPage(buildUrl(clubId, from, to, offset));
    html += data.html || '';
    if (data.final || !data.html) break;
    offset += PAGE_SIZE;
  }
  return html;
}

// ---------- Parse ----------

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

function text(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function parseGames(html, clubName) {
  // Each game starts with a "row-headline" row.
  const blocks = html.split(/<tr class="row-headline visible-small">/).slice(1);
  const games = [];

  for (const block of blocks) {
    const headline = text((block.match(/<td colspan="6">([\s\S]*?)<\/td>/) || [])[1] || '');
    // "Samstag, 12.09.2026 - 12:00 Uhr | D-Junioren | 1.Kreisklasse"
    const m = headline.match(/^(\w+), (\d{2})\.(\d{2})\.(\d{4}) - (\d{2}):(\d{2}) Uhr \| (.*?) \| (.*)$/);
    if (!m) continue;
    const [, , dd, mm, yyyy, HH, MM, ageGroup, competition] = m;

    const codeMatch = block.match(/<td colspan="2">\s*<a>([^<]*)<\/a>/);
    const [matchType, matchNumber] = codeMatch
      ? text(codeMatch[1]).split('|').map((s) => s.trim())
      : [null, null];

    const clubs = [...block.matchAll(/<td class="column-club[^"]*">([\s\S]*?)<\/td>/g)].map((c) => {
      const inner = c[1];
      return {
        name: text((inner.match(/<div class="club-name">([\s\S]*?)<\/div>/) || [])[1] || ''),
        url: (inner.match(/href="([^"]+)"/) || [])[1] || null,
        teamId: (inner.match(/team-id\/([A-Z0-9]+)/) || [])[1] || null,
      };
    });
    const home = clubs[0] || null;
    const away = clubs[1] || null;

    const gameUrl = (block.match(/<td class="column-score">\s*<a href="([^"]+)"/) || [])[1] || null;
    const gameId = gameUrl ? (gameUrl.match(/\/spiel\/([A-Z0-9]+)$/) || [])[1] || null : null;

    const venueRow = block.match(/row-venue[^>]*>[\s\S]*?<td colspan="3">([\s\S]*?)<\/td>/);
    const venue = venueRow ? text(venueRow[1]) : null;

    const isOwn = (t) => t && t.name.toLowerCase().includes(clubName.toLowerCase());
    const ownTeam = isOwn(home) ? home : isOwn(away) ? away : null;

    games.push({
      date: `${yyyy}-${mm}-${dd}`,
      time: `${HH}:${MM}`,
      ageGroup,
      competition,
      matchType,
      matchNumber,
      home,
      away,
      ownTeam: ownTeam ? ownTeam.name : null,
      isHome: ownTeam ? ownTeam === home : null,
      venue,
      gameId,
      gameUrl,
      preliminary: /icon-pre-publish/.test(block),
      spielfrei: /SPIELFREI/.test(block),
    });
  }
  return games;
}

// ---------- Calendar feeds ----------

/**
 * Base paths (without "-heim"/"-auswaerts" and ".ics") of the subscription
 * feeds: one for all games and one per own team. Team slugs are made unique.
 */
function feedBases(games) {
  const teams = [...new Set(games.map((g) => g.ownTeam).filter(Boolean))].sort();
  const used = new Set(['alle']);
  const byTeam = {};
  for (const t of teams) {
    const base = slugify(t);
    let slug = base;
    for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
    used.add(slug);
    byTeam[t] = `${FEED_DIR}/${slug}`;
  }
  return { all: `${FEED_DIR}/alle`, teams: byTeam };
}

/** Write all feeds. Returns the list of written paths (relative to outDir). */
function writeFeeds(outDir, games, clubName, feeds, now) {
  const dir = path.join(outDir, FEED_DIR);
  fs.rmSync(dir, { recursive: true, force: true }); // drop feeds of teams that are gone
  fs.mkdirSync(dir, { recursive: true });

  const written = [];
  const write = (rel, filter) => {
    const ics = toIcs(filterGames(games, filter), calendarName(clubName, filter), now);
    fs.writeFileSync(path.join(outDir, rel), ics);
    written.push(rel);
  };

  for (const ha of HA_CHOICES) {
    write(feedPath(feeds.all, ha), { teams: [], ha });
    for (const [team, base] of Object.entries(feeds.teams)) {
      write(feedPath(base, ha), { teams: [team], ha });
    }
  }
  // Old URL, kept so that existing subscriptions keep working.
  write('games.ics', { teams: [], ha: '' });
  return written;
}

// ---------- Main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const clubId = args.club || DEFAULT_CLUB_ID;
  const clubName = args.name || DEFAULT_CLUB_NAME;
  const from = args.from || todayBerlin();
  const to = args.to || addMonths(from, Number(args.months || 12));
  const outDir = args.out || path.join(__dirname, '..', 'public');

  const html = args.html ? fs.readFileSync(args.html, 'utf8') : await fetchAllHtml(clubId, from, to);
  const games = parseGames(html, clubName);

  if (!games.length && !args['allow-empty']) {
    const reason = html.trim()
      ? `fussball.de returned ${html.length} bytes of HTML, but no game could be parsed. The page layout may have changed.`
      : 'fussball.de returned no games.';
    // "::error::" shows up as an annotation in the GitHub Actions run summary.
    console.error(`::error::No games found for club ${clubId} (${from} .. ${to}). ${reason}`);
    console.error('Nothing was written. Use --allow-empty to write an empty schedule anyway.');
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });

  const now = new Date();
  const feeds = feedBases(games);
  const json = {
    club: { id: clubId, name: clubName, url: `${BASE}/verein/-/id/${clubId}` },
    generatedAt: now.toISOString(),
    from,
    to,
    count: games.length,
    feeds,
    games,
  };
  fs.writeFileSync(path.join(outDir, 'games.json'), JSON.stringify(json, null, 2) + '\n');
  const written = writeFeeds(outDir, games, clubName, feeds, now);

  console.log(`Wrote ${games.length} games (${from} .. ${to}) and ${written.length} calendar files to ${outDir}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { parseGames, feedBases, writeFeeds };
