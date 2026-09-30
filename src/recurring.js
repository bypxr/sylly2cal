// recurring.js — the last common gap after single-line parsing: syllabi that
// describe weekly work as a rule ("quizzes due every Friday, weeks 2-15")
// instead of listing 12 separate dates. Nothing here is guessed — every date
// produced is read off the syllabus's own week-by-week schedule table, so a
// generated quiz date is exactly as grounded as one lifted from a single line.

const WEEKDAY_INDEX = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};

const WEEK_LINE = /\bweek\s*#?\s*(\d{1,2})\b\s*[-–—:.]*\s*([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*(?:[-–—]|to|through)\s*(?:([A-Za-z]{3,9})\.?\s+)?(\d{1,2})\b/gi;

const TRIGGER_KEYWORDS = [
  ['quiz', 'quiz'],
  ['homework', 'homework'],
  ['problem set', 'homework'],
  ['reading assignment', 'assignment'],
  ['assignment', 'assignment'],
];

/**
 * Reads every "Week N — <start date> - <end date>" line in the syllabus and
 * builds a lookup from week number to its real calendar date range.
 * @param {string} text
 * @param {(m:number,d:number,y:number|null)=>number} resolveYear  same year
 *   resolution the line parser uses, injected so both stay consistent.
 * @param {(name:string)=>number|null} monthNumber
 */
export function extractWeekMap(text, monthNumber, resolveYear) {
  const map = new Map();
  for (const m of text.matchAll(WEEK_LINE)) {
    const weekNum = +m[1];
    if (map.has(weekNum)) continue; // first mention wins if a week is listed twice
    const startMonth = monthNumber(m[2]);
    const endMonth = monthNumber(m[4] || m[2]);
    if (!startMonth || !endMonth) continue;
    const startDay = +m[3];
    const endDay = +m[5];
    const startYear = resolveYear(startMonth, startDay);
    const endYear = endMonth < startMonth ? startYear + 1 : startYear;
    map.set(weekNum, {
      start: { y: startYear, m: startMonth, d: startDay },
      end: { y: endYear, m: endMonth, d: endDay },
    });
  }
  return map;
}

// The real calendar date within [start, end] that falls on the target weekday,
// computed from actual Date arithmetic rather than assumed from the label.
function dateOfWeekdayInRange(start, end, targetDow) {
  let cur = Date.UTC(start.y, start.m - 1, start.d);
  const endTs = Date.UTC(end.y, end.m - 1, end.d);
  while (cur <= endTs) {
    const d = new Date(cur);
    if (d.getUTCDay() === targetDow) return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
    cur += 86_400_000;
  }
  return null;
}

function parseClockLoose(s) {
  const m = String(s || '').match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!m) return null;
  let h = +m[1];
  const min = m[2] ? +m[2] : 0;
  const pm = /^p/i.test(m[3]);
  if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12;
  return { h, min };
}

/**
 * Finds language like "there will be a quiz every week from week 2 thru 15,
 * excluding weeks with a mid-term" and turns it into a structured rule.
 * Returns null if no such pattern is present — most syllabi don't have one,
 * and that's fine, this only ever adds items, never required.
 */
