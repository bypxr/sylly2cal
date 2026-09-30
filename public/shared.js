// shared.js — the few parser pieces the browser needs. Parsing itself
// happens on the server; this is only for rendering and event building.

export const CATEGORIES = {
  exam: { label: 'Exam', defaultMinutes: 120, deadline: false },
  quiz: { label: 'Quiz', defaultMinutes: 30, deadline: true },
  homework: { label: 'Homework', defaultMinutes: 30, deadline: true },
  assignment: { label: 'Assignment', defaultMinutes: 30, deadline: true },
  other: { label: 'Other', defaultMinutes: 30, deadline: true },
};


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
