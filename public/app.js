// app.js — front end controller. Talks to the API for parsing, keeps the
// review list in memory, and hands finished events to the calendar connectors.

import { CATEGORIES, resolveWindow } from './shared.js';
import * as cal from './calendars.js';

const $ = (id) => document.getElementById(id);
const STORAGE = 'sylly2cal/settings';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const REMINDERS = [
  { minutes: 10080, label: 'A week before' },
  { minutes: 1440, label: 'A day before' },
  { minutes: 120, label: 'Two hours before' },
  { minutes: 30, label: 'Thirty minutes before' },
];

const SAMPLE = `BA 301 Introduction to Finance — Fall 2026
Week 5 – Sep 21 - 25   Financial Planning
Mid-term #1 – Sep 25
Week 10 – Oct 26 - 30
Mid-term #2 – Oct 30
Checkpoint HW 1 Due Friday, 9/11 at 11pm
Reflection Paper due 10/27
Final Exam Dec 15, 8:00-9:50 AM, Willard 173`;

const state = {
  items: [],
  filters: new Set(Object.keys(CATEGORIES)),
  editing: null,
  busy: false,
  fileName: '',
  termLabel: '',
  term: { start: null, end: null },
  settings: {
    courseName: '',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    reminders: [1440, 120],
  },
};

/* --------------------------------------------------------------- settings */

function loadSettings() {
  try { Object.assign(state.settings, JSON.parse(localStorage.getItem(STORAGE) || '{}')); }
  catch { /* private mode */ }
}
function saveSettings() {
  try { localStorage.setItem(STORAGE, JSON.stringify(state.settings)); }
  catch { /* private mode — settings just won't persist */ }
}

/* ----------------------------------------------------------------- status */

let statusTimer = null;
function setStatus(message, tone = 'info', progress = null) {
  const el = $('status');
  clearTimeout(statusTimer);
  if (!message) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.dataset.tone = tone;
  el.innerHTML = '';
  const p = document.createElement('p');
  p.style.margin = '0';
  p.textContent = message;
  el.appendChild(p);
  if (progress !== null) {
    const bar = document.createElement('div');
    bar.className = 'status-bar';
    const fill = document.createElement('span');
    fill.style.width = `${Math.round(progress * 100)}%`;
    bar.appendChild(fill);
    el.appendChild(bar);
  }
  if (tone === 'done') statusTimer = setTimeout(() => setStatus(''), 7000);
}

function setBusy(busy) {
  state.busy = busy;
  renderExport();
}

/* -------------------------------------------------------------- API calls */

function termFields() {
  const body = {};
  if ($('term-start').value && $('term-end').value) {
    body.termStart = $('term-start').value;
    body.termEnd = $('term-end').value;
  }
  return body;
}

async function sendFile(file) {
  const form = new FormData();
  form.append('file', file);
  for (const [k, v] of Object.entries(termFields())) form.append(k, v);
  const res = await fetch('/api/parse', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({ error: 'The server sent back something unreadable.' }));
  if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
  return data;
}

async function sendText(text) {
  const res = await fetch('/api/parse-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ...termFields() }),
  });
  const data = await res.json().catch(() => ({ error: 'The server sent back something unreadable.' }));
  if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
  return data;
}

