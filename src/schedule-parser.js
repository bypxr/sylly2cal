// schedule-parser.js — v2 of the syllabus reader.
//
// Rebuilt around chrono-node after testing against real syllabi from four
// departments. chrono handles the date grammar (ranges, weekday+date, implied
// years, times) far better than hand-rolled regex; everything here is the
// layer above it: deciding which of several dates on a line is the operative
// one, what the item is called, and what type it is.

import * as chrono from 'chrono-node';
import { extractWeekMap, detectRecurringRules, expandRecurringRules } from './recurring.js';

export const CATEGORIES = {
  exam: { label: 'Exam', defaultMinutes: 120, deadline: false },
  quiz: { label: 'Quiz', defaultMinutes: 30, deadline: true },
  homework: { label: 'Homework', defaultMinutes: 30, deadline: true },
  assignment: { label: 'Assignment', defaultMinutes: 30, deadline: true },
  other: { label: 'Other', defaultMinutes: 30, deadline: true },
};

const WEEKDAY_WORDS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'mon', 'tues', 'tue', 'weds', 'wed', 'thurs', 'thur', 'thu', 'fri', 'sat', 'sun']
  .sort((a, b) => b.length - a.length).join('|');
// Longest-first with a closing boundary. Without both, "TUES." in
// "POLLOCK ON TUES." gets clipped to "S." and "Friday" to "day".
const WEEKDAY_RE = new RegExp(`\\b(?:${WEEKDAY_WORDS})\\b\\.?,?\\s*`, 'gi');

// Canonical names these syllabi actually use. When one matches, it becomes the
// title outright — far cleaner than subtracting spans from a full table row.
const TITLE_ANCHORS = [
  /\bfinal\s+exam(?:ination)?\b/i,
  /\bmid-?term\s*(?:exam\s*)?#?\s*\d+\b/i,
  /\bmid-?terms?\s*(?:exams?)?\b/i,
  /\bexam\s*#?\s*(\d+|[IVX]+)\b/i,
  /\bcheckpoint\s+hw\s*#?\s*\d+\b/i,
  /\bquiz\s*#?\s*\d+\b/i,
  /\bsyllabus\s+quiz\b/i,
  /\bhw\s*#?\s*\d+\b/i,
  /\bhomework\s*#?\s*\d+\b/i,
  /\bproblem\s+set\s*#?\s*\d+\b/i,
  /\bps\s*#?\s*\d+\b/i,
  /\blab\s*(?:report)?\s*#?\s*\d+\b/i,
  /\bproject\s+(?:milestone|proposal|report|presentation)\b/i,
  /\b(?:reflection|research|final|term)\s+paper\b/i,
  /\bjob\s+interview\s+paper\b/i,
  /\bai\s+assignment\b/i,
  /\bassignment\s*#?\s*\d+\b/i,
  /\bessay\s*#?\s*\d*\b/i,
  /\bpresentation\b/i,
  /\bextra\s+credit\s*#?\s*\d*\b/i,
];

