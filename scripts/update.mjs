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

  let current = { schema: 1, source: `kick.com/${SLUG}`, streams: [] };
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

  const streams = [...merged.values()]
    .filter((stream) => stream?.id && stream?.start)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  const before = JSON.stringify(current.streams ?? []);
  const after = JSON.stringify(streams);
  if (before === after) {
    console.log(`No change (${streams.length} streams tracked).`);
    return;
  }

  const next = {
    schema: 1,
    source: `kick.com/${SLUG}`,
    updatedAt: new Date().toISOString(),
    streams,
  };

  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Wrote ${streams.length} streams (${streams.length - (current.streams?.length ?? 0)} new).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
