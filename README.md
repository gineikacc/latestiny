# latestiny

A tiny static page that tracks how often Destiny starts stream on time.
Scheduled start: **1:00 PM Miami time** (`America/New_York`).
On time means **1:09 PM or earlier**; arriving early also counts.

- Two layouts: GitHub-style year grid and month-by-month view (defaults to the month view with 6 months per row; 3 and 4 are also selectable)
- Month headers show each month's average lateness
- Monday-first weeks, square color tiles, every tile shows its lateness (`-H:MM` when early)
- Stats: on-time days, average lateness, longest wait, stream days
- No framework, no build step, no dependencies — just HTML, CSS, and a little JS

## How the data works

Data lives in [`data/streams.json`](data/streams.json) and combines three
sources:

| Period | Source | Precision |
| --- | --- | --- |
| Jan 1 – Mar 22, 2026 | [Last Week on Destiny](https://drive.google.com/drive/folders/1ps_MLBmyGmdwlMSj-AfkAfm5fXWjls-J) (LWOD) community spreadsheets | minute |
| Mar 23 – Nov 17, 2026 | [KickTracker](https://kicktracker.net/destiny/streams) stream history, cross-checked against LWOD | second |
| Ongoing | Kick public channel API via [`.github/workflows/track.yml`](.github/workflows/track.yml) | second |

KickTracker and Kick expose the real stream start time, so a late-running
GitHub Actions job does not make a stream look later than it was. LWOD records
times in Miami local time; they were converted with `America/New_York`, so the
2026 spring-forward and fall-back transitions are handled correctly.
KickTracker has a few gaps, so LWOD fills those days, and an earlier LWOD event
is kept when it predates the KickTracker stream.

The workflow polls Kick every 15 minutes and commits `data/streams.json` only
when something changes. When Kick supplies a start time for a day that already
has an archived start, it replaces the archive entry. A genuinely separate
earlier stream that day is kept.

A few rules the site applies to the raw start times:

| Rule | Meaning |
| --- | --- |
| Timezone | All comparisons use `America/New_York`, so DST is handled |
| On time | `start <= 1:09 PM` (early counts) |
| Late-night starts | A start before 9:00 AM is measured against the **previous** day's 1 PM slot, so a 2 AM stream shows as ~13 hours late instead of "early" |
| Two streams in one day | Only the first one is measured; the second doesn't affect stats |
| No stream | Gray tile, excluded from every average |
| Missing start time | Dashed tile: a stream happened but no archived start time exists; excluded from stats |
| Not tracked | Very light tile; the tracker didn't exist yet |

## Run it locally

```sh
npm run update   # refresh data/streams.json from Kick
npm run serve    # http://localhost:8000
```

You need a local server because the page fetches `data/streams.json`; opening
`index.html` directly will show a load error.

## Deploy to GitHub Pages

1. Push this folder to a public GitHub repository.
2. Repo **Settings → Pages → Build and deployment**:
   - Source: **Deploy from a branch**
   - Branch: **main**, folder: **/ (root)**
3. In **Settings → Actions → General**, make sure workflows can write to the
   repository (the default `GITHUB_TOKEN` with `contents: write` is enough).
4. Done. The scheduled workflow commits `data/streams.json` when a new stream
   appears, and Pages redeploys automatically.

## Caveats

- KickTracker and LWOD are unofficial community archives. Their timestamps are
  usually accurate to the minute, but they can occasionally be off by a minute
  or, in rare cases, an hour. Kick's own start time is preferred when available.
- One known gap: **July 10, 2026**. The LWOD landing page records a ~3h57m
  stream, but neither archive has its start time. It is shown as a dashed tile
  and left out of the stats.
- The ongoing poller only sees Kick's roughly 26 most recent VODs. The
  historical backfill is already in the repository, so this only affects new
  streams.
- Streams shorter than 10 minutes are ignored (usually test streams).
- YouTube-only streams that never reached Kick may be missing.
- If a stream starts and ends entirely between two checks, Kick's VOD list still
  catches it on the next run.
- Unofficial fan project, not affiliated with Destiny.
