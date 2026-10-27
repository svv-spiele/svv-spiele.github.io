'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const lib = require('../public/ics.js');
const { parseGames, feedBases } = require('../scripts/fetch-games.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'fetch-games.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'matchplan.html');
const games = parseGames(fs.readFileSync(FIXTURE, 'utf8'), 'SV Vorgebirge');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'svv-test-'));
}
function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}
function eventUids(ics) {
  return [...ics.matchAll(/^UID:(.*)$/gm)].map((m) => m[1].trim());
}

test('parser reads the fixture', () => {
  assert.equal(games.length, 4);
  assert.deepEqual(
    games.map((g) => [g.ownTeam, g.isHome]),
    [
      ['SV Vorgebirge U11', true],
      ['SV Vorgebirge U13', false],
      ['SV Vorgebirge', true],
      ['SV Vorgebirge U11', false],
    ],
  );
  assert.equal(games[1].home.name, 'FC Auswärts & Söhne');
  assert.equal(games[2].preliminary, true);
});

test('filter: several teams', () => {
  const r = lib.filterGames(games, { teams: ['SV Vorgebirge U11', 'SV Vorgebirge U13'] });
  assert.deepEqual(r.map((g) => g.gameId), ['GAME001', 'GAME002', 'GAME004']);
});

test('filter: no team selected means all teams', () => {
  assert.equal(lib.filterGames(games, { teams: [] }).length, 4);
  assert.equal(lib.filterGames(games, {}).length, 4);
});

test('filter: teams + home/away + date range + search', () => {
  const u11 = ['SV Vorgebirge U11'];
  assert.deepEqual(lib.filterGames(games, { teams: u11, ha: 'home' }).map((g) => g.gameId), ['GAME001']);
  assert.deepEqual(lib.filterGames(games, { teams: u11, ha: 'away' }).map((g) => g.gameId), ['GAME004']);
  assert.deepEqual(lib.filterGames(games, { from: '2026-11-08', until: '2026-11-14' }).map((g) => g.gameId), ['GAME002', 'GAME003']);
  assert.deepEqual(lib.filterGames(games, { q: 'meckenheim' }).map((g) => g.gameId), ['GAME004']);
});

test('calendar name and short team names', () => {
  assert.equal(lib.shortTeam('SV Vorgebirge U11', 'SV Vorgebirge'), 'U11');
  assert.equal(lib.shortTeam('SV Vorgebirge', 'SV Vorgebirge'), 'SV Vorgebirge');
  assert.equal(
    lib.calendarName('SV Vorgebirge', { teams: ['SV Vorgebirge U11', 'SV Vorgebirge U13'], ha: 'home' }),
    'SV Vorgebirge Spiele – U11, U13 (Heim)',
  );
  assert.equal(lib.calendarName('SV Vorgebirge', {}), 'SV Vorgebirge Spiele');
});

test('slugs and feed paths', () => {
  assert.equal(lib.slugify('SV Vorgebirge U11 (9er)'), 'sv-vorgebirge-u11-9er');
  assert.equal(lib.slugify('Fußball Köln'), 'fussball-koeln');
  assert.equal(lib.feedPath('cal/alle', ''), 'cal/alle.ics');
  assert.equal(lib.feedPath('cal/x', 'home'), 'cal/x-heim.ics');
  assert.equal(lib.feedPath('cal/x', 'away'), 'cal/x-auswaerts.ics');
  const f = feedBases([{ ownTeam: 'A B' }, { ownTeam: 'A-B' }, { ownTeam: null }]);
  assert.deepEqual(f, { all: 'cal/alle', teams: { 'A B': 'cal/a-b', 'A-B': 'cal/a-b-2' } });
});

test('ICS: folding, escaping, end after midnight', () => {
  const ics = lib.toIcs(games, 'Test, Kalender', new Date('2026-10-27T08:00:00Z'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
  assert.match(ics, /X-WR-CALNAME:Test\\, Kalender/);
  // 23:30 + 2h ends the next day at 01:30
  assert.match(ics, /DTSTART;TZID=Europe\/Berlin:20261108T233000\r\nDTEND;TZID=Europe\/Berlin:20261109T013000/);
  assert.match(ics, /SUMMARY:FC Auswärts & Söhne : SV Vorgebirge U13/);
  assert.match(ics, /STATUS:TENTATIVE/);
  // folding must not cut a multi-byte character
  const long = lib.foldLine('X:' + 'ü'.repeat(100));
  assert.equal(long.replace(/\r\n /g, ''), 'X:' + 'ü'.repeat(100));
});

test('script writes per-team feeds with the same filter as the page', () => {
  const out = tmpDir();
  const r = run(['--html', FIXTURE, '--out', out, '--from', '2026-11-01', '--to', '2027-11-01']);
  assert.equal(r.status, 0, r.stderr);

  const json = JSON.parse(fs.readFileSync(path.join(out, 'games.json'), 'utf8'));
  assert.equal(json.count, 4);
  assert.equal(json.feeds.teams['SV Vorgebirge U11'], 'cal/sv-vorgebirge-u11');

  const read = (rel) => fs.readFileSync(path.join(out, rel), 'utf8');
  assert.deepEqual(eventUids(read('games.ics')).length, 4);
  assert.deepEqual(eventUids(read('cal/alle.ics')).length, 4);
  assert.deepEqual(eventUids(read('cal/alle-heim.ics')), ['GAME001@fussball.de', 'GAME003@fussball.de']);
  assert.deepEqual(eventUids(read('cal/sv-vorgebirge-u11.ics')), ['GAME001@fussball.de', 'GAME004@fussball.de']);
  assert.deepEqual(eventUids(read('cal/sv-vorgebirge-u11-auswaerts.ics')), ['GAME004@fussball.de']);
  assert.deepEqual(eventUids(read('cal/sv-vorgebirge-u13-heim.ics')), []);
  assert.match(read('cal/sv-vorgebirge-u11-heim.ics'), /X-WR-CALNAME:SV Vorgebirge Spiele – U11 \(Heim\)/);
  // 3 teams × 3 + "alle" × 3 = 12 feeds
  assert.equal(fs.readdirSync(path.join(out, 'cal')).length, 12);
});

test('script fails and writes nothing when no games are found', () => {
  for (const html of ['', '<table><tr><td>Neues Layout</td></tr></table>']) {
    const out = tmpDir();
    const empty = path.join(out, 'empty.html');
    fs.writeFileSync(empty, html);
    const r = run(['--html', empty, '--out', path.join(out, 'public')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /::error::No games found/);
    assert.equal(fs.existsSync(path.join(out, 'public', 'games.json')), false);
  }
});

test('--allow-empty writes an empty schedule', () => {
  const out = tmpDir();
  const empty = path.join(out, 'empty.html');
  fs.writeFileSync(empty, '');
  const r = run(['--html', empty, '--out', path.join(out, 'public'), '--allow-empty']);
  assert.equal(r.status, 0, r.stderr);
  const json = JSON.parse(fs.readFileSync(path.join(out, 'public', 'games.json'), 'utf8'));
  assert.equal(json.count, 0);
});
