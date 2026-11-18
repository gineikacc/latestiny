const TZ = 'America/New_York';
const SCHEDULE_HOUR = 13; // 1:00 PM Miami time
const ON_TIME_MINUTES = 9; // 1:09 PM still counts
const EARLY_CUTOFF_HOUR = 9; // a 2 AM start belongs to the previous day's 1 PM slot
const MS_DAY = 86_400_000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hourCycle: 'h23',
});
const timeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hour: 'numeric',
  minute: '2-digit',
});
const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
const updatedFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const state = {
  days: new Map(),
  year: null,
  trackingSince: null,
  latest: null,
};

const $ = (selector) => document.querySelector(selector);
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/* ---------- time zone helpers ---------- */

function partsOf(ms) {
  const out = {};
  for (const part of partsFmt.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out;
}

// Offset (ms) of Miami wall time from UTC at a given instant.
function offsetAt(ms) {
  const p = partsOf(ms);
  const second = Math.floor(ms / 1000) * 1000;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - second;
}

// Epoch ms for a wall-clock time in Miami (DST aware).
function zonedToUtc(y, m, d, hour) {
  const wall = Date.UTC(y, m - 1, d, hour, 0, 0);
  let ts = wall - offsetAt(wall);
  ts = wall - offsetAt(ts);
  return ts;
}

// The stream "day" a start is measured against. Late-night starts (before
// 9 AM) count toward the previous day's 1 PM slot instead of being "early".
function streamDayOf(ms) {
  const p = partsOf(ms);
  let { year, month, day } = p;
  if (p.hour < EARLY_CUTOFF_HOUR) {
    const prev = new Date(Date.UTC(year, month - 1, day) - MS_DAY);
    year = prev.getUTCFullYear();
    month = prev.getUTCMonth() + 1;
    day = prev.getUTCDate();
  }
  return { year, month, day, key: keyOf(year, month, day) };
}

function todayKey() {
  const p = partsOf(Date.now());
  return keyOf(p.year, p.month, p.day);
}

/* ---------- formatting ---------- */

function fmtDelta(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${Math.floor(abs / 60)}:${pad(abs % 60)}`;
}

function bucketOf(minutes) {
  if (minutes < 0) return 'early';
  if (minutes <= ON_TIME_MINUTES) return 'ontime';
  if (minutes <= 29) return 'late1';
  if (minutes <= 59) return 'late2';
  if (minutes <= 119) return 'late3';
  return 'late4';
}

function humanLateness(minutes) {
  if (minutes < 0) return `${Math.abs(minutes)} min early`;
  if (minutes <= ON_TIME_MINUTES) {
    return minutes === 0 ? 'right on time' : `${minutes} min late · on time`;
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min late`;
  return m === 0 ? `${h} hr late` : `${h} hr ${m} min late`;
}

function shortKeyDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}${y === state.year ? '' : `, ${y}`}`;
}

function longKeyDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

/* ---------- data ---------- */

function buildDays(streams) {
  const grouped = new Map();

  for (const stream of streams) {
    const start = Date.parse(stream.start);
    if (Number.isNaN(start)) continue;
    const day = streamDayOf(start);
    const entry = grouped.get(day.key) ?? { ...day, streams: [] };
    entry.streams.push({ ...stream, startMs: start });
    grouped.set(day.key, entry);
  }

  for (const day of grouped.values()) {
    day.streams.sort((a, b) => a.startMs - b.startMs);
    day.startMs = day.streams[0].startMs;
    day.scheduledMs = zonedToUtc(day.year, day.month, day.day, SCHEDULE_HOUR);
    day.late = Math.round((day.startMs - day.scheduledMs) / 60_000);
  }

  return grouped;
}

function yearOf(key) {
  return Number(key.slice(0, 4));
}

/* ---------- stats ---------- */

function renderStats() {
  const days = [...state.days.values()].filter((d) => d.year === state.year);
  const total = days.length;
  const onTime = days.filter((d) => d.late <= ON_TIME_MINUTES).length;
  const pct = total ? Math.round((onTime / total) * 100) : 0;
  const sum = days.reduce((acc, d) => acc + d.late, 0);
  const avg = total ? Math.round(sum / total) : null;
  const worst = days.reduce((a, b) => (b.late > a.late ? b : a), days[0] ?? null);

  const avgText = avg === null ? '—' : fmtDelta(avg);
  const worstText = worst ? fmtDelta(worst.late) : '—';

  $('#stats').innerHTML = `
    <div class="stat">
      <span class="stat-label">On time</span>
      <span class="stat-value">${total ? `${onTime} / ${total}` : '—'}</span>
      <span class="stat-sub">${total ? `${pct}% of stream days` : 'no streams tracked yet'}</span>
      <div class="meter" aria-hidden="true"><i style="width:${pct}%"></i></div>
    </div>
    <div class="stat">
      <span class="stat-label">Average lateness</span>
      <span class="stat-value">${avgText}</span>
      <span class="stat-sub">${avg !== null && avg < 0 ? 'on average early' : 'across all stream days'}</span>
    </div>
    <div class="stat">
      <span class="stat-label">Longest wait</span>
      <span class="stat-value">${worstText}</span>
      <span class="stat-sub">${worst ? shortKeyDate(worst.key) : 'nothing tracked yet'}</span>
    </div>
    <div class="stat">
      <span class="stat-label">Stream days</span>
      <span class="stat-value">${total || '—'}</span>
      <span class="stat-sub">in ${state.year}${state.trackingSince ? ` · since ${shortKeyDate(state.trackingSince)}` : ''}</span>
    </div>
  `;
}

/* ---------- calendar ---------- */

function renderCalendar() {
  const year = state.year;
  const host = $('#calendar');
  host.textContent = '';
  $('#year-label').textContent = String(year);

  if (state.days.size === 0) {
    host.innerHTML =
      '<p class="empty-state">No streams tracked yet. The scheduled workflow will fill this in.</p>';
    $('#range-note').textContent = '';
    $('#card-foot').textContent = '';
    return;
  }

  const jan1 = new Date(Date.UTC(year, 0, 1));
  const dec31 = new Date(Date.UTC(year, 11, 31));
  const gridStart = new Date(jan1);
  gridStart.setUTCDate(jan1.getUTCDate() - jan1.getUTCDay());
  const gridEnd = new Date(dec31);
  gridEnd.setUTCDate(dec31.getUTCDate() + (6 - dec31.getUTCDay()));
  const totalWeeks = Math.round((gridEnd - gridStart) / (7 * MS_DAY)) + 1;
  const narrow = window.matchMedia('(max-width: 860px)').matches;
  const firstHalf = narrow ? totalWeeks : Math.ceil(totalWeeks / 2);

  host.append(renderBlock(gridStart, 0, firstHalf, year));
  if (!narrow) {
    host.append(renderBlock(gridStart, firstHalf, totalWeeks - firstHalf, year));
  }

  const count = [...state.days.values()].filter((d) => d.year === year).length;
  const note = $('#range-note');
  if (state.trackingSince) {
    note.textContent = `Tracking since ${shortKeyDate(state.trackingSince)} · every tile is one day`;
  } else {
    note.textContent = 'Every tile is one day';
  }

  $('#card-foot').innerHTML = count
    ? `<strong>${count}</strong> stream day${count === 1 ? '' : 's'} measured in ${year}. Gray days had no stream and are left out of the stats.`
    : `No streams tracked in ${year} yet.`;
}

function renderBlock(gridStart, startWeek, weekCount, year) {
  const block = document.createElement('section');
  block.className = 'block';

  const months = document.createElement('div');
  months.className = 'months';
  months.style.gridTemplateColumns = `repeat(${weekCount}, var(--tile))`;

  let lastCol = -10;
  let sawFirstDay = false;
  for (let w = 0; w < weekCount; w++) {
    for (let d = 0; d < 7; d++) {
      const date = new Date(gridStart.getTime() + (startWeek + w) * 7 * MS_DAY + d * MS_DAY);
      if (date.getUTCFullYear() !== year) continue;
      const isFirstOfMonth = date.getUTCDate() === 1;
      if (!sawFirstDay || isFirstOfMonth) {
        if (w - lastCol >= 3 && w <= weekCount - 2) {
          const span = document.createElement('span');
          span.textContent = MONTHS[date.getUTCMonth()];
          span.style.gridColumn = String(w + 1);
          months.append(span);
          lastCol = w;
        }
        sawFirstDay = true;
      }
    }
  }
  const canvas = document.createElement('div');
  canvas.className = 'canvas';

  const labels = document.createElement('div');
  labels.className = 'day-labels';
  labels.append(
    ...WEEKDAYS.map((name, index) => {
      const span = document.createElement('span');
      span.textContent = name;
      if (index === 1 || index === 3 || index === 5) span.className = 'show';
      return span;
    }),
  );

  const weeks = document.createElement('div');
  weeks.className = 'weeks';
  weeks.style.gridTemplateColumns = `repeat(${weekCount}, var(--tile))`;
  weeks.setAttribute('role', 'list');

  for (let w = 0; w < weekCount; w++) {
    for (let d = 0; d < 7; d++) {
      const date = new Date(gridStart.getTime() + (startWeek + w) * 7 * MS_DAY + d * MS_DAY);
      if (date.getUTCFullYear() !== year) continue;

      const cell = buildDayCell(date);
      cell.style.gridColumn = String(w + 1);
      cell.style.gridRow = String(d + 1);
      weeks.append(cell);
    }
  }

  canvas.append(labels, weeks);
  block.append(months, canvas);
  return block;
}

function buildDayCell(date) {
  const key = keyOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  const day = state.days.get(key);
  const today = todayKey();
  const cell = document.createElement('div');
  cell.className = 'day';
  cell.setAttribute('role', 'listitem');

  if (day) {
    const cls = bucketOf(day.late);
    cell.classList.add(cls);
    cell.textContent = fmtDelta(day.late);
    cell.dataset.tip = tooltipForStream(day);
    cell.setAttribute('aria-label', ariaForStream(day));
  } else if (key > today) {
    cell.classList.add('future');
    cell.dataset.tip = `<strong>${longKeyDate(key)}</strong><span>Upcoming</span>`;
  } else if (state.trackingSince && key < state.trackingSince) {
    cell.classList.add('untracked');
    cell.dataset.tip = `<strong>${longKeyDate(key)}</strong><span>Before tracking started</span>`;
  } else {
    cell.classList.add('off');
    cell.dataset.tip = `<strong>${longKeyDate(key)}</strong><span>No stream</span>`;
  }

  if (key === today) cell.classList.add('today');
  return cell;
}

function fmtTime(ms) {
  return timeFmt.format(new Date(ms)).replace(/\s/g, ' ');
}

function startTimeLabel(day) {
  const sameDay =
    partsOf(day.startMs).year === day.year &&
    partsOf(day.startMs).month === day.month &&
    partsOf(day.startMs).day === day.day;
  return sameDay
    ? fmtTime(day.startMs)
    : `${weekdayFmt.format(new Date(day.startMs))} ${fmtTime(day.startMs)}`;
}

function tooltipForStream(day) {
  const time = startTimeLabel(day);
  const extra =
    day.streams.length > 1
      ? `<span>${day.streams.length} streams that day; first one measured</span>`
      : '';
  return `<strong>${longKeyDate(day.key)}</strong>
    <span>Started ${time} · <b class="num">${fmtDelta(day.late)}</b> (${humanLateness(day.late)})</span>
    ${extra}`;
}

function ariaForStream(day) {
  return `${longKeyDate(day.key)}: started ${startTimeLabel(day)}, ${humanLateness(day.late)}`;
}

/* ---------- tooltip ---------- */

function setupTooltip() {
  const tip = $('#tooltip');
  const calendar = $('#calendar');

  const show = (cell) => {
    tip.innerHTML = cell.dataset.tip;
    tip.hidden = false;
    const rect = cell.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - box.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8));
    let top = rect.top - box.height - 8;
    if (top < 8) top = rect.bottom + 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  const hide = () => {
    tip.hidden = true;
  };

  calendar.addEventListener('pointerover', (event) => {
    const cell = event.target.closest('.day[data-tip]');
    if (cell) show(cell);
  });
  calendar.addEventListener('pointerout', (event) => {
    if (event.target.closest('.day[data-tip]')) hide();
  });
  calendar.addEventListener('pointerdown', (event) => {
    const cell = event.target.closest('.day[data-tip]');
    if (cell) show(cell);
  });
  window.addEventListener('scroll', hide, { passive: true });
}

/* ---------- boot ---------- */

function scrollToToday() {
  const wrap = document.querySelector('.calendar-wrap');
  if (!wrap || !window.matchMedia('(max-width: 860px)').matches) return;
  if (wrap.scrollWidth <= wrap.clientWidth + 4) return;
  const today = wrap.querySelector('.day.today');
  if (!today) {
    wrap.scrollLeft = wrap.scrollWidth;
    return;
  }
  const wrapRect = wrap.getBoundingClientRect();
  const cellRect = today.getBoundingClientRect();
  const left = cellRect.left - wrapRect.left + wrap.scrollLeft;
  wrap.scrollLeft = Math.max(0, left - wrap.clientWidth * 0.55);
}

async function init() {
  let data;
  try {
    const res = await fetch('data/streams.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (error) {
    $('#stats').innerHTML = '';
    $('#calendar').innerHTML = `
      <p class="empty-state">
        Could not load <code>data/streams.json</code> (${String(error.message)}).<br />
        If you opened this file directly, serve the folder instead:
        <code>python3 -m http.server 8000</code>
      </p>`;
    return;
  }

  state.days = buildDays(Array.isArray(data.streams) ? data.streams : []);
  const keys = [...state.days.keys()].sort();
  state.trackingSince = keys[0] ?? null;
  state.latest = keys.at(-1) ?? null;

  const currentYear = Number(todayKey().slice(0, 4));
  const hasCurrent = keys.some((key) => yearOf(key) === currentYear);
  state.year = hasCurrent || !state.latest ? currentYear : yearOf(state.latest);

  renderStats();
  renderCalendar();
  setupTooltip();
  scrollToToday();

  window.matchMedia('(max-width: 860px)').addEventListener('change', () => {
    if (!state.days.size) return;
    renderCalendar();
    const wrap = document.querySelector('.calendar-wrap');
    if (wrap) wrap.scrollLeft = 0;
    scrollToToday();
  });

  const updated = data.updatedAt ? new Date(data.updatedAt) : null;
  $('#updated').textContent =
    updated && !Number.isNaN(updated.getTime())
      ? `Data last updated ${updatedFmt.format(updated)} Miami time.`
      : '';
}

init();
