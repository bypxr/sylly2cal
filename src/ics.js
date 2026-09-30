// ics.js — builds an RFC 5545 calendar file that Google, Outlook and Apple
// Calendar will all import without complaint.

import { CATEGORIES, resolveWindow } from './schedule-parser.js';
import { zonedToUtc, toUtcStamp, toDateStamp, addDays } from './tz.js';

const escapeText = (s) => String(s ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/;/g, '\\;')
  .replace(/,/g, '\\,')
  .replace(/\r?\n/g, '\\n');

// iCalendar lines must not exceed 75 octets; continuations start with a space.
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const charSize = new TextEncoder().encode(char).length;
    if (size + charSize > (out.length === 0 ? 75 : 74)) {
      out.push(current);
      current = '';
      size = 0;
    }
    current += char;
    size += charSize;
  }
  if (current) out.push(current);
  return out.join('\r\n ');
}

function uid(item, index) {
  const seed = `${item.year}${item.month}${item.day}${item.title}${index}`.replace(/\W+/g, '');
  return `${seed.slice(0, 40)}-${Math.random().toString(36).slice(2, 8)}@syllabus-to-calendar`;
}

/**
 * @param {Array} items      parsed schedule items (already filtered to includes)
 * @param {Object} options   { timeZone, courseName, reminders: [minutes], calendarName }
 */
export function buildIcs(items, options = {}) {
  const {
    timeZone = 'UTC',
    courseName = '',
    reminders = [1440, 60],
    calendarName = 'Syllabus',
  } = options;

  const stamp = toUtcStamp(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//syllabus-to-calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    `X-WR-TIMEZONE:${escapeText(timeZone)}`,
  ];

  items.forEach((item, index) => {
    const window = resolveWindow(item);
    const cfg = CATEGORIES[item.category] || CATEGORIES.other;
    const summary = courseName ? `${courseName}: ${item.title}` : item.title;

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid(item, index)}`);
    lines.push(`DTSTAMP:${stamp}`);

    if (window.allDay) {
      const start = { y: window.start.y, m: window.start.m, d: window.start.d };
      lines.push(`DTSTART;VALUE=DATE:${toDateStamp(start)}`);
      lines.push(`DTEND;VALUE=DATE:${toDateStamp(addDays(start, 1))}`);
    } else {
      lines.push(`DTSTART:${toUtcStamp(zonedToUtc(window.start, timeZone))}`);
      lines.push(`DTEND:${toUtcStamp(zonedToUtc(window.end, timeZone))}`);
    }

    lines.push(`SUMMARY:${escapeText(summary)}`);
    if (item.location) lines.push(`LOCATION:${escapeText(item.location)}`);

    const description = [
      cfg.label,
      item.notes ? item.notes : '',
      item.source ? `From the syllabus: "${item.source}"` : '',
    ].filter(Boolean).join('\n');
    lines.push(`DESCRIPTION:${escapeText(description)}`);

    lines.push(`CATEGORIES:${escapeText(cfg.label)}`);
    lines.push(item.category === 'exam' ? 'TRANSP:OPAQUE' : 'TRANSP:TRANSPARENT');

    for (const minutes of reminders) {
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      lines.push(`DESCRIPTION:${escapeText(summary)}`);
      lines.push(`TRIGGER:-PT${minutes}M`);
      lines.push('END:VALARM');
    }

    lines.push('END:VEVENT');
  });

  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
