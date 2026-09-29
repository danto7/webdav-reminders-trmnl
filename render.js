#!/usr/bin/env node
// Fetch reminders (VTODOs) and today's events (VEVENTs) from a CalDAV server and render them as an
// 800x480 1-bit kanban board for a TRMNL e-ink display.
//
// Config via environment:
//   CALDAV_URL       calendar-home or single-calendar collection URL (required)
//   CALDAV_USER      username
//   CALDAV_PASSWORD  password / app password
//   GROUP_BY         "status" (default: To Do / Today / Done columns) or "list"
//                    (one column per reminder list)
//   SHOW_COMPLETED   status mode: "0" hides the Done (completed today) column; list mode: "1" includes completed
//   FONT_PATH        TTF/OTF to use instead of the bundled fonts/DejaVuSans.ttf
//   FONT_BOLD_PATH   bold variant (default: bundled DejaVuSans-Bold.ttf, or FONT_PATH if set)
//   FONT_EMOJI_PATH  emoji fallback font (default: bundled monochrome fonts/NotoEmoji.ttf)
//   LOCALE           BCP 47 locale for dates/times and labels, e.g. de-DE, en-GB (default: de-DE;
//                    labels exist for de and en, other languages fall back to en)
//   SHOW_EVENTS      "0" disables today's calendar events in the Today column (default: shown)
//   EVENT_CALENDARS  comma-separated calendar names to take events from (default: all)
//   WEBHOOK_URL      if set, POST the rendered PNG to this URL (raw body, image/png)
//
// Usage: node render.js               (POST to WEBHOOK_URL if set, else write reminders.png)
//        node render.js output.png    (write output.png only; never triggers the webhook)
//        node render.js --demo out.png            (render sample data, no network)
//        node render.js --dump        (print raw iCalendar data of all reminders; no image)

import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { XMLParser } from 'fast-xml-parser';
import ICAL from 'ical.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 480;
const LOCALE = process.env.LOCALE || 'de-DE';

// Board labels per language; dates and times are formatted via LOCALE directly.
const STRINGS = {
  de: {
    header: 'Erinnerungen', todo: 'Zu erledigen', today: 'Heute', done: 'Erledigt',
    tomorrow: 'Morgen', yesterday: 'Gestern', more: (n) => `+ ${n} weitere`,
    empty: 'Nichts zu tun', noLists: 'Keine Erinnerungslisten gefunden', untitled: '(ohne Titel)',
    allDay: 'Ganztägig',
  },
  en: {
    header: 'Reminders', todo: 'To Do', today: 'Today', done: 'Done',
    tomorrow: 'Tomorrow', yesterday: 'Yesterday', more: (n) => `+ ${n} more`,
    empty: 'Nothing here', noLists: 'No reminder lists found', untitled: '(untitled)',
    allDay: 'All day',
  },
};
const T = STRINGS[LOCALE.split(/[-_]/)[0].toLowerCase()] ?? STRINGS.en;

// ---------------------------------------------------------------- CalDAV ----

// htmlEntities decodes numeric character references: Nextcloud sends the CRLF line
// endings inside calendar-data as '&#13;', which would otherwise corrupt every value.
const xml = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, htmlEntities: true, isArray: (n) => n === 'response' || n === 'propstat' || n === 'comp' });

function authHeader() {
  const { CALDAV_USER: u, CALDAV_PASSWORD: p } = process.env;
  return u ? { Authorization: 'Basic ' + Buffer.from(`${u}:${p ?? ''}`).toString('base64') } : {};
}