function receive(data) {
  state.items = data.items.map((item, i) => ({ ...item, include: true, id: item.id || `i${i}` }));
  state.fileName = data.filename;
  state.termLabel = data.term.label;
  state.term = { start: new Date(data.term.start), end: new Date(data.term.end) };
  state.filters = new Set(Object.keys(CATEGORIES));
  $('term-start').value = data.term.start.slice(0, 10);
  $('term-end').value = data.term.end.slice(0, 10);
  $('preview-text').textContent = data.preview;
  $('preview-summary').textContent = `See the text we read from your file (${data.characters.toLocaleString()} characters)`;

  if (!state.items.length) {
    $('review').hidden = true;
    $('export').hidden = true;
    setStatus('No dated assignments turned up. Open the preview to see what we read — if the schedule is missing, the file may be a scan.', 'error');
    return;
  }

  render({ reveal: true });
  const flagged = state.items.filter((i) => i.confidence < 0.7).length;
  setStatus(flagged
    ? `Found ${state.items.length} items. ${flagged === 1 ? 'One needs' : `${flagged} need`} a second look — marked below.`
    : `Found ${state.items.length} items.`, 'done');
  $('review').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function handleFile(file) {
  if (!file) return;
  setBusy(true);
  setStatus(`Reading ${file.name}…`);
  try { receive(await sendFile(file)); }
  catch (err) { setStatus(err.message, 'error'); }
  finally { setBusy(false); }
}

async function handleText(text) {
  setBusy(true);
  setStatus('Reading the text…');
  try { receive(await sendText(text)); }
  catch (err) { setStatus(err.message, 'error'); }
  finally { setBusy(false); }
}

/* -------------------------------------------------------------- rendering */

const visible = () => state.items.filter((i) => state.filters.has(i.category));
const selected = () => state.items.filter((i) => i.include && state.filters.has(i.category));

function render({ reveal = false } = {}) {
  $('review').hidden = !state.items.length;
  $('export').hidden = !state.items.length;
  if (!state.items.length) return;

  $('review-sub').textContent = [state.fileName, state.termLabel, `${state.items.length} items`]
    .filter(Boolean).join(' — ');

  renderFilters();
  renderLoadstrip();
  renderSchedule();
  renderExport();

  if (reveal) {
    $('review').dataset.revealing = 'true';
    setTimeout(() => { $('review').dataset.revealing = 'false'; }, 1200);
  }
}

function renderFilters() {
  const counts = {};
  for (const i of state.items) counts[i.category] = (counts[i.category] || 0) + 1;
  const box = $('filters');
  box.innerHTML = '';
  for (const [key, cfg] of Object.entries(CATEGORIES)) {
    if (!counts[key]) continue;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.category = key;
    chip.setAttribute('aria-pressed', String(state.filters.has(key)));
    chip.innerHTML = `<span class="chip-dot" style="background:var(--${key})"></span>`;
    chip.append(cfg.label);
    const n = document.createElement('span');
    n.className = 'chip-count';
    n.textContent = counts[key];
    chip.appendChild(n);
    box.appendChild(chip);
  }
}

function renderLoadstrip() {
  const strip = $('loadstrip');
  if (!state.term.start || !state.term.end) { strip.hidden = true; return; }
  const weeks = Math.ceil((state.term.end - state.term.start) / (7 * 864e5));
  if (weeks < 2 || weeks > 30) { strip.hidden = true; return; }
  strip.hidden = false;

  const buckets = Array.from({ length: weeks }, () => []);
  for (const item of visible()) {
    const idx = Math.floor((Date.UTC(item.year, item.month - 1, item.day) - state.term.start.getTime()) / (7 * 864e5));
    if (idx >= 0 && idx < weeks) buckets[idx].push(item);
  }

  const bars = $('loadstrip-bars');
  const axis = $('loadstrip-axis');
  bars.innerHTML = '';
  axis.innerHTML = '';
  buckets.forEach((bucket, i) => {
    const col = document.createElement('button');
    col.type = 'button';
    col.className = 'week';
    const ws = new Date(state.term.start.getTime() + i * 7 * 864e5);
    const label = `Week of ${MONTHS[ws.getUTCMonth()].slice(0, 3)} ${ws.getUTCDate()}`;
    col.title = bucket.length ? `${label}: ${bucket.length} item${bucket.length === 1 ? '' : 's'}` : `${label}: nothing due`;
    col.setAttribute('aria-label', col.title);
    if (!bucket.length) {
      const e = document.createElement('span');
      e.className = 'week-empty';
      col.appendChild(e);
    } else {
      for (const item of bucket.slice(0, 7)) {
        const m = document.createElement('span');
        m.className = 'week-mark';
        m.style.background = `var(--${item.category})`;
        col.appendChild(m);
      }
      col.dataset.jump = bucket[0].id;
    }
    bars.appendChild(col);
    const ax = document.createElement('span');
    ax.textContent = (i === 0 || ws.getUTCDate() <= 7) ? MONTHS[ws.getUTCMonth()].slice(0, 3) : '';
    axis.appendChild(ax);
  });
}

function renderSchedule() {
  const list = $('schedule');
  list.innerHTML = '';
  const items = visible();
  $('empty').hidden = items.length > 0;
  let month = '';
  items.forEach((item, i) => {
    const key = `${item.year}-${item.month}`;
    if (key !== month) {
      month = key;
      const h = document.createElement('h3');
      h.className = 'month-label';
      h.textContent = `${MONTHS[item.month - 1]} ${item.year}`;
      list.appendChild(h);
    }
    list.appendChild(renderRow(item, i));
  });
}

function fmtTime({ h, min }) {
  const suffix = h >= 12 ? 'pm' : 'am';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(min).padStart(2, '0')} ${suffix}`;
}

function renderRow(item, index) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.id = item.id;
  row.style.setProperty('--i', index);
  if (!item.include) row.classList.add('is-excluded');
  if (item.confidence < 0.7) row.classList.add('is-flagged');

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'row-check';
  check.checked = item.include;
  check.setAttribute('aria-label', `Include ${item.title}`);
  row.appendChild(check);

  const date = document.createElement('div');
  const dt = new Date(Date.UTC(item.year, item.month - 1, item.day));
  date.innerHTML = `<span class="date-day">${MONTHS[item.month - 1].slice(0, 3)} ${item.day}</span>`;
  const wd = document.createElement('span');
  wd.className = 'date-weekday';
  wd.textContent = DAYS[dt.getUTCDay()];
  date.appendChild(wd);
  row.appendChild(date);

  const main = document.createElement('div');
  main.className = 'row-main';
  const title = document.createElement('div');
  title.className = 'row-title';
  title.textContent = item.title;
  main.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'row-meta';
  const w = resolveWindow(item);
  meta.append(w.allDay ? 'No time given' : `${fmtTime(w.start)} to ${fmtTime(w.end)}`);
  if (item.location) {
    const l = document.createElement('span');
    l.textContent = item.location;
    meta.appendChild(l);
  }
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'link-button';
  edit.dataset.action = 'edit';
  edit.textContent = state.editing === item.id ? 'Close' : 'Edit';
  meta.appendChild(edit);
  main.appendChild(meta);
  row.appendChild(main);

  const tag = document.createElement('span');
  tag.className = `tag tag-${item.category}`;
  tag.textContent = CATEGORIES[item.category].label;
  row.appendChild(tag);

  if (state.editing === item.id) row.appendChild(renderEditor(item, w));
  return row;
}

function renderEditor(item, w) {
  const box = document.createElement('div');
  box.className = 'row-edit';
  const p = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s || '').replace(/"/g, '&quot;');
  box.innerHTML = `
    <label>Title<input type="text" data-field="title" value="${esc(item.title)}"></label>
    <label>Date<input type="date" data-field="date" value="${item.year}-${p(item.month)}-${p(item.day)}"></label>
    <label>Starts<input type="time" data-field="start" value="${item.allDay ? '' : `${p(w.start.h)}:${p(w.start.min)}`}"></label>
    <label>Ends<input type="time" data-field="end" value="${item.allDay ? '' : `${p(w.end.h)}:${p(w.end.min)}`}"></label>
    <label>Place<input type="text" data-field="location" value="${esc(item.location)}"></label>
    <label>Type<select data-field="category">${Object.entries(CATEGORIES)
      .map(([k, c]) => `<option value="${k}"${k === item.category ? ' selected' : ''}>${c.label}</option>`).join('')}</select></label>`;
  const rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'link-button remove';
  rm.dataset.action = 'remove';
  rm.textContent = 'Remove this item';
  box.appendChild(rm);
  return box;
}

function renderExport() {
  const n = selected().length;
  $('export-count').textContent = n === 1 ? '1 item selected' : `${n} items selected`;
  for (const id of ['add-google', 'add-outlook', 'download-ics']) {
    $(id).disabled = n === 0 || state.busy;
  }
  $('add-google').dataset.connected = String(cal.googleConnected());
  $('add-outlook').dataset.connected = String(cal.outlookConnected());
}

/* ----------------------------------------------------------------- events */

const findItem = (id) => state.items.find((i) => i.id === id);

$('schedule').addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const item = findItem(row.dataset.id);
  if (!item) return;
  if (e.target.dataset.action === 'edit') {
    state.editing = state.editing === item.id ? null : item.id;
    renderSchedule();
  } else if (e.target.dataset.action === 'remove') {
    state.items = state.items.filter((i) => i.id !== item.id);
    state.editing = null;
    render();
  }
});

$('schedule').addEventListener('change', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const item = findItem(row.dataset.id);
  if (!item) return;

  if (e.target.classList.contains('row-check')) {
    item.include = e.target.checked;
    row.classList.toggle('is-excluded', !item.include);
    renderExport();
    return;
  }
  const field = e.target.dataset.field;
  const value = e.target.value;
  if (field === 'title') item.title = value.trim() || item.title;
  if (field === 'location') item.location = value.trim();
  if (field === 'category') item.category = value;
  if (field === 'date') {
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) { item.year = +m[1]; item.month = +m[2]; item.day = +m[3]; }
  }
  if (field === 'start' || field === 'end') {
    const m = value.match(/^(\d{2}):(\d{2})$/);
    const clock = m ? { h: +m[1], min: +m[2] } : null;
    if (field === 'start') {
      item.startTime = clock;
      item.allDay = !clock;
      if (!clock) item.endTime = null;
    } else {
      item.endTime = item.startTime ? clock : null;
    }
  }
  item.confidence = 1; // a human has looked at it
  render();
});

$('filters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const key = chip.dataset.category;
  if (state.filters.has(key)) state.filters.delete(key); else state.filters.add(key);
  render();
});

$('loadstrip-bars').addEventListener('click', (e) => {
  const col = e.target.closest('.week');
  if (!col?.dataset.jump) return;
  document.querySelector(`.row[data-id="${CSS.escape(col.dataset.jump)}"]`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

$('select-all').addEventListener('click', () => { for (const i of visible()) i.include = true; render(); });
$('select-none').addEventListener('click', () => { for (const i of visible()) i.include = false; render(); });

$('add-manual').addEventListener('click', () => {
  const now = new Date();
  const item = {
    id: `manual-${Date.now()}`,
    title: 'New item',
    category: 'assignment',
    year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(),
    startTime: null, endTime: null, allDay: true,
    location: '', source: 'Added by hand', confidence: 1, include: true,
  };
  state.items.push(item);
  state.filters.add('assignment');
  state.editing = item.id;
  render();
});

$('start-over').addEventListener('click', () => {
  state.items = [];
  state.editing = null;
  $('review').hidden = true;
  $('export').hidden = true;
  setStatus('');
  $('intake').scrollIntoView({ behavior: 'smooth' });
});

/* intake */
const dz = $('dropzone');
$('browse').addEventListener('click', (e) => { e.stopPropagation(); $('file-input').click(); });
dz.addEventListener('click', () => $('file-input').click());
dz.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file-input').click(); }
});
$('file-input').addEventListener('change', (e) => handleFile(e.target.files[0]));
['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('is-over'); }));
['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('is-over'); }));
dz.addEventListener('drop', (e) => handleFile(e.dataTransfer?.files?.[0]));

$('parse-paste').addEventListener('click', () => {
  const text = $('paste-text').value;
  if (text.trim().length < 20) return setStatus('Paste a bit more text first.', 'error');
  handleText(text);
});
$('load-sample').addEventListener('click', () => handleText(SAMPLE));

/* export */
function exportOptions() {
  return {
    timeZone: state.settings.timeZone,
    courseName: state.settings.courseName,
    reminders: state.settings.reminders,
  };
}

$('download-ics').addEventListener('click', async () => {
  const items = selected();
  setBusy(true);
  try {
    const res = await fetch('/api/ics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, ...exportOptions() }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Could not build the file.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(state.settings.courseName || 'syllabus').replace(/[^\w-]+/g, '-').toLowerCase()}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`Downloaded ${items.length} events. Open the file to import them into any calendar.`, 'done');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    setBusy(false);
  }
});

async function push(fn, label) {
  const items = selected();
  setBusy(true);
  try {
    setStatus(`Connecting to ${label}…`);
    const result = await fn(items, exportOptions(), (done, total) => {
      setStatus(`Adding to ${label}: ${done} of ${total}`, 'info', total ? done / total : 0);
    });
    if (result.failed.length) {
      setStatus(`Added ${result.added} of ${items.length}. ${result.failed.length} failed: ${result.failed[0].message}`, 'error');
    } else {
      setStatus(`Added ${result.added} events to ${label}. Check your calendar.`, 'done');
    }
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    setBusy(false);
  }
}

$('add-google').addEventListener('click', () => push(cal.addToGoogle, 'Google Calendar'));
$('add-outlook').addEventListener('click', () => push(cal.addToOutlook, 'Outlook'));

/* settings panel */
function openSettings(open) {
  $('settings').hidden = !open;
  $('scrim').hidden = !open;
  $('open-settings').setAttribute('aria-expanded', String(open));
  if (open) $('course-name').focus();
}
$('open-settings').addEventListener('click', () => openSettings(true));
$('close-settings').addEventListener('click', () => openSettings(false));
$('scrim').addEventListener('click', () => openSettings(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('settings').hidden) openSettings(false);
});

$('course-name').addEventListener('input', (e) => {
  state.settings.courseName = e.target.value.trim();
  saveSettings();
});
$('timezone').addEventListener('change', (e) => {
  state.settings.timeZone = e.target.value;
  saveSettings();
});

/* ------------------------------------------------------------------ setup */

function buildTimezones() {
  const sel = $('timezone');
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* older browser */ }
  if (!zones.length) {
    zones = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
      'Europe/London', 'Asia/Kolkata', 'UTC'];
  }
  if (!zones.includes(state.settings.timeZone)) zones.unshift(state.settings.timeZone);
  sel.innerHTML = zones.map((z) => `<option value="${z}">${z.replace(/_/g, ' ')}</option>`).join('');
  sel.value = state.settings.timeZone;
}

function buildReminders() {
  const box = $('reminders');
  box.innerHTML = '';
  for (const choice of REMINDERS) {
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = state.settings.reminders.includes(choice.minutes);
    input.addEventListener('change', () => {
      const set = new Set(state.settings.reminders);
      if (input.checked) set.add(choice.minutes); else set.delete(choice.minutes);
      state.settings.reminders = [...set].sort((a, b) => b - a);
      saveSettings();
    });
    label.appendChild(input);
    label.append(choice.label);
    box.appendChild(label);
  }
}

async function init() {
  loadSettings();
  buildTimezones();
  buildReminders();
  $('course-name').value = state.settings.courseName;
  await cal.loadConfig();
  const notes = [];
  notes.push(cal.googleReady() ? 'Google Calendar is set up.' : 'Google Calendar is not configured on this deployment.');
  notes.push(cal.outlookReady() ? 'Outlook is set up.' : 'Outlook is not configured on this deployment.');
  notes.push('Downloading an .ics file always works.');
  $('connection-note').textContent = notes.join(' ');
}

init();
