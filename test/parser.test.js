// Regression tests built from the four real syllabi this was developed against.
// Each case is a bug that actually occurred.
import { parseSyllabus } from '../src/schedule-parser.js';

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      expected ${JSON.stringify(want)}\n      got      ${JSON.stringify(got)}`);
  ok ? pass++ : fail++;
};

const term = { label: 'Fall 2026', start: new Date(Date.UTC(2026, 7, 15)), end: new Date(Date.UTC(2026, 11, 31)) };
const one = (text) => parseSyllabus(text, { term }).items[0];
const date = (i) => i && `${i.year}-${String(i.month).padStart(2, '0')}-${String(i.day).padStart(2, '0')}`;

check('due date beats row date',
  date(one('9/10  Marketing Information  Ch. 4Checkpoint HW 1 Due Friday, 9/11 at 11pm')), '2026-09-11');

check('weekday not clipped from title',
  one('6  9/29  EXAM 1 (ADMINISTERED IN POLLOCK ON TUES. 9/29)').title, 'EXAM 1');

check('hyphenated mid-term is found', date(one('Mid-term #1 – Sep 25')), '2026-09-25');

check('bare time creates nothing',
  parseSyllabus('Submit your answers by 11:35 pm or receive a zero.', { term }).items.length, 0);

check('grading policy ignored',
  parseSyllabus('25% in-class midterm exam on Oct 7', { term }).items.length, 0);

const mid = one('Midterm 1: Oct 7 Tu 3:15 PM – 4:15 PM');
check('separate time result attaches', [date(mid), mid.startTime?.h, mid.endTime?.h], ['2026-10-07', 15, 16]);

check('overlapping anchors not treated as two items',
  one('Ch. 4Checkpoint HW 1 Due Friday, 9/11 at 11pm').title, 'Checkpoint HW 1');

const weekly = parseSyllabus(`Week 2 – Aug 31 - Sep 04
Week 3 – Sep 07 - 11
Week 4 – Sep 14 - 18
Week 5 – Sep 21 - 25
Mid-term #1 – Sep 25
There will be a quiz every week from week 2 thru 5, excluding those weeks in which we have a mid-term exam.
Quizzes must be completed by Friday at 11:59pm.`, { term });
check('weekly quizzes expand and skip exam week',
  weekly.items.filter((i) => i.category === 'quiz').map(date),
  ['2026-09-04', '2026-09-11', '2026-09-18']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
