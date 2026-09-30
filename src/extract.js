// extract.js (server) — turns an uploaded file into plain text.
//
// Runs on the server so the browser never needs heavy PDF libraries, and so
// the same extraction code produces the same text every time regardless of the
// student's browser.

import mammoth from 'mammoth';
import { JSDOM } from 'jsdom';

/**
 * DOCX: convert to HTML first so table rows survive as rows. Syllabus
 * schedules are nearly always tables, and flattening them to a text blob
 * separates each date from the assignment sitting next to it.
 */
async function readDocx(buffer) {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const doc = new JSDOM(html).window.document;
  const lines = [];
  doc.body.querySelectorAll('p, li, tr, h1, h2, h3, h4').forEach((el) => {
    if (el.tagName === 'TR') {
      lines.push([...el.querySelectorAll('td, th')]
        .map((c) => c.textContent.trim()).filter(Boolean).join('  '));
    } else if (!el.closest('tr')) {
      lines.push(el.textContent.trim());
    }
  });
  return lines.filter(Boolean).join('\n');
}

/**
 * PDF: pdf.js stores loose glyph runs, not lines. Bucket them by vertical
 * position and read each bucket left to right, or schedule tables come out
 * shuffled.
 */
async function readPdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;

  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const rows = new Map();
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const y = Math.round(item.transform[5] / 3) * 3; // tolerate baseline jitter
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: item.transform[4], width: item.width || 0, str: item.str });
    }

    // Gaps must be measured from where the previous run *ends*, not where it
    // starts. Measuring from the start makes a wide run look like a column
    // break, which splits "9/7" into "9/  7" and "11/11" into "11/1  1" —
    // those then parse as the wrong dates entirely.
    const lines = [...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, runs]) => runs.sort((a, b) => a.x - b.x)
        .reduce((line, run, i, arr) => {
          const prev = arr[i - 1];
          if (!prev) return run.str;
          const gap = run.x - (prev.x + prev.width);
          if (/\s$/.test(line) || /^\s/.test(run.str)) return line + run.str;
          if (gap > 8) return `${line}  ${run.str}`;   // column boundary
          if (gap > 1.2) return `${line} ${run.str}`;  // ordinary word space
          return line + run.str;                        // same word or number
        }, '').trim());
    pages.push(lines.filter(Boolean).join('\n'));
  }
  return pages.join('\n\n');
}

export const ACCEPTED = ['.pdf', '.docx', '.txt', '.md', '.csv', '.html', '.htm'];

export async function extractText(buffer, filename = '') {
  const name = filename.toLowerCase();

  if (name.endsWith('.pdf')) {
    const text = await readPdf(buffer);
    if (text.replace(/\s/g, '').length < 40) {
      const err = new Error('This PDF has no selectable text, which usually means it is a scan. Run it through OCR, or paste the schedule as text instead.');
      err.status = 422;
      throw err;
    }
    return text;
  }

  if (name.endsWith('.docx')) return readDocx(buffer);

  if (name.endsWith('.doc')) {
    const err = new Error('Old .doc files are not supported. Save it as .docx or PDF and try again.');
    err.status = 415;
    throw err;
  }

  if (name.endsWith('.html') || name.endsWith('.htm')) {
    const doc = new JSDOM(buffer.toString('utf8')).window.document;
    return [...doc.body.querySelectorAll('p, li, tr, div, h1, h2, h3')]
      .map((el) => (el.tagName === 'TR'
        ? [...el.children].map((c) => c.textContent.trim()).join('  ')
        : el.textContent.trim()))
      .filter(Boolean).join('\n');
  }

  return buffer.toString('utf8');
}
