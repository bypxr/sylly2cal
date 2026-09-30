// tz.js — converting "6:30 pm on Oct 9 in America/New_York" into a real instant.
// Done with Intl only, so there's no date library to keep up to date.

export function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// How far the zone sits from UTC at a given instant, in milliseconds.
function offsetAt(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);

  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUTC - instant.getTime();
}

/**
 * Wall-clock fields in a named zone -> UTC Date.
 * Runs twice because the offset itself depends on the instant, which is exactly
 * what goes wrong on the two DST-shift weekends each year.
 */
export function zonedToUtc({ y, m, d, h = 0, min = 0 }, timeZone) {
  const naive = Date.UTC(y, m - 1, d, h, min, 0);
  let ts = naive - offsetAt(new Date(naive), timeZone);
  ts = naive - offsetAt(new Date(ts), timeZone);
  return new Date(ts);
}

const pad = (n) => String(n).padStart(2, '0');

export function toUtcStamp(date) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

export function toDateStamp({ y, m, d }) {
  return `${y}${pad(m)}${pad(d)}`;
}

export function toIsoLocal({ y, m, d, h = 0, min = 0 }) {
  return `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(min)}:00`;
}

export function addDays({ y, m, d }, days) {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function formatDate({ y, m, d }, style = 'long') {
  const dt = new Date(Date.UTC(y, m - 1, d));
  const weekday = DAY_NAMES[dt.getUTCDay()];
  if (style === 'short') return `${weekday.slice(0, 3)} ${MONTH_NAMES[m - 1].slice(0, 3)} ${d}`;
  return `${weekday}, ${MONTH_NAMES[m - 1]} ${d}, ${y}`;
}

export function formatTime({ h, min }, hour12 = true) {
  if (!hour12) return `${pad(h)}:${pad(min)}`;
  const suffix = h >= 12 ? 'pm' : 'am';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${pad(min)} ${suffix}`;
}

export const MONTH_LABELS = MONTH_NAMES;
