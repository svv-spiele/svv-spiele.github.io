# SV Vorgebirge – Spielplan

Static web page that lists all upcoming games of SV Vorgebirge 23/25/56 e.V.
The data comes from fussball.de. GitHub Actions fetches the data every 3 hours
and deploys the page to GitHub Pages.

## How it works

1. `scripts/fetch-games.js` calls the fussball.de endpoint
   `ajax.club.matchplan.loadmore` for the club ID with a 12-month date range.
   It parses the HTML fragment and writes `public/games.json` and the calendar
   files (see below). If it finds no games, it exits with an error and writes nothing.
2. `.github/workflows/pages.yml` runs the script on a schedule and deploys the
   `public/` directory to GitHub Pages.
3. `public/index.html` loads `games.json` and renders the games. It has filters
   for teams (several can be selected), home/away, date range, and a text search. Colors follow
   svvorgebirge.de (navy `#0a2974`, gold `#dabc49`). `public/logo.png` is the
   club crest from svvorgebirge.de.

`public/ics.js` holds the game filter and the ICS generator. The page and the
fetch script both use it, so the calendar files contain the same games as the
list on the page.

fussball.de sends no CORS headers. A browser cannot call the endpoint directly.
This is the reason for the fetch step in GitHub Actions.

## Error notification

When the fetch finds no games (fussball.de is down, or its page layout has
changed), the script exits with code 1. The workflow run fails, the deploy job
is skipped, and the last good version of the page stays online.

GitHub emails a failed scheduled run to the user who last changed the `cron`
line in the workflow. Check **Settings → Notifications → Actions** in your
GitHub account if no email arrives.

## Publish on GitHub Pages

1. Create a new GitHub repository and push this project to the `main` branch.
2. Open **Settings → Pages**. Set **Source** to **GitHub Actions**.
3. Open **Actions**, select the workflow, and click **Run workflow** for the first deploy.
   Later runs start automatically every 3 hours and on each push.

The page URL is `https://<user>.github.io/<repo>/`.

## Calendar

The page offers two ways to get the games into a calendar:

- **Kalender (ICS)** downloads the games that the page shows right now. All
  filters apply: teams, home/away, date range, and search. The file is made in
  the browser and does not update.
- **Abonnieren** opens a `webcal://` subscription that updates with each
  workflow run. A subscription needs a fixed URL, so the workflow writes one
  file per team and home/away choice. The team and home/away filters apply;
  the date range and search do not. With several teams selected, the page shows
  one subscription link per team.

Files written by the fetch script:

| File | Content |
| --- | --- |
| `games.ics` | all games (old URL, kept for existing subscriptions) |
| `cal/alle.ics`, `cal/alle-heim.ics`, `cal/alle-auswaerts.ics` | all teams |
| `cal/<team>.ics`, `cal/<team>-heim.ics`, `cal/<team>-auswaerts.ics` | one team |

`<team>` is the team name as a slug, for example `sv-vorgebirge-u11`.
`games.json` lists the paths under `feeds`.

## Local use

```bash
npm run fetch      # writes public/games.json and the calendar files
npm run serve      # fetch + serve public/ on http://localhost:3000
npm test           # tests with a saved HTML fixture, no network
```

Script options:

```
node scripts/fetch-games.js [--club <id>] [--name <club name>]
                            [--from YYYY-MM-DD] [--to YYYY-MM-DD]
                            [--months <n>] [--out <dir>]
                            [--html <file>] [--allow-empty]
```

`--html` parses a saved HTML fragment instead of calling fussball.de.
`--allow-empty` writes the files even when no games are found.

## Other clubs

Change `DEFAULT_CLUB_ID` and `DEFAULT_CLUB_NAME` in `scripts/fetch-games.js`,
or pass `--club` and `--name`. The club ID is in the fussball.de club URL:
`https://www.fussball.de/verein/<slug>/-/id/<CLUB_ID>`.
