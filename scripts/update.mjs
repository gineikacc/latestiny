#!/usr/bin/env node
// Pulls Destiny's stream starts from Kick's public API and updates data/streams.json.
// Runs in GitHub Actions on a schedule; safe to run manually at any time.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'data', 'streams.json');

const SLUG = process.env.KICK_SLUG ?? 'destiny';
const MIN_DURATION_SECONDS = 10 * 60; // ignore accidental sub-10-minute test streams
const DEDUPE_WINDOW_MS = 90 * 60 * 1000; // same stream, different source

const localDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function localDateKey(iso) {
  const parts = localDateFmt.formatToParts(new Date(iso));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function getJson(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: `https://kick.com/${SLUG}`,
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
      return await res.json();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastError;
}

// Kick returns UTC timestamps without a zone, e.g. "2026-11-17 18:29:41".
function kickDate(value) {
  const date = new Date(`${String(value).replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Bad Kick timestamp: ${value}`);
  return date.toISOString();
}

function makeEntry({ id, start, duration, title }) {
  return {
    id: `kick-${id}`,
    start,
    duration: Number.isFinite(duration) ? duration : null,
    title: String(title ?? '').trim() || null,
    source: 'kick',
  };
}

async function main() {
  const [channel, videos] = await Promise.all([
    getJson(`https://kick.com/api/v2/channels/${encodeURIComponent(SLUG)}`),
    getJson(`https://kick.com/api/v2/channels/${encodeURIComponent(SLUG)}/videos`),
  ]);

  const fetched = new Map();

  for (const video of Array.isArray(videos) ? videos : []) {
    if (!video?.start_time) continue;
    const duration = Math.round(Number(video.duration) / 1000);
    if (!Number.isFinite(duration) || duration < MIN_DURATION_SECONDS) continue;
    const entry = makeEntry({
      id: video.id,
      start: kickDate(video.start_time),
      duration,
      title: video.session_title,
    });
    fetched.set(entry.id, entry);
  }

  // The live endpoint reports the session in progress before its VOD exists.
  const live = channel?.livestream;
  if (live?.start_time) {
    const entry = makeEntry({
      id: live.id,
      start: kickDate(live.start_time),
      duration: null,
      title: live.session_title,
    });
    const existing = fetched.get(entry.id);
    // Prefer a finished VOD (it has a duration) but never lose the start time.
    fetched.set(entry.id, existing ? { ...existing, start: entry.start } : entry);
  }

  let current = { schema: 2, source: `kick.com/${SLUG}`, gaps: [], streams: [] };
  try {
    current = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  } catch {
    // first run
  }

  const merged = new Map();
  for (const stream of current.streams ?? []) merged.set(stream.id, stream);
  for (const [id, stream] of fetched) {
    const previous = merged.get(id);
    // Keep the richer record if we already have it.
    merged.set(
      id,
      previous?.duration && !stream.duration
        ? { ...stream, duration: previous.duration }
        : { ...previous, ...stream },
    );
  }

  const mergedStreams = [...merged.values()]
    .filter((stream) => stream?.id && stream?.start && !Number.isNaN(Date.parse(stream.start)))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  // Kick is the most precise source. When it supplies a start for a day that
  // was backfilled from KickTracker/LWOD, drop the archived copy of the same
  // stream (within 90 minutes on the same Miami date). A genuinely separate
  // earlier stream, such as an event followed by the usual stream, is farther
  // away and survives.
  const kickStartsByDay = new Map();
  for (const stream of mergedStreams) {
    if (stream.source !== 'kick') continue;
    const day = localDateKey(stream.start);
    if (!kickStartsByDay.has(day)) kickStartsByDay.set(day, []);
    kickStartsByDay.get(day).push(Date.parse(stream.start));
  }

  const streams = mergedStreams.filter((stream) => {
    if (stream.source === 'kick') return true;
    const starts = kickStartsByDay.get(localDateKey(stream.start));
    if (!starts) return true;
    const start = Date.parse(stream.start);
    return !starts.some((kickStart) => Math.abs(kickStart - start) <= DEDUPE_WINDOW_MS);
  });

  // A gap is only a gap until a real start time shows up.
  const fetchedDays = new Set([...fetched.values()].map((stream) => localDateKey(stream.start)));
  const gaps = (current.gaps ?? []).filter((day) => !fetchedDays.has(day));

  const before = JSON.stringify({ streams: current.streams ?? [], gaps: current.gaps ?? [] });
  const after = JSON.stringify({ streams, gaps });
  if (before === after) {
    console.log(`No change (${streams.length} streams tracked).`);
    return;
  }

  const next = {
    schema: 2,
    source: `kick.com/${SLUG} + kicktracker.net + LWOD archive`,
    updatedAt: new Date().toISOString(),
    gaps,
    streams,
  };

  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Wrote ${streams.length} streams (${current.streams?.length ?? 0} before).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