async function dav(method, url, depth, body) {
  const res = await fetch(url, {
    method,
    headers: { ...authHeader(), Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' },
    body,
  });
  if (!res.ok && res.status !== 207) throw new Error(`${method} ${url} -> ${res.status} ${res.statusText}`);
  return xml.parse(await res.text()).multistatus?.response ?? [];
}

const okProp = (r) => r.propstat?.find((ps) => String(ps.status).includes('200'))?.prop ?? {};
const text = (v) => (v == null ? '' : typeof v === 'object' ? v['#text'] ?? '' : String(v));

// Returns [{url, name}] for every collection at/under baseUrl that holds VTODOs.
async function discoverTaskLists(baseUrl) {
  const responses = await dav('PROPFIND', baseUrl, 1, `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/></d:prop>
</d:propfind>`);
  const lists = [];
  for (const r of responses) {
    const prop = okProp(r);
    if (!prop.resourcetype || !('calendar' in prop.resourcetype)) continue;
    const comps = prop['supported-calendar-component-set']?.comp;
    // No component set advertised means any component is allowed.
    if (comps && !comps.some((c) => c['@_name'] === 'VTODO')) continue;
    const url = new URL(r.href, baseUrl).toString();
    lists.push({ url, name: text(prop.displayname) || decodeURIComponent(url.replace(/\/$/, '').split('/').pop()) });
  }
  return lists;
}

// Raw iCalendar text of every resource in the list that contains a VTODO.
async function fetchCalendarData(list) {
  const responses = await dav('REPORT', list.url, 1, `<?xml version="1.0"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter>
</c:calendar-query>`);
  return responses.map((r) => text(okProp(r)['calendar-data'])).filter(Boolean);
}

const cleanTitle = (s) => (s || '').replace(/\s+/g, ' ').trim() || T.untitled;

// iOS Reminders stores "remind me at a location" on the alarm as
// X-APPLE-STRUCTURED-LOCATION / X-APPLE-PROXIMITY; other clients may use LOCATION.
function hasLocation(vtodo) {
  if (vtodo.hasProperty('location')) return true;
  return vtodo.getAllSubcomponents('valarm').some(
    (alarm) => alarm.hasProperty('x-apple-structured-location') || alarm.hasProperty('x-apple-proximity'),
  );
}

async function fetchTodos(list) {
  const todos = [];
  for (const data of await fetchCalendarData(list)) {
    const vcal = new ICAL.Component(ICAL.parse(data));
    for (const vtodo of vcal.getAllSubcomponents('vtodo')) {
      if (vtodo.hasProperty('recurrence-id')) continue; // skip overridden instances
      if (hasLocation(vtodo)) continue; // location-triggered reminders don't belong on the board
      const due = vtodo.getFirstPropertyValue('due');
      const status = (vtodo.getFirstPropertyValue('status') || '').toUpperCase();
      const completed = status === 'COMPLETED' || vtodo.hasProperty('completed');
      todos.push({
        title: cleanTitle(vtodo.getFirstPropertyValue('summary')),
        list: list.name,
        status: completed ? 'COMPLETED' : status === 'IN-PROCESS' ? 'IN-PROCESS' : 'NEEDS-ACTION',
        due: due ? due.toJSDate() : null,
        dueHasTime: due ? !due.isDate : false,
        priority: Number(vtodo.getFirstPropertyValue('priority')) || 0, // 1 = highest, 0 = none
        completedAt: vtodo.getFirstPropertyValue('completed')?.toJSDate() ?? null,
        recurring: vtodo.hasProperty('rrule'),
      });
    }
  }
  return todos;
}

// ---------------------------------------------------------------- Events ----

// CALDAV_URL may point at a single task list, so find the account's calendar
// home via the standard principal lookup (RFC 5397 / RFC 4791 §6.2.1).
async function discoverCalendarHome(baseUrl) {
  const [who] = await dav('PROPFIND', baseUrl, 0, `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`);
  const principal = text(okProp(who ?? {})['current-user-principal']?.href);
  if (!principal) throw new Error('server did not report current-user-principal');
  const [p] = await dav('PROPFIND', new URL(principal, baseUrl).toString(), 0, `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`);
  const home = text(okProp(p ?? {})['calendar-home-set']?.href);
  if (!home) throw new Error('server did not report calendar-home-set');
  return new URL(home, baseUrl).toString();
}

// Every calendar in the home that can hold events, including subscriptions
// (Nextcloud serves cached webcal subscriptions, e.g. holidays, as "subscribed").
async function discoverEventCalendars(homeUrl) {
  const responses = await dav('PROPFIND', homeUrl, 1, `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/></d:prop>
</d:propfind>`);
  const only = process.env.EVENT_CALENDARS?.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const cals = [];
  for (const r of responses) {
    const prop = okProp(r);
    const rt = prop.resourcetype;
    if (!rt || !('calendar' in rt || 'subscribed' in rt) || 'deleted-calendar' in rt) continue;
    const comps = prop['supported-calendar-component-set']?.comp;
    if (comps && !comps.some((c) => c['@_name'] === 'VEVENT')) continue;
    const url = new URL(r.href, homeUrl).toString();
    const name = text(prop.displayname) || decodeURIComponent(url.replace(/\/$/, '').split('/').pop());
    if (only && !only.includes(name.toLowerCase())) continue;
    cals.push({ url, name });
  }
  return cals;
}

// iCalendar UTC timestamp, e.g. 20260929T220000Z.
const icalUtc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// Events overlapping [start, end). The server expands recurring events into
// the individual instances (in UTC) for that range.
async function fetchEvents(cal, start, end) {
  const range = `start="${icalUtc(start)}" end="${icalUtc(end)}"`;
  const responses = await dav('REPORT', cal.url, 1, `<?xml version="1.0"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-data><c:expand ${range}/></c:calendar-data></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range ${range}/></c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`);
  const events = [];
  for (const r of responses) {
    const data = text(okProp(r)['calendar-data']);
    if (!data) continue;
    const vcal = new ICAL.Component(ICAL.parse(data));
    for (const vevent of vcal.getAllSubcomponents('vevent')) {
      if ((vevent.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED') continue;
      const ev = new ICAL.Event(vevent);
      const s = ev.startDate.toJSDate();
      const e = ev.endDate ? ev.endDate.toJSDate() : s;
      if (!(s < end && (e > start || +e === +s))) continue; // server filters too, but be strict
      events.push({
        kind: 'event',
        title: cleanTitle(vevent.getFirstPropertyValue('summary')),
        list: cal.name,
        start: s,
        end: e,
        allDay: ev.startDate.isDate,
        recurring: vevent.hasProperty('recurrence-id') || vevent.hasProperty('rrule'),
      });
    }
  }
  return events;
}

async function loadTodaysEvents() {
  if (process.env.SHOW_EVENTS === '0') return [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  try {
    const cals = await discoverEventCalendars(await discoverCalendarHome(process.env.CALDAV_URL));
    const results = await Promise.all(
      cals.map((cal) => fetchEvents(cal, start, end).catch((err) => {
        console.error(`Skipping calendar "${cal.name}": ${err.message}`);
        return [];
      })),
    );
    return results.flat();
  } catch (err) {
    // Events are an extra; never let them break the reminders board.
    console.error(`Could not load calendar events: ${err.message}`);
    return [];
  }
}

async function discoverOrFallback() {
  const base = process.env.CALDAV_URL;
  if (!base) throw new Error('CALDAV_URL is not set');
  const lists = await discoverTaskLists(base);
  return lists.length ? lists : [{ url: base, name: T.header }];
}

// Print the raw iCalendar data of every reminder, grouped by list.
async function dumpReminders() {
  for (const list of await discoverOrFallback()) {
    const items = await fetchCalendarData(list);
    console.log(`===== ${list.name} (${items.length}) — ${list.url}`);
    for (const data of items) console.log(data.trim() + '\n');
  }
}

async function loadReminders() {
  const lists = await discoverOrFallback();
  const [all, events] = await Promise.all([Promise.all(lists.map(fetchTodos)), loadTodaysEvents()]);
  return { lists: lists.map((l) => l.name), todos: all.flat(), events };
}

function demoReminders() {
  const d = (days, h) => { const x = new Date(); x.setDate(x.getDate() + days); if (h != null) x.setHours(h, 0, 0, 0); return x; };
  const t = (title, list, status, due, extra = {}) => ({ title, list, status, due, dueHasTime: due?.getMinutes?.() === 0 && due.getHours() !== 0, priority: 0, completedAt: null, ...extra });
  const todos = [
    t('Stromrechnung bezahlen', 'Zuhause', 'NEEDS-ACTION', d(-1), { priority: 1, recurring: true }),
    t('Zahnarzttermin buchen', 'Zuhause', 'NEEDS-ACTION', d(0, 15)),
    t('Geburtstagsgeschenk für Anna kaufen – etwas mit Büchern oder ein schönes Stifteset', 'Zuhause', 'NEEDS-ACTION', d(3)),
    t('🌱 Pflanzen gießen', 'Zuhause', 'NEEDS-ACTION', null, { recurring: true }),
    t('Reisepass verlängern', 'Besorgungen', 'NEEDS-ACTION', d(14)),
    t('Reinigung abholen', 'Besorgungen', 'NEEDS-ACTION', d(1)),
    t('Quartalsbericht schreiben', 'Arbeit', 'IN-PROCESS', d(2), { priority: 1 }),
    t('Deployment-Pipeline umbauen', 'Arbeit', 'IN-PROCESS', null),
    t('PR #142 reviewen', 'Arbeit', 'NEEDS-ACTION', d(0), { recurring: true }),
    t('Neuen Toner bestellen', 'Arbeit', 'COMPLETED', null, { completedAt: d(0) }),
    t('Vermieter anrufen', 'Zuhause', 'COMPLETED', null, { completedAt: d(-1) }),
  ];
  const e = (title, list, start, end, extra = {}) => ({ kind: 'event', title, list, start, end, allDay: false, recurring: false, ...extra });
  const events = [
    e('Tag der Deutschen Einheit', 'Feiertage', d(0, 0), d(1, 0), { allDay: true }),
    e('Team-Standup', 'Persönlich', d(0, 9), d(0, 10), { recurring: true }),
    e('🎂 Lena (1990)', 'Geburtstage', d(0, 0), d(1, 0), { allDay: true, recurring: true }),
  ];
  return { lists: ['Zuhause', 'Besorgungen', 'Arbeit'], todos, events };
}

// ------------------------------------------------------------- Grouping ----

function byUrgency(a, b) {
  const pa = a.priority || 10, pb = b.priority || 10;
  if (a.due && b.due && +a.due !== +b.due) return a.due - b.due;
  if (a.due && !b.due) return -1;
  if (!a.due && b.due) return 1;
  if (pa !== pb) return pa - pb;
  return a.title.localeCompare(b.title);
}

function buildColumns({ lists, todos, events = [] }) {
  const mode = (process.env.GROUP_BY || 'status').toLowerCase();
  if (mode === 'list') {
    const showDone = process.env.SHOW_COMPLETED === '1';
    return lists.map((name) => ({
      title: name,
      items: todos.filter((t) => t.list === name && (showDone || t.status !== 'COMPLETED')).sort(byUrgency),
    }));
  }
  // Status board: To Do = later / undated, Today = due today or overdue, Done = completed today.
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  const startOfToday = new Date(endOfToday);
  startOfToday.setHours(0, 0, 0, 0);
  const open = todos.filter((t) => t.status !== 'COMPLETED');
  const dueToday = (t) => t.due && t.due <= endOfToday;
  const cols = [
    // Undated reminders first, then by due date.
    { title: T.todo, items: open.filter((t) => !dueToday(t)).sort((a, b) => !!a.due - !!b.due || byUrgency(a, b)) },
    {
      title: T.today,
      // Today's calendar events (all-day first, then by start time), then reminders.
      items: [
        ...[...events].sort((a, b) => b.allDay - a.allDay || a.start - b.start || a.title.localeCompare(b.title)),
        ...open.filter(dueToday).sort(byUrgency),
      ],
    },
  ];
  if (process.env.SHOW_COMPLETED !== '0') {
    cols.push({
      title: T.done,
      done: true,
      items: todos
        .filter((t) => t.status === 'COMPLETED' && t.completedAt && t.completedAt >= startOfToday)
        .sort((a, b) => b.completedAt - a.completedAt),
    });
  }
  return cols;
}

// ------------------------------------------------------------ Rendering ----

// Fonts ship with the script (fonts/), so rendering never depends on what the
// host has installed. Without a usable font, canvas silently draws no text.
const FONT_DIR = fileURLToPath(new URL('./fonts/', import.meta.url));

function registerFonts() {
  const regular = process.env.FONT_PATH || join(FONT_DIR, 'DejaVuSans.ttf');
  const bold = process.env.FONT_BOLD_PATH || (process.env.FONT_PATH ? regular : join(FONT_DIR, 'DejaVuSans-Bold.ttf'));
  const emoji = process.env.FONT_EMOJI_PATH || join(FONT_DIR, 'NotoEmoji.ttf');
  const load = (path, family) => {
    if (!GlobalFonts.registerFromPath(path, family)) throw new Error(`Could not load font ${path}`);
  };
  for (const path of new Set([regular, bold])) load(path, 'Board');
  // Monochrome Noto Emoji as fallback, so emoji (e.g. Nextcloud's 🎂 birthdays)
  // render as black-and-white glyphs instead of blanks.
  load(emoji, 'BoardEmoji');
  return 'Board, BoardEmoji';
}

function wrap(ctx, str, maxWidth, maxLines) {
  const words = str.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth) { line = next; continue; }
    if (line) lines.push(line);
    line = word;
    while (ctx.measureText(line).width > maxWidth && line.length > 1) {
      // Hard-break words that are wider than the column.
      let i = line.length - 1;
      while (i > 1 && ctx.measureText(line.slice(0, i)).width > maxWidth) i--;
      lines.push(line.slice(0, i));
      line = line.slice(i);
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = last.trimEnd() + '…';
  }
  return lines;
}

function formatDue(t, now) {
  if (!t.due) return null;
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((day(t.due) - day(now)) / 86400000);
  const time = t.dueHasTime ? ' ' + t.due.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '';
  let label;
  if (diff === 0) label = T.today;
  else if (diff === 1) label = T.tomorrow;
  else if (diff === -1) label = T.yesterday;
  else if (diff > 1 && diff < 7) label = t.due.toLocaleDateString(LOCALE, { weekday: 'short' });
  else label = t.due.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
  return { label: label + time, overdue: t.status !== 'COMPLETED' && (t.dueHasTime ? t.due < now : diff < 0) };
}

// "09:00–10:30" for timed events, "Ganztägig"/"All day" for all-day ones.
function formatEventTime(ev) {
  if (ev.allDay) return T.allDay;
  const hm = (d) => d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return +ev.end > +ev.start ? `${hm(ev.start)}–${hm(ev.end)}` : hm(ev.start);
}

// Small "repeats" icon (two arrows chasing each other), 13x12px with its top-left at (ox, oy).
function drawRepeatIcon(ctx, ox, oy, color) {
  const seg = (pts) => {
    ctx.beginPath();
    ctx.moveTo(...pts[0]);
    for (const p of pts.slice(1)) ctx.lineTo(...p);
    ctx.stroke();
  };
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  seg([[ox, oy + 5], [ox, oy + 1], [ox + 10, oy + 1]]); // top arm
  seg([[ox + 8, oy - 1.5], [ox + 11, oy + 1], [ox + 8, oy + 3.5]]); // arrowhead right
  seg([[ox + 12, oy + 4], [ox + 12, oy + 8], [ox + 2, oy + 8]]); // bottom arm
  seg([[ox + 4, oy + 5.5], [ox + 1, oy + 8], [ox + 4, oy + 10.5]]); // arrowhead left
  ctx.restore();
}

function render(columns, font) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  const now = new Date();
  const BLACK = '#000', WHITE = '#fff';
  const M = 10; // outer margin

  ctx.fillStyle = WHITE;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  // Draw text with its top edge at y. Positioning from the text font's ascent
  // (instead of textBaseline 'top') keeps lines aligned when they start with an
  // emoji, whose fallback font has different metrics.
  ctx.textBaseline = 'alphabetic';
  const drawText = (str, tx, ty) => ctx.fillText(str, tx, ty + ctx.measureText('Hg').fontBoundingBoxAscent);

  // Header bar
  const headerH = 34;
  ctx.fillStyle = BLACK;
  ctx.fillRect(0, 0, WIDTH, headerH);
  ctx.fillStyle = WHITE;
  ctx.font = `bold 20px ${font}`;
  drawText(T.header, M, 7);
  ctx.font = `15px ${font}`;
  const stamp = now.toLocaleString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  drawText(stamp, WIDTH - M - ctx.measureText(stamp).width, 10);

  if (!columns.length) {
    ctx.fillStyle = BLACK;
    ctx.font = `18px ${font}`;
    drawText(T.noLists, M, headerH + 20);
    return canvas;
  }

  const gap = 8;
  const top = headerH + M;
  const colW = Math.floor((WIDTH - 2 * M - gap * (columns.length - 1)) / columns.length);
  const colH = HEIGHT - top - M;

  columns.forEach((col, ci) => {
    const x = M + ci * (colW + gap);
    const done = col.done;

    // Column frame + title
    ctx.strokeStyle = BLACK;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, top + 1, colW - 2, colH - 2);
    ctx.fillStyle = BLACK;
    ctx.font = `bold 16px ${font}`;
    drawText(col.title, x + 8, top + 8);
    const count = String(col.items.length);
    ctx.font = `bold 13px ${font}`;
    const cw = Math.max(22, ctx.measureText(count).width + 12);
    ctx.beginPath();
    ctx.roundRect(x + colW - cw - 8, top + 7, cw, 20, 10);
    ctx.fill();
    ctx.fillStyle = WHITE;
    drawText(count, x + colW - 8 - cw / 2 - ctx.measureText(count).width / 2, top + 10);
    ctx.fillStyle = BLACK;
    ctx.fillRect(x + 6, top + 32, colW - 12, 2);

    // Cards
    const cardX = x + 8, cardW = colW - 16, pad = 7, lineH = 17;
    const bottom = top + colH - 8;
    let y = top + 42;
    const moreH = 20;

    for (let i = 0; i < col.items.length; i++) {
      const t = col.items[i];
      const remaining = col.items.length - i;
      const isEvent = t.kind === 'event';
      ctx.font = `15px ${font}`;
      const lines = wrap(ctx, t.title, cardW - 2 * pad - (t.priority && t.priority <= 4 ? 12 : 0) - (isEvent ? 4 : 0), 3);
      const due = isEvent ? null : formatDue(t, now);
      const when = isEvent ? formatEventTime(t) : due?.label;
      const meta = [when, process.env.GROUP_BY === 'list' ? null : t.list].filter(Boolean);
      const hasMeta = meta.length > 0 || t.recurring;
      const h = pad * 2 + lines.length * lineH + (hasMeta ? 16 : 0);
      const limit = remaining > 1 ? bottom - moreH : bottom;
      if (y + h > limit) {
        ctx.font = `bold 13px ${font}`;
        drawText(T.more(remaining), cardX + 2, y + 2);
        break;
      }

      // Card frame: overdue cards are inverted to stand out.
      const inverted = due?.overdue;
      ctx.beginPath();
      ctx.roundRect(cardX, y, cardW, h, 5);
      if (inverted) { ctx.fillStyle = BLACK; ctx.fill(); }
      else { ctx.lineWidth = 1.5; ctx.strokeStyle = BLACK; ctx.stroke(); }
      const fg = inverted ? WHITE : BLACK;
      ctx.fillStyle = fg;

      // Calendar events get a solid bar on the left edge.
      let tx = cardX + pad;
      if (isEvent) {
        ctx.beginPath();
        ctx.roundRect(cardX, y, 6, h, [5, 0, 0, 5]);
        ctx.fill();
        tx += 4;
      }

      // High priority marker
      if (t.priority && t.priority <= 4) {
        ctx.font = `bold 15px ${font}`;
        drawText('!', tx, y + pad);
        tx += 12;
      }

      ctx.font = `15px ${font}`;
      lines.forEach((ln, li) => {
        const ly = y + pad + li * lineH;
        drawText(ln, tx, ly);
        if (done) {
          const w = ctx.measureText(ln).width;
          ctx.fillRect(tx, ly + 8, w, 1.5);
        }
      });

      if (hasMeta) {
        const my = y + pad + lines.length * lineH + 1;
        let mx = cardX + pad + (isEvent ? 4 : 0);
        if (t.recurring) {
          drawRepeatIcon(ctx, mx, my + 1, fg);
          mx += 17;
        }
        ctx.font = `bold 12px ${font}`;
        drawText(meta.join(' · '), mx, my);
      }
      y += h + 6;
    }

    if (!col.items.length) {
      ctx.font = `bold 13px ${font}`;
      drawText(T.empty, cardX + 2, y + 2);
    }
  });

  return canvas;
}

// ------------------------------------------------------------- Output ------

// Threshold the canvas to black/white and encode it as a 1-bit grayscale PNG
// (color type 0, bit depth 1), which is what the e-ink device accepts.
function encodeMonoPng(canvas) {
  const { data } = canvas.getContext('2d').getImageData(0, 0, WIDTH, HEIGHT);
  const rowBytes = Math.ceil(WIDTH / 8);
  const raw = Buffer.alloc((rowBytes + 1) * HEIGHT); // each row: filter byte 0 + packed pixels
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      // Bias towards black so anti-aliased text stays solid. Bit 1 = white.
      if (lum >= 170) raw[y * (rowBytes + 1) + 1 + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }

  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // color type: grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--dump')) return dumpReminders();
  const demo = args.includes('--demo');
  const webhook = process.env.WEBHOOK_URL;
  // An explicit output path means "write a file" and skips the webhook.
  const outArg = args.find((a) => !a.startsWith('--'));
  const useWebhook = webhook && !outArg;
  const out = outArg || (useWebhook ? null : 'reminders.png');

  const data = demo ? demoReminders() : await loadReminders();
  const canvas = render(buildColumns(data), registerFonts());
  const png = encodeMonoPng(canvas);

  if (out) {
    writeFileSync(out, png);
    console.log(`Wrote ${out} (${WIDTH}x${HEIGHT}, ${data.todos.length} reminders, ${data.events?.length ?? 0} events today)`);
  }
  if (useWebhook) await postWebhook(webhook, png);
}

// POST the PNG to WEBHOOK_URL as the raw request body.
async function postWebhook(url, image) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: image });
  if (!res.ok) throw new Error(`Webhook POST ${url} -> ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
  console.log(`Posted image to ${new URL(url).host} (${res.status})`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
