# Destiny stream watch

A tiny static page that tracks how often Destiny starts stream on time.
Scheduled start: **1:00 PM Miami time** (`America/New_York`).
On time means **1:09 PM or earlier**; arriving early also counts.

- GitHub-style year grid, pastel tiles, every tile shows its `+H:MM` / `-H:MM`
- Stats: on-time days, average lateness, longest wait, stream days
- No framework, no build step, no dependencies — just HTML, CSS, and a little JS

## How the data works

Data lives in [`data/streams.json`](data/streams.json) and is collected from
Kick's public channel API by
[`.github/workflows/track.yml`](.github/workflows/track.yml) every 15 minutes.
Kick exposes the real stream start time, so a late-running GitHub Actions job
does not make a stream look later than it was.

A few rules the site applies to the raw start times:

| Rule | Meaning |
| --- | --- |
| Timezone | All comparisons use `America/New_York`, so DST is handled |
| On time | `start <= 1:09 PM` (early counts) |
| Late-night starts | A start before 9:00 AM is measured against the **previous** day's 1 PM slot, so a 2 AM stream shows as ~13 hours late instead of "early" |
| Two streams in one day | Only the first one is measured; the second doesn't affect stats |
| No stream | Grey tile, excluded from every average |
| Not tracked | Very light tile; the tracker didn't exist yet |

Because Kick only exposes roughly the last 26 VODs, history starts when the
tracker was first run (Oct 19, 2026 in the included data). It fills in as time
goes on.

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

- Only Kick is tracked. YouTube live streams aren't exposed through a public
  feed without an API key, and these days the stream is simulcast on Kick.
- The Kick endpoint is the same public one the website uses. If Kick changes or
  blocks it, the workflow fails and the page keeps showing the last known data.
- Streams shorter than 10 minutes are ignored (usually test streams).
- If a stream starts and ends entirely between two checks, Kick's VOD list still
  catches it on the next run.
- Unofficial fan project, not affiliated with Destiny.