const CLASSIFIERS = [
  [/\bfinal\s+exam(?:ination)?\b|\bfinals?\s+week\b/i, 'exam'],
  [/\bmid-?term\b|\bexam\b|\btest\s*#?\s*\d\b/i, 'exam'],
  [/\bquiz(?:zes)?\b/i, 'quiz'],
  [/\bcheckpoint\s+hw\b|\bhomework\b|\bhw\s*#?\s*\d*\b|\bproblem\s+set\b|\bp-?set\b|\bps\s*#?\s*\d+\b/i, 'homework'],
  [/\bpaper\b|\bessay\b|\bproject\b|\blab\b|\bpresentation\b|\bassignment\b|\breflection\b|\bmemo\b|\bdiscussion\s+post\b|\bextra\s+credit\b/i, 'assignment'],
  [/\bdrop\s+deadline\b|\blast\s+day\s+to\b|\bwithdraw/i, 'other'],
];

// A line must show one of these to be a deliverable at all.
const KEEP = /\bdue\b|\bdeadline\b|\bsubmit\b|\bexam\b|\bmid-?term\b|\bquiz\b|\btest\b|\bhomework\b|\bhw\b|\bproblem\s+set\b|\bp-?set\b|\bps\s*#?\s*\d\b|\bassignment\b|\bproject\b|\bpaper\b|\bessay\b|\blab\b|\bpresentation\b|\bextra\s+credit\b|\bdrop\b|\bwithdraw/i;

// Lines that mention deliverables but aren't scheduling them.
const DROP = [
  /\bno\s+class(?:es)?\b/i,
  /\bholiday\b|\brecess\b|\bthanksgiving\b/i,
  /\boffice\s+hours\b/i,
  /^\s*\d{1,3}\s*%/,                       // "25% in-class midterm exam on Oct 7"
  /\b\d{1,3}\s*%\s*(?:of|in-class|final|midterm|exam|quiz|grade)/i,
  /\bmake-?up\s+exam\s+policy\b/i,
  /\bwill\s+be\s+dropped\b|\bdrop\s+the\s+two\s+lowest\b/i,
  /\bregrade\b/i,
  /\bacademic\s+integrity\b|\bplagiarism\b|\bhonor\s+code\b/i,
];

const EXPLICIT_DATE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*\d|\d{1,2}\s*\/\s*\d{1,2}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

const clean = (s) => s.replace(/[\s\u00a0]+/g, ' ').trim();

/* ------------------------------------------------------------------ term */

export function guessTerm(text, today = new Date()) {
  const m = text.match(/\b(fall|autumn|spring|summer|winter)\s*(?:semester\s*)?(?:of\s*)?(\d{4})\b/i);
  const seasons = {
    fall: [7, 15, 11, 31], autumn: [7, 15, 11, 31],
    spring: [0, 5, 4, 20], summer: [4, 10, 7, 15], winter: [11, 20, 1, 28],
  };
  let season, year;
  if (m) { season = m[1].toLowerCase(); year = +m[2]; } else {
    const mo = today.getMonth();
    season = mo >= 7 ? 'fall' : mo >= 4 ? 'summer' : 'spring';
    year = today.getFullYear();
  }
  const [sm, sd, em, ed] = seasons[season];
  const endYear = em < sm ? year + 1 : year;
  return {
    label: `${season[0].toUpperCase()}${season.slice(1)} ${year}`,
    start: new Date(Date.UTC(year, sm, sd)),
    end: new Date(Date.UTC(endYear, em, ed)),
  };
}

/* ------------------------------------------------------------- locations */

const NOT_A_PLACE = /^(?:week|weeks|chapter|chapters|ch|unit|module|section|lesson|page|pp|part|problem|exercise|question|figure|table|appendix|day|fall|spring|summer|winter|quiz|exam|test|homework|hw|lab|assignment|project|paper|set|ps|midterm|final|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i;

const LOCATION_PATTERNS = [
  [/\b(?:in|at)\s+(?:the\s+)?((?:[A-Z][A-Za-z.'-]+\s+){0,3}(?:Building|Bldg\.?|Hall|Center|Centre|Auditorium|Theatre|Theater|Library|Lab(?:oratory)?|Gym|Pavilion|Complex|Room)(?:\s+[A-Z]?-?\d{1,4}[A-Z]?)?)/, 1],
  [/\b(?:administered\s+in|held\s+in|located\s+in)\s+([A-Z][A-Za-z]+(?:\s+\d{1,4})?)/i, 1],
  [/\b(?:Room|Rm\.?)\s*([A-Z]?-?\d{1,4}[A-Z]?)\b/i, 0],
  [/\b((?:[A-Z][a-z]{2,}\s){1,2}\d{2,4}[A-Z]?)\b/, 1],
  [/\b(Zoom|Microsoft\s+Teams|Google\s+Meet|Canvas|Gradescope|Blackboard|Moodle|Brightspace|Connect)\b/i, 1],
  [/\b(online|remote|asynchronous)\b/i, 1],
];

function findLocation(line) {
  for (const [re, group] of LOCATION_PATTERNS) {
    const m = line.match(re);
    if (!m) continue;
    const value = clean(m[group] || '');
    if (!value || NOT_A_PLACE.test(value) || value.length < 2 || value.length > 60) continue;
    return { value: value.replace(/^rm\.?\s*/i, 'Room '), text: m[0] };
  }
  return null;
}

/* ------------------------------------------------------------------ dates */

// chrono returns every date on the line. Which one is the deliverable's date
// depends on the sentence: "9/10 ... HW 1 Due Friday, 9/11" must resolve to
// 9/11, not the row's class date.
function pickOperativeDate(line, results) {
  if (!results.length) return null;
  const dueMatch = line.match(/\b(?:due|deadline|submit(?:ted)?|closes?|is\s+on|will\s+be\s+(?:on|held)|scheduled\s+for|held\s+on|administered)\b/i);
  if (dueMatch) {
    const after = results.find((r) => r.index >= dueMatch.index);
    if (after) return after;
  }
  // Prefer an exact day over a multi-day week range ("10/5 – 10/11").
  const exact = results.find((r) => !isMultiDayRange(r));
  return exact || results[0];
}

function isMultiDayRange(result) {
  if (!result.end) return false;
  const a = result.start.date();
  const b = result.end.date();
  return b.getTime() - a.getTime() >= 20 * 3600 * 1000;
}

function hasCertainTime(component) {
  return component && component.isCertain && component.isCertain('hour');
}

/* ------------------------------------------------------------------ title */

function buildTitle(line, spans) {
  for (const anchor of TITLE_ANCHORS) {
    const m = line.match(anchor);
    if (m) return clean(m[0]).replace(/\s+/g, ' ');
  }
  let t = line;
  for (const span of spans) if (span) t = t.split(span).join(' ');
  t = t
    .replace(WEEKDAY_RE, ' ')
    .replace(/^\s*week\s*#?\s*\d+\s*[-–—:.|]?\s*/i, '')
    .replace(/\bch(?:apter)?s?\.?\s*\d+(?:\s*[&,-]\s*\d+)*\b/gi, ' ')
    .replace(/\b(?:cont\.?|continued)\b/gi, ' ')
    .replace(/\blocation\s*:?\s*(?:is\s*)?(?:tba|tbd)\b/gi, ' ')
    .replace(/[|•·\t]+/g, ' ')
    .replace(/\(\s*\)/g, ' ');
  t = clean(t);
  for (let i = 0; i < 6; i++) {
    const next = clean(t)
      .replace(/^[\s,;:.\-–—)\]0-9]+/, '')
      .replace(/[\s,;:\-–—(]+$/, '')
      .replace(/(?:^|\s)(?:due|by|on|at|in|via|from|to|is|are|the|and|will|be|held|scheduled)\s*[,.;:–—-]*$/i, '');
    if (next === t) break;
    t = next;
  }
  t = clean(t);
  if (t.length > 80) t = t.slice(0, 80).replace(/\s+\S*$/, '') + '…';
  if (t.replace(/[^a-z0-9]/gi, '').length < 3) return null;
  return t[0].toUpperCase() + t.slice(1);
}

function classify(line) {
  for (const [re, category] of CLASSIFIERS) if (re.test(line)) return category;
  return 'other';
}

/* -------------------------------------------------------------- main pass */

function scoreConfidence({ line, result, category, title }) {
  let score = 0.5;
  if (/\bdue\b|\bdeadline\b/i.test(line)) score += 0.15;
  if (hasCertainTime(result.start)) score += 0.15;
  if (result.start.isCertain('year')) score += 0.05;
  if (category === 'exam' || category === 'quiz' || category === 'homework') score += 0.1;
  if (TITLE_ANCHORS.some((a) => a.test(title))) score += 0.15;
  if (isMultiDayRange(result)) score -= 0.2;
  if (line.length > 200) score -= 0.15;
  if (/\btba\b|\btbd\b|\bif\s+needed\b|\bdetails\s+will\b/i.test(line)) score -= 0.25;
  return Math.max(0.05, Math.min(1, score));
}

function parseLines(text, term) {
  const refDate = term.start;
  const lines = String(text).replace(/\r/g, '').split('\n')
    // Table cells often arrive glued together ("Ch. 4Checkpoint HW 1"), which
    // destroys the word boundary the title anchors rely on.
    .map((l) => clean(l).replace(/(\d)([A-Z][a-z])/g, '$1 $2'))
    .filter((l) => l.length > 3 && l.length < 500);

  const found = [];
  for (const line of lines) {
    if (DROP.some((re) => re.test(line)) && !/\bdue\b/i.test(line)) continue;
    if (!KEEP.test(line)) continue;

    const results = chrono.parse(line, refDate, { forwardDate: false });
    if (!results.length) continue;

    // "There will be two in-class Midterms on Oct 7 and Nov 11, and a Final
    // exam on the week of Dec 14." names three items; pairing all of them with
    // one date produces wrong entries that then outrank the real rows.
    // Count distinct *items* named, merging overlapping matches: "Checkpoint
    // HW 1" also matches the bare "HW 1" pattern a few characters in, and that
    // is one deliverable, not two.
    const spansFound = [];
    for (const a of TITLE_ANCHORS) {
      const m = line.match(a);
      if (m) spansFound.push([m.index, m.index + m[0].length]);
    }
    spansFound.sort((x, y) => x[0] - y[0]);
    let distinctItems = 0;
    let reach = -1;
    for (const [from, to] of spansFound) {
      if (from >= reach) { distinctItems++; reach = to; } else { reach = Math.max(reach, to); }
    }
    if (results.length >= 2 && distinctItems >= 2) continue;

    const result = pickOperativeDate(line, results);
    if (!result) continue;

    // chrono anchors a bare time ("submit by 11:35 pm") to the reference date,
    // which would invent an item on the first day of term. Only accept a
    // result that actually names a calendar day.
    if (!result.start.isCertain('day') || !result.start.isCertain('month')) continue;

    // Must be an actual written date. Relative phrases ("noon the day before",
    // "24 hours after the deadline") resolve to a real day but describe policy,
    // not a scheduled item.
    if (!EXPLICIT_DATE.test(result.text)) continue;

    const start = result.start.date();
    const year = start.getUTCFullYear();
    // Guard against chrono resolving a stray number to a wildly off year.
    if (year < term.start.getUTCFullYear() - 1 || year > term.end.getUTCFullYear() + 1) continue;

    const spans = results.map((r) => r.text);
    const withoutDates = spans.reduce((acc, s) => acc.split(s).join(' '), line);
    const location = findLocation(withoutDates);
    const title = buildTitle(line, [...spans, location?.text]);
    if (!title) continue;

    const category = classify(line);
    // "Midterm 1: Oct 7 Tu 3:15 PM - 4:15 PM" splits into a date result and a
    // separate time-only result, so pull the clock off whichever one has it.
    const isTimeText = (t) => /\d\s*:\s*\d|\d\s*[ap]\.?m\.?|\bnoon\b|\bmidnight\b/i.test(t);
    let timeSource = (hasCertainTime(result.start) && isTimeText(result.text)) ? result : null;
    if (!timeSource) {
      timeSource = results.find((r) => r !== result && hasCertainTime(r.start)
        && isTimeText(r.text) && !r.start.isCertain('day')) || null;
    }

    const startTime = timeSource
      ? { h: timeSource.start.date().getUTCHours(), min: timeSource.start.date().getUTCMinutes() }
      : null;
    const endDate = timeSource?.end?.date();
    const endTime = (startTime && timeSource.end && hasCertainTime(timeSource.end) && !isMultiDayRange(timeSource))
      ? { h: endDate.getUTCHours(), min: endDate.getUTCMinutes() } : null;

    found.push({
      title,
      category,
      year,
      month: start.getUTCMonth() + 1,
      day: start.getUTCDate(),
      startTime,
      endTime,
      allDay: !startTime,
      location: location?.value || '',
      source: line.length > 300 ? line.slice(0, 300) + '…' : line,
      confidence: scoreConfidence({ line, result, category, title }),
      isRange: isMultiDayRange(result),
      include: true,
    });
  }
  return found;
}

/* ----------------------------------------------------------------- dedupe */

const normTitle = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Richer entry wins: a real time beats none, an exact day beats a week range,
// then higher confidence, then the tighter title.
function better(a, b) {
  if (!!a.startTime !== !!b.startTime) return a.startTime ? a : b;
  if (a.isRange !== b.isRange) return a.isRange ? b : a;
  if (Math.abs(a.confidence - b.confidence) > 0.01) return a.confidence > b.confidence ? a : b;
  if (!!a.location !== !!b.location) return a.location ? a : b;
  return a.title.length <= b.title.length ? a : b;
}

function dedupe(items) {
  // Stage 1: the same named item mentioned in several places ("Midterm 1" in
  // the week table, in the grading section, and in a prose sentence).
  const byName = new Map();
  const passthrough = [];
  for (const item of items) {
    const named = /\d/.test(item.title) || /final\s*exam/i.test(item.title);
    if (!named) { passthrough.push(item); continue; }
    const key = `${item.category}|${normTitle(item.title)}`;
    byName.set(key, byName.has(key) ? better(byName.get(key), item) : item);
  }

  // Stage 2: anything landing on the same day in the same category.
  const byDay = new Map();
  for (const item of [...byName.values(), ...passthrough]) {
    const key = `${item.year}-${item.month}-${item.day}|${item.category}`;
    byDay.set(key, byDay.has(key) ? better(byDay.get(key), item) : item);
  }

  return [...byDay.values()].sort((a, b) => (
    Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day)
    || (a.startTime?.h ?? 0) - (b.startTime?.h ?? 0)
  ));
}

/* ------------------------------------------------------------------- api */

const MONTH_NUMS = { jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,
  jul:7,july:7,aug:8,august:8,sep:9,sept:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12 };

export function parseSyllabus(text, options = {}) {
  const term = options.term || guessTerm(text, options.today);
  const raw = parseLines(text, term);

  // Weekly work stated as a rule ("quiz due every Friday, weeks 2-15") rather
  // than as 12 dated rows. Dates come from the syllabus's own week table.
  const weekMap = extractWeekMap(
    text,
    (name) => MONTH_NUMS[String(name).toLowerCase()],
    (m, d) => {
      const startY = term.start.getUTCFullYear();
      const candidates = [startY, startY + 1];
      let best = startY, bestDist = Infinity;
      for (const y of candidates) {
        const t = Date.UTC(y, m - 1, d);
        const inside = t >= term.start.getTime() && t <= term.end.getTime();
        const dist = inside ? 0 : Math.min(Math.abs(t - term.start), Math.abs(t - term.end));
        if (dist < bestDist) { bestDist = dist; best = y; }
      }
      return best;
    },
  );
  if (weekMap.size > 0) {
    const deduped = dedupe(raw);
    for (const gen of expandRecurringRules(detectRecurringRules(text), weekMap, deduped)) {
      raw.push({ ...gen, isRange: false });
    }
  }

  const items = dedupe(raw).map((item, index) => ({
    ...item,
    id: `item-${item.year}${item.month}${item.day}-${normTitle(item.title).slice(0, 20)}-${index}`,
  }));
  return { term, items };
}

export function resolveWindow(item) {
  const cfg = CATEGORIES[item.category] || CATEGORIES.other;
  if (item.allDay) {
    return { allDay: true, start: { y: item.year, m: item.month, d: item.day, h: 0, min: 0 } };
  }
  const base = { y: item.year, m: item.month, d: item.day };
  if (item.endTime) {
    return {
      allDay: false,
      start: { ...base, ...item.startTime },
      end: { ...base, ...item.endTime },
    };
  }
  const due = item.startTime.h * 60 + item.startTime.min;
  let s = cfg.deadline ? due - cfg.defaultMinutes : due;
  let e = cfg.deadline ? due : due + cfg.defaultMinutes;
  if (cfg.deadline && item.startTime.min >= 45) s = item.startTime.h * 60;
  if (s < 0) { s = 0; e = Math.max(e, cfg.defaultMinutes); }
  const toHM = (mins) => ({ h: Math.floor(mins / 60) % 24, min: mins % 60 });
  return { allDay: false, start: { ...base, ...toHM(s) }, end: { ...base, ...toHM(e) } };
}
