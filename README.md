# SV Vorgebirge – Spielplan

Static web page that lists all upcoming games of SV Vorgebirge 23/25/56 e.V.
The data comes from fussball.de. GitHub Actions fetches the data every 3 hours
and deploys the page to GitHub Pages.

## How it works

1. `scripts/fetch-games.js` calls the fussball.de endpoint
   `ajax.club.matchplan.loadmore` for the club ID with a 12-month date range.
   It parses the HTML fragment and writes `public/games.json` and `public/games.ics`.
2. `.github/workflows/pages.yml` runs the script on a schedule and deploys the
   `public/` directory to GitHub Pages.
3. `public/index.html` loads `games.json` and renders the games. It has filters
   for team, home/away, date range, and a text search. Colors follow
   svvorgebirge.de (navy `#0a2974`, gold `#dabc49`). `public/logo.png` is the
   club crest from fussball.de.

fussball.de sends no CORS headers. A browser cannot call the endpoint directly.
This is the reason for the fetch step in GitHub Actions.

## Publish on GitHub Pages

1. Create a new GitHub repository and push this project to the `main` branch.
2. Open **Settings → Pages**. Set **Source** to **GitHub Actions**.
3. Open **Actions**, select the workflow, and click **Run workflow** for the first deploy.
   Later runs start automatically every 3 hours and on each push.

The page URL is `https://<user>.github.io/<repo>/`.

## Calendar subscription

The page offers `games.ics`. Subscribe with
`webcal://<user>.github.io/<repo>/games.ics` in Apple Calendar, Google Calendar,
or Outlook. The calendar updates with each workflow run.

## Local use

```bash
npm run fetch      # writes public/games.json and public/games.ics
npm run serve      # fetch + serve public/ on http://localhost:3000
```

Script options:

```
node scripts/fetch-games.js [--club <id>] [--name <club name>]
                            [--from YYYY-MM-DD] [--to YYYY-MM-DD]
                            [--months <n>] [--out <dir>]
```

## Other clubs

Change `DEFAULT_CLUB_ID` and `DEFAULT_CLUB_NAME` in `scripts/fetch-games.js`,
or pass `--club` and `--name`. The club ID is in the fussball.de club URL:
`https://www.fussball.de/verein/<slug>/-/id/<CLUB_ID>`.
