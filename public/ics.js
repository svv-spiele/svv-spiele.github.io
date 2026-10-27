/**
 * Shared game filter and ICS generator.
 *
 * Used by the page (window.SvvGames) and by scripts/fetch-games.js
 * (require). Both sides use the same filter, so the calendar files and the
 * calendar download contain the same games as the list on the page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SvvGames = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TZ = 'Europe/Berlin';
  const GAME_MINUTES = 120;

  // ---------- Filter ----------

  /**
   * Filter options:
   *   teams  – array of own team names; empty = all teams
   *   ha     – '' | 'home' | 'away'
   *   q      – free text search
   *   from   – YYYY-MM-DD, games before this date are dropped (optional)
   *   until  – YYYY-MM-DD, games after this date are dropped (optional)
   */
  function matches(g, f) {
    const teams = (f && f.teams) || [];
    const ha = (f && f.ha) || '';
    const q = String((f && f.q) || '').trim().toLowerCase();
    if (f && f.from && g.date < f.from) return false;
    if (f && f.until && g.date > f.until) return false;
    if (teams.length && !teams.includes(g.ownTeam)) return false;
    if (ha === 'home' && g.isHome !== true) return false;
    if (ha === 'away' && g.isHome !== false) return false;
    if (q) {
      const hay = [g.home && g.home.name, g.away && g.away.name, g.ageGroup, g.competition, g.venue, g.ownTeam]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function filterGames(games, f) {
    return games.filter((g) => matches(g, f));
  }

  // ---------- Names ----------

  /** "SV Vorgebirge U11" -> "U11" (club name prefix removed). */
  function shortTeam(name, clubName) {
    const n = String(name || '').trim();
    const c = String(clubName || '').trim();
    if (c && n.toLowerCase().startsWith(c.toLowerCase())) {
      const rest = n.slice(c.length).trim();
      if (rest) return rest;
    }
    return n;
  }

  /** Calendar title for a filter, e.g. "SV Vorgebirge Spiele – U11, U13 (Heim)". */
  function calendarName(clubName, f) {
    const teams = (f && f.teams) || [];
    const ha = (f && f.ha) || '';
    let name = `${clubName} Spiele`;
    if (teams.length) name += ' – ' + teams.map((t) => shortTeam(t, clubName)).join(', ');
    if (ha === 'home') name += ' (Heim)';
    if (ha === 'away') name += ' (Auswärts)';
    return name;
  }

  /** File-name friendly slug: "SV Vorgebirge U11 (9er)" -> "sv-vorgebirge-u11-9er". */
  function slugify(s) {
    return (
      String(s || '')
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'team'
    );
  }

  /** Path of a subscription feed: base "cal/alle" + ha -> "cal/alle-heim.ics". */
  function feedPath(base, ha) {
    const suffix = ha === 'home' ? '-heim' : ha === 'away' ? '-auswaerts' : '';
    return `${base}${suffix}.ics`;
  }

  // ---------- ICS ----------

  function icsEscape(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  const encoder = new TextEncoder();

  /** RFC 5545: fold lines longer than 75 octets. Never splits a character. */
  function foldLine(line) {
    const out = [];
    let cur = '';
    let bytes = 0;
    for (const ch of line) {
      const b = encoder.encode(ch).length;
      if (bytes + b > 75) {
        out.push(cur);
        cur = ' ';
        bytes = 1;
      }
      cur += ch;
      bytes += b;
    }
    out.push(cur);
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

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  /** Local end date/time, rolling over to the next day if needed. */
  function endOf(date, time) {
    const [y, mo, d] = date.split('-').map(Number);
    const [h, mi] = time.split(':').map(Number);
    const dt = new Date(Date.UTC(y, mo - 1, d, h, mi + GAME_MINUTES));
    return (
      `${dt.getUTCFullYear()}${pad2(dt.getUTCMonth() + 1)}${pad2(dt.getUTCDate())}` +
      `T${pad2(dt.getUTCHours())}${pad2(dt.getUTCMinutes())}00`
    );
  }

  function toIcs(games, calName, now) {
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
    const stamp = (now || new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    for (const g of games) {
      const start = `${g.date.replace(/-/g, '')}T${g.time.replace(':', '')}00`;
      const summary = `${(g.home && g.home.name) || '?'} : ${(g.away && g.away.name) || '?'}`;
      const desc = [
        `${g.ageGroup} | ${g.competition}`,
        g.matchType ? `${g.matchType} | ${g.matchNumber}` : null,
        g.gameUrl,
      ]
        .filter(Boolean)
        .join('\n');
      lines.push(
        'BEGIN:VEVENT',
        `UID:${g.gameId || `${g.date}-${g.time}-${g.home && g.home.teamId}`}@fussball.de`,
        `DTSTAMP:${stamp}`,
        `DTSTART;TZID=${TZ}:${start}`,
        `DTEND;TZID=${TZ}:${endOf(g.date, g.time)}`,
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

  return {
    TZ,
    matches,
    filterGames,
    shortTeam,
    calendarName,
    slugify,
    feedPath,
    icsEscape,
    foldLine,
    toIcs,
  };
});
