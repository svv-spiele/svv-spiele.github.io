#!/usr/bin/env node
/**
 * Fetch upcoming games of a club from fussball.de and write
 * games.json + games.ics into an output directory.
 *
 * Usage:
 *   node scripts/fetch-games.js [--club <id>] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *                               [--months <n>] [--out <dir>]
 *
 * No dependencies. Requires Node.js >= 18 (global fetch).
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_CLUB_ID = '00ES8GN914000083VV0AG08LVUPGND5I'; // SV Vorgebirge 23/25/56 e.V.
const DEFAULT_CLUB_NAME = 'SV Vorgebirge';
const BASE = 'https://www.fussball.de';
const PAGE_SIZE = 500;
const USER_AGENT = 'Mozilla/5.0 (compatible; svvorgebirge-games/1.0; +https://github.com)';
const TZ = 'Europe/Berlin';

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

// ---------- ICS ----------

function icsEscape(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function foldLine(line) {
  // RFC 5545: lines longer than 75 octets are folded.
  const out = [];
  let s = line;
  while (Buffer.byteLength(s, 'utf8') > 75) {
    let cut = 75;
    while (Buffer.byteLength(s.slice(0, cut), 'utf8') > 75) cut--;
    out.push(s.slice(0, cut));
    s = ' ' + s.slice(cut);
  }
  out.push(s);
  return out.join('\r\n');
}

const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

function toIcs(games, calName) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//svvorgebirge-games//fussball.de//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(calName)}`,
    `X-WR-TIMEZONE:${TZ}`,
    ...VTIMEZONE,
  ];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  for (const g of games) {
    const ymd = g.date.replace(/-/g, '');
    const [h, mi] = g.time.split(':').map(Number);
    const endMin = h * 60 + mi + 120;
    const start = `${ymd}T${g.time.replace(':', '')}00`;
    const end = `${ymd}T${String(Math.floor(endMin / 60) % 24).padStart(2, '0')}${String(endMin % 60).padStart(2, '0')}00`;
    const summary = `${g.home?.name ?? '?'} : ${g.away?.name ?? '?'}`;
    const desc = [
      `${g.ageGroup} | ${g.competition}`,
      g.matchType ? `${g.matchType} | ${g.matchNumber}` : null,
      g.gameUrl,
    ]
      .filter(Boolean)
      .join('\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${g.gameId || `${g.date}-${g.time}-${g.home?.teamId}`}@fussball.de`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=${TZ}:${start}`,
      `DTEND;TZID=${TZ}:${end}`,
      `SUMMARY:${icsEscape(summary)}`,
      `DESCRIPTION:${icsEscape(desc)}`,
      g.venue ? `LOCATION:${icsEscape(g.venue)}` : null,
      g.gameUrl ? `URL:${g.gameUrl}` : null,
      `CATEGORIES:${icsEscape(g.ageGroup)}`,
      g.preliminary ? 'STATUS:TENTATIVE' : 'STATUS:CONFIRMED',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.filter(Boolean).map(foldLine).join('\r\n') + '\r\n';
}

// ---------- Main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const clubId = args.club || DEFAULT_CLUB_ID;
  const clubName = args.name || DEFAULT_CLUB_NAME;
  const from = args.from || todayBerlin();
  const to = args.to || addMonths(from, Number(args.months || 12));
  const outDir = args.out || path.join(__dirname, '..', 'public');

  const html = await fetchAllHtml(clubId, from, to);
  const games = parseGames(html, clubName);

  fs.mkdirSync(outDir, { recursive: true });

  const json = {
    club: { id: clubId, name: clubName, url: `${BASE}/verein/-/id/${clubId}` },
    generatedAt: new Date().toISOString(),
    from,
    to,
    count: games.length,
    games,
  };
  fs.writeFileSync(path.join(outDir, 'games.json'), JSON.stringify(json, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'games.ics'), toIcs(games, `${clubName} Spiele`));

  console.log(`Wrote ${games.length} games (${from} .. ${to}) to ${outDir}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