export function detectRecurringRules(text) {
  const rules = [];
  const lower = text.toLowerCase();

  for (const [keyword, category] of TRIGGER_KEYWORDS) {
    let searchFrom = 0;
    while (true) {
      const idx = lower.indexOf(keyword, searchFrom);
      if (idx === -1) break;
      searchFrom = idx + keyword.length;

      // Only look at cadence language actually near this mention.
      const window = text.slice(Math.max(0, idx - 200), idx + 500);
      if (!/\bevery\s+week\b|\bweekly\b|\beach\s+week\b/i.test(window)) continue;

      const dueMatch = window.match(/\b(?:due|completed|submit(?:ted)?)\b[^.]{0,100}?\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
      if (!dueMatch) continue;
      const dueDow = WEEKDAY_INDEX[dueMatch[1].toLowerCase()];
      const afterWeekday = window.slice(dueMatch.index + dueMatch[0].length, dueMatch.index + dueMatch[0].length + 60);
      const timeMatch = afterWeekday.match(/(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)/i);
      const dueTime = timeMatch ? parseClockLoose(timeMatch[1]) : null;

      const rangeMatch = window.match(/\bweeks?\s*(\d{1,2})\s*(?:thru|through|to|-|–|—)\s*(\d{1,2})\b/i);
      if (!rangeMatch) continue;
      const weekStart = +rangeMatch[1];
      const weekEnd = +rangeMatch[2];

      const excludesExamWeeks = /\bexclud\w*\b[^.]{0,60}?\bmid-?terms?\b|\bmid-?terms?\b[^.]{0,60}?\bexclud/i.test(window);

      // Quote whole sentences. Slicing a fixed character window lands
      // mid-word and produces descriptions like "d with high urgency. In the
      // event tha" on every generated event.
      const sentences = window.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
      const cadence = sentences.find((s) => new RegExp(`\\b${keyword}`, 'i').test(s) && /\bevery\b|\bweekly\b|\beach\s+week\b/i.test(s));
      const dueSentence = sentences.find((s) => /\b(?:due|completed|submit)/i.test(s) && /\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.test(s));
      const evidence = [cadence, dueSentence].filter(Boolean)
        .filter((s, i, arr) => arr.indexOf(s) === i)
        .join(' ')
        .replace(/\s+/g, ' ')
        .slice(0, 300);

      rules.push({
        category,
        label: keyword,
        dueDow,
        dueTime,
        weekStart,
        weekEnd,
        excludesExamWeeks,
        evidence: evidence || `Weekly ${keyword}, weeks ${weekStart}–${weekEnd}.`,
      });
      break; // one rule per keyword is enough — avoids duplicate rules from repeated mentions
    }
  }
  return rules;
}

/**
 * Turns detected rules into dated items using the week map, skipping any week
 * that already has an exam in it when the syllabus says to.
 * @param {Array} rules          from detectRecurringRules
 * @param {Map} weekMap          from extractWeekMap
 * @param {Array} existingItems  already-parsed items, used to find exam weeks
 *   and to avoid generating a rule for a category that's already been listed
 *   explicitly (e.g. 12 individually named quizzes already found by the line
 *   parser — don't also generate 12 generic ones on top of those).
 */
export function expandRecurringRules(rules, weekMap, existingItems) {
  const out = [];

  const weekOfDate = (year, month, day) => {
    const ts = Date.UTC(year, month - 1, day);
    for (const [num, range] of weekMap) {
      if (ts >= Date.UTC(range.start.y, range.start.m - 1, range.start.d)
        && ts <= Date.UTC(range.end.y, range.end.m - 1, range.end.d)) return num;
    }
    return null;
  };

  for (const rule of rules) {
    const alreadyListed = existingItems.filter((i) => i.category === rule.category).length;
    if (alreadyListed >= 3) continue; // this category already has an explicit list; don't duplicate it

    const examWeeks = new Set(
      rule.excludesExamWeeks
        ? existingItems.filter((i) => i.category === 'exam').map((i) => weekOfDate(i.year, i.month, i.day)).filter(Boolean)
        : [],
    );

    for (let w = rule.weekStart; w <= rule.weekEnd; w++) {
      if (examWeeks.has(w)) continue;
      const range = weekMap.get(w);
      if (!range) continue;
      const date = rule.dueDow == null ? range.end : dateOfWeekdayInRange(range.start, range.end, rule.dueDow);
      if (!date) continue;

      out.push({
        id: `recurring-${rule.category}-w${w}-${date.y}${date.m}${date.d}`,
        title: `${rule.label.charAt(0).toUpperCase()}${rule.label.slice(1)} ${w}`,
        category: rule.category,
        year: date.y,
        month: date.m,
        day: date.d,
        startTime: rule.dueTime,
        endTime: null,
        allDay: !rule.dueTime,
        location: '',
        source: rule.evidence,
        confidence: 0.8,
        include: true,
        isRecurring: true,
      });
    }
  }
  return out;
}
