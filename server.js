// server.js — the backend.
//
// Three jobs: accept an upload, turn it into text the student can preview, and
// return the parsed schedule. It also serves the front end, so one process
// runs the whole app.
//
// Files are held in memory and discarded once parsed — nothing is written to
// disk and nothing is stored about who uploaded what.

import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractText, ACCEPTED } from './src/extract.js';
import { parseSyllabus, guessTerm, CATEGORIES } from './src/schedule-parser.js';
import { buildIcs } from './src/ics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = ACCEPTED.some((ext) => file.originalname.toLowerCase().endsWith(ext));
    cb(ok ? null : new Error(`Unsupported file type. Upload one of: ${ACCEPTED.join(', ')}`), ok);
  },
});

function termFromBody(body, text) {
  if (body?.termStart && body?.termEnd) {
    const start = new Date(body.termStart);
    const end = new Date(body.termEnd);
    if (!Number.isNaN(+start) && !Number.isNaN(+end) && end > start) {
      return { label: body.termLabel || 'Custom term', start, end };
    }
  }
  return guessTerm(text);
}

/**
 * Upload -> extracted text + parsed items in one round trip, so the student
 * sees the preview and the results together rather than waiting twice.
 */
app.post('/api/parse', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });

    const text = await extractText(req.file.buffer, req.file.originalname);
    const term = termFromBody(req.body, text);
    const { items } = parseSyllabus(text, { term });

    res.json({
      filename: req.file.originalname,
      term: { label: term.label, start: term.start.toISOString(), end: term.end.toISOString() },
      preview: text.length > 40000 ? `${text.slice(0, 40000)}\n…` : text,
      characters: text.length,
      items,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not read that file.' });
  }
});

/** Re-parse pasted or edited text without another upload. */
app.post('/api/parse-text', (req, res) => {
  try {
    const text = String(req.body?.text || '');
    if (text.replace(/\s/g, '').length < 30) {
      return res.status(400).json({ error: 'There was not enough text to read.' });
    }
    const term = termFromBody(req.body, text);
    const { items } = parseSyllabus(text, { term });
    res.json({
      filename: 'Pasted text',
      term: { label: term.label, start: term.start.toISOString(), end: term.end.toISOString() },
      preview: text,
      characters: text.length,
      items,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Build the .ics download from whatever the student ended up selecting. */
app.post('/api/ics', (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'No events were selected.' });

    const ics = buildIcs(items, {
      timeZone: req.body.timeZone || 'UTC',
      courseName: req.body.courseName || '',
      reminders: Array.isArray(req.body.reminders) ? req.body.reminders : [1440, 120],
      calendarName: req.body.courseName || 'Syllabus',
    });

    const safe = (req.body.courseName || 'syllabus').replace(/[^\w-]+/g, '-').toLowerCase();
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safe || 'syllabus'}.ics"`);
    res.send(ics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/categories', (req, res) => res.json(CATEGORIES));
app.get('/api/health', (req, res) => res.json({ ok: true }));

// multer and friends surface errors here.
app.use((err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'That file is over 25 MB. Try exporting just the schedule pages.' });
  }
  res.status(400).json({ error: err.message || 'Something went wrong.' });
});

app.listen(PORT, () => {
  console.log(`sylly2cal running on http://localhost:${PORT}`);
});
