# sylly2cal

Turn a course syllabus into calendar events. Upload the PDF or Word file your professor posted, check the list of exams, quizzes and due dates it finds, then send them to Google Calendar, Outlook, or download a `.ics` file any calendar can import.

Built and tested against real syllabi from four different departments.

## What it pulls out

Exams, midterms and finals; quizzes; homework, problem sets and checkpoint assignments; papers, projects, labs and presentations; and administrative deadlines. For each one it looks for the date, start and end time, and location.

Lecture topics, readings with nothing to submit, office hours, holidays and grading-policy sentences are deliberately left out.

Anything the parser is unsure about is flagged **check this** in the review list. Nothing reaches a calendar without the student looking at it first.

## Run it

```bash
npm install
npm start
```

Open <http://localhost:3000>. That's the whole app — one process serves the front end and the API.

## Deploy it

This needs a Node host, not GitHub Pages (Pages serves static files only and cannot run the parser). Any of these work on a free tier, and all of them deploy straight from a GitHub repo:

- **Render** — New → Web Service → connect the repo. Build `npm install`, start `npm start`.
- **Railway** — New Project → Deploy from GitHub. It detects Node automatically.
- **Fly.io** — `fly launch`, accept the Node defaults.

The app reads `process.env.PORT`, which is what all three set for you. Note the URL it gives you; both calendar providers need it below.

The `.ics` download works the moment it's deployed. The two one-click buttons need the setup below.

## Turning on the Google Calendar button

1. [Google Cloud console](https://console.cloud.google.com/) → create a project.
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **OAuth consent screen** → External. Add the scope `https://www.googleapis.com/auth/calendar.events`. While the app is in *Testing* only accounts listed under **Test users** can sign in — click **Publish app** to open it to everyone.
4. **Credentials → Create credentials → OAuth client ID → Web application**.
5. Under **Authorised JavaScript origins** add your deployed origin (`https://your-app.onrender.com`) and `http://localhost:3000`. Origins only — no path, no trailing slash. This is the step people get wrong.
6. Put the client ID in `public/config.json`.

## Turning on the Outlook button

1. [Azure portal](https://portal.azure.com/) → **Microsoft Entra ID → App registrations → New registration**.
2. Supported account types: choose the option covering **any organizational directory and personal Microsoft accounts**, so both university and personal logins work.
3. Redirect URI: platform **Single-page application**, value = your full page URL *with* the trailing slash (`https://your-app.onrender.com/`). Add `http://localhost:3000/` too. Choosing "Web" instead of "Single-page application" causes a login loop — this is the other step people get wrong.
4. **API permissions → Microsoft Graph → Delegated → Calendars.ReadWrite**.
5. Put the **Application (client) ID** in `public/config.json`.

Neither flow uses a client secret, so there is nothing sensitive to commit.

## Why sign-in is on the front end

For a student this is one button and one popup — the same "Sign in with Google" they have used a hundred times.

Keeping it in the browser is also the safer design. The access token lives in that one tab and expires on its own. The server never sees it, never stores it, and has no session to hijack. Moving OAuth server-side would mean holding refresh tokens for every user, which is a much larger obligation for a tool that only needs to write some events once a semester.

## How parsing works

`src/schedule-parser.js` runs [chrono-node](https://github.com/wanasit/chrono) over each line for the date grammar, then applies the judgement chrono cannot:

- **Which date is the deadline.** `9/10 Marketing Information Ch. 4 Checkpoint HW 1 Due Friday, 9/11 at 11pm` contains two dates. The one after "due" wins, not the row's class date.
- **What the item is called.** Titles come from named anchors (`Checkpoint HW 1`, `Midterm 2`, `PS 3`, `EXAM 1`) rather than by subtracting spans from a table row, which is what produced titles like `Project Management 15 15`.
- **What to ignore.** Grading-policy lines (`25% in-class midterm exam on Oct 7`), make-up policies and relative phrases (`noon the day before`) mention real dates but schedule nothing.
- **Summary sentences.** `There will be two in-class Midterms on Oct 7 and Nov 11, and a Final exam on the week of Dec 14` names three items; pairing all three with one date used to produce a "Final exam" dated Oct 7 that outranked the real December row. Lines naming several deliverables are skipped in favour of the schedule rows.

`src/recurring.js` handles weekly work stated as a rule rather than as dated rows — *"a quiz every week from week 2 thru 15, excluding mid-term weeks"*. It reads the syllabus's own week table, computes the real calendar Friday for each week, and skips the exam weeks. Every generated date comes from the document, not from a guess.

Two extraction details do a lot of the work. PDFs store loose glyph runs, so `src/extract.js` buckets them by vertical position and measures gaps from the *end* of the previous run — measuring from the start splits `9/7` into `9/ 7` and `11/11` into `11/1 1`, which then parse as the wrong dates entirely. DOCX files are converted to HTML first so table rows survive as rows.

## Results on the four test syllabi

| Syllabus | Format | Items found |
|---|---|---|
| BA 301 Finance | DOCX | 14 — 2 midterms, 12 weekly quizzes with 11:59pm deadlines |
| BA 303 Marketing | DOCX | 9 — HW 1–5 with due times, 2 exams with room, final |
| ECON 402 Game Theory | PDF | 9 — PS 1–5, both midterms (one with 3:15–4:15pm), final |
| MGMT 302 Operations | DOCX | 7 — both exams, reflection paper, interview paper |

## Notes and limits

- **Scanned PDFs cannot be read.** There is no text layer to extract. The app says so rather than failing quietly; run the file through OCR or paste the schedule as text.
- **Always check the list.** Syllabi are inconsistent and professors move dates.
- Times are read in the time zone shown in Settings, which defaults to the browser's.
- `.ics` timestamps are written in UTC with DST resolved per date, so events don't drift by an hour across the November and March clock changes.
- Uploaded files are held in memory, parsed, and discarded. Nothing is written to disk and no accounts are stored.

## Layout

```
server.js               Express API + serves the front end
src/extract.js          PDF / DOCX / text -> plain text
src/schedule-parser.js  text -> structured items (chrono-node)
src/recurring.js        weekly rules -> individually dated items
src/ics.js              items -> RFC 5545 .ics
src/tz.js               wall-clock -> UTC, DST-aware
public/index.html       markup
public/styles.css       styling
public/app.js           upload, review list, editing, export
public/calendars.js     Google + Outlook sign-in and event creation
public/shared.js        the parser bits the browser needs
public/config.json      your OAuth client IDs
```

The parser has no browser or server dependencies, so you can exercise it directly:

```bash
node -e "import('./src/schedule-parser.js').then(m => console.log(m.parseSyllabus('Midterm 1: Oct 7 Tu 3:15 PM - 4:15 PM').items))"
```

## Licence

MIT.
