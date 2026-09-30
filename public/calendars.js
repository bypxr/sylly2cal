// calendars.js — one-click sign-in and event creation for Google and Outlook.
//
// Auth deliberately stays in the browser. The student clicks one button, the
// provider's own popup handles the login, and the access token lives in this
// tab only. Nothing about their account reaches our server, which means there
// are no sessions to manage, no tokens to store, and no refresh flow to get
// wrong. Both providers support this from a static page with no client secret.

import { CATEGORIES, resolveWindow } from './shared.js';

const GIS_URL = 'https://accounts.google.com/gsi/client';
const MSAL_URL = 'https://cdn.jsdelivr.net/npm/@azure/msal-browser@3.20.0/lib/msal-browser.min.js';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const GRAPH_SCOPES = ['Calendars.ReadWrite'];

let config = { googleClientId: '', microsoftClientId: '', microsoftTenant: 'common' };

export async function loadConfig() {
  try {
    const res = await fetch('./config.json');
    if (res.ok) config = { ...config, ...(await res.json()) };
  } catch { /* fall back to unset — .ics download still works */ }
  return config;
}

const isSet = (v) => Boolean(v && !v.startsWith('YOUR_'));
export const googleReady = () => isSet(config.googleClientId);
export const outlookReady = () => isSet(config.microsoftClientId);

function loadScript(src, check) {
  return new Promise((resolve, reject) => {
    if (check()) return resolve(check());
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve(check());
    s.onerror = () => reject(new Error('Could not reach the sign-in service. Check your connection.'));
    document.head.appendChild(s);
  });
}

/* ----------------------------------------------------------------- shared */

const pad = (n) => String(n).padStart(2, '0');
const isoLocal = ({ y, m, d, h = 0, min = 0 }) => `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(min)}:00`;
const isoDate = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;

function nextDay({ y, m, d }) {
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

// The description is what the student sees when they tap the event weeks from
// now, so it carries the syllabus line the event came from.
function describe(item) {
  const cfg = CATEGORIES[item.category] || CATEGORIES.other;
  const lines = [cfg.label];
  if (item.location) lines.push(`Where: ${item.location}`);
  if (item.source) lines.push('', `From the syllabus: "${item.source}"`);
  lines.push('', 'Added by sylly2cal — double-check against your syllabus.');
  return lines.join('\n');
}

/* ----------------------------------------------------------------- google */

let googleToken = null;
let googleExpiry = 0;

export async function connectGoogle() {
  if (!googleReady()) throw new Error('Google Calendar is not configured on this deployment. Use the .ics download instead.');
  if (googleToken && Date.now() < googleExpiry - 60_000) return googleToken;

  await loadScript(GIS_URL, () => window.google?.accounts?.oauth2);
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: config.googleClientId,
      scope: GOOGLE_SCOPE,
      callback: (r) => {
        if (r.error) return reject(new Error('Google sign-in was cancelled.'));
        googleToken = r.access_token;
        googleExpiry = Date.now() + (Number(r.expires_in) || 3600) * 1000;
        resolve(googleToken);
      },
      error_callback: () => reject(new Error('Google sign-in was cancelled.')),
    });
    client.requestAccessToken({ prompt: '' });
  });
}

export const googleConnected = () => Boolean(googleToken && Date.now() < googleExpiry);

function toGoogleEvent(item, opts) {
  const w = resolveWindow(item);
  const summary = opts.courseName ? `${opts.courseName}: ${item.title}` : item.title;
  const body = {
    summary,
    description: describe(item),
    reminders: {
      useDefault: false,
      overrides: opts.reminders.slice(0, 5).map((minutes) => ({ method: 'popup', minutes })),
    },
    transparency: item.category === 'exam' ? 'opaque' : 'transparent',
  };
  if (item.location) body.location = item.location;
  if (w.allDay) {
    body.start = { date: isoDate(w.start) };
    body.end = { date: isoDate(nextDay(w.start)) };
  } else {
    body.start = { dateTime: isoLocal(w.start), timeZone: opts.timeZone };
    body.end = { dateTime: isoLocal(w.end), timeZone: opts.timeZone };
  }
  return body;
}

/* -------------------------------------------------------------- microsoft */

let msalApp = null;
let msAccount = null;

async function getMsal() {
  if (msalApp) return msalApp;
  const msal = await loadScript(MSAL_URL, () => window.msal);
  msalApp = new msal.PublicClientApplication({
    auth: {
      clientId: config.microsoftClientId,
      authority: `https://login.microsoftonline.com/${config.microsoftTenant || 'common'}`,
      redirectUri: window.location.origin + window.location.pathname,
    },
    cache: { cacheLocation: 'sessionStorage' },
  });
  await msalApp.initialize();
  return msalApp;
}

export async function connectOutlook() {
  if (!outlookReady()) throw new Error('Outlook is not configured on this deployment. Use the .ics download instead.');
  const app = await getMsal();
  const existing = app.getAllAccounts();
  if (existing.length) msAccount = existing[0];
  if (msAccount) {
    try {
      const silent = await app.acquireTokenSilent({ scopes: GRAPH_SCOPES, account: msAccount });
      return silent.accessToken;
    } catch { /* fall through to the popup */ }
  }
  const result = await app.loginPopup({ scopes: GRAPH_SCOPES, prompt: 'select_account' });
  msAccount = result.account;
  app.setActiveAccount(msAccount);
  return result.accessToken;
}

export const outlookConnected = () => Boolean(msAccount);

function toGraphEvent(item, opts) {
  const w = resolveWindow(item);
  const subject = opts.courseName ? `${opts.courseName}: ${item.title}` : item.title;
  const body = {
    subject,
    body: { contentType: 'text', content: describe(item) },
    isReminderOn: opts.reminders.length > 0,
    reminderMinutesBeforeStart: opts.reminders.length ? Math.max(...opts.reminders) : 60,
    showAs: item.category === 'exam' ? 'busy' : 'free',
  };
  if (item.location) body.location = { displayName: item.location };
  if (w.allDay) {
    body.isAllDay = true;
    body.start = { dateTime: isoLocal({ ...w.start, h: 0, min: 0 }), timeZone: opts.timeZone };
    body.end = { dateTime: isoLocal({ ...nextDay(w.start), h: 0, min: 0 }), timeZone: opts.timeZone };
  } else {
    body.start = { dateTime: isoLocal(w.start), timeZone: opts.timeZone };
    body.end = { dateTime: isoLocal(w.end), timeZone: opts.timeZone };
  }
  return body;
}

/* ------------------------------------------------------------------ push */

async function pushAll(items, opts, onProgress, request) {
  const failed = [];
  let added = 0;
  for (const [index, item] of items.entries()) {
    onProgress?.(index, items.length);
    try {
      const res = await request(item);
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail?.error?.message || `Server returned ${res.status}`);
      }
      added++;
    } catch (err) {
      failed.push({ item, message: err.message });
    }
  }
  onProgress?.(items.length, items.length);
  return { added, failed };
}

export async function addToGoogle(items, opts, onProgress) {
  const token = await connectGoogle();
  return pushAll(items, opts, onProgress, (item) => fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(toGoogleEvent(item, opts)),
    },
  ));
}

export async function addToOutlook(items, opts, onProgress) {
  const token = await connectOutlook();
  return pushAll(items, opts, onProgress, (item) => fetch(
    'https://graph.microsoft.com/v1.0/me/events',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(toGraphEvent(item, opts)),
    },
  ));
}
