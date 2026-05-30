# Trip Absence Workflow — prototype

A **high-fidelity, front-end-only clickable prototype** of a school *Trip
Absence Workflow*, built to demonstrate the intended experience to
administrators. It shows **100% of the flow and screens while building 0% of
the backend** — every external dependency is deliberately faked.

> **PROTOTYPE — all data is fictional.** No backend, no database, no real
> emails, no sign-in, no PowerSchool. Everything runs in your browser and
> nothing leaves it.

---

## What it demonstrates

The workflow that surrounds a school trip's academic absences:

1. **Director** signs in (faked), picks a season + trip, **uploads a trip
   sheet (CSV, parsed in-browser for real)**, sees low-confidence rows
   **flagged rather than guessed**, previews **every affected teacher × class
   × period before anything is sent**, picks a designated contact, and
   **approves — which freezes a snapshot**. Plus a dashboard grouping trips
   into Upcoming / In progress / Completed.
2. **Teacher** (scoped to their own classes) records, per student, a **contact
   status** (default *“never saw me”* — silence reads as non-compliance) and
   the **work set / outstanding**, flags a **missed assessment** (type drives
   the student's reminder verb), uses **“Copy across my students”**, and
   **finalizes the three facts**. Close-out **templates with Copy buttons** and
   PowerSchool logging instructions sit at the bottom.
3. **Student** (read-only) sees their trip, the work owed per class, a
   **first-open acknowledgement**, **per-teacher status** (green / amber /
   red), and instructions to go see each teacher in person.
4. **Outbox** shows every notification the workflow “sent” as on-screen cards —
   nothing is actually emailed.

### Design principles honoured
- **The app makes no decisions** — it notifies and records; “approve” only
  means *“this extraction is correct.”*
- **Silence reads as non-compliance** — statuses default to the un-actioned
  (red) state.
- **The app records; the teacher acts** — close-out is a human PowerSchool log
  entry; the app supplies the words and the how-to, never the integration.

---

## How each dependency is faked

| Real dependency | Faked with |
|---|---|
| Google SSO / users | A demo **role switcher** (Director / Teacher / Student) + “viewing as”. |
| BigQuery (ID → email + timetable) | A baked-in JSON fixture (`data.js` / `data/roster.json`). |
| Trip sheet in Drive | A **real client-side CSV upload** (`FileReader`); sample in `data/sample-trip-sheet.csv`. |
| Firestore | **`localStorage`** — approval freezes the snapshot; a **Reset demo** button clears it. |
| Cloud Scheduler | Manual **stage buttons** in the toolbar; each fires that stage's emails. |
| Sending email | An in-app **Outbox**; sender is a workflow identity, never a person. |

---

## Run it

It is a static site with **no build step**.

```bash
# Option A — just open it
open index.html            # or double-click (works offline; fixtures are embedded)

# Option B — serve it (recommended; enables the Clipboard API on localhost)
python3 -m http.server 8000
# then visit http://localhost:8000/
```

A typical demo path: **Director → Sign in → load the sample sheet → review the
flags → Approve & freeze → step through the toolbar's stage buttons → switch to
Teacher and Student → check the Outbox.** Use **Reset demo** to start over.

## Tests

Open **`tests.html`** (or serve it) to run the bundled unit tests for the CSV
parsing, roster join, affected-teacher computation, and status logic. Results
render on the page and log to the console.

---

## Deploy to GitHub Pages

Hosted on **GitHub Pages** (static; Cloud Run is explicitly not used). A
self-contained workflow (`.github/workflows/deploy.yml`) publishes the repo
root on every push to `main`.

1. Push to GitHub.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions** (one-time).
3. Push to `main` (or run the workflow from the **Actions** tab).
4. Live at `https://<owner>.github.io/<repo>/`.

**All asset and script paths are relative** (`./styles.css`, `./app.js`,
`./data.js`) and the app is **hash/`localStorage`-driven with no server calls**,
so it works unchanged from `file://`, from a project subpath, and **behind the
ExplAIn Sims Cloudflare Worker** (which path-strips the first URL segment).
There are no `fetch`/form-action/`window.location` calls that could leak past
the proxy prefix. A `.nojekyll` file is included.

> Prefer no Actions? Choose **Deploy from a branch** in Pages settings and pick
> the branch root — there is nothing to build.

---

## Project layout

```
index.html        App shell: banner, demo toolbar, view container
styles.css        All styles (light/dark, print)
data.js           Baked-in fictional fixtures (window.FIXTURES)
app.js            Views, CSV parsing, snapshot/state, emails, status logic
tests.html        In-browser unit tests (no dependencies)
data/roster.json        Teacher / student / timetable fixture (the contract)
data/trips.json         Seasons + trips fixture
data/sample-trip-sheet.csv   The sheet the Director "uploads"
.nojekyll               Serve files verbatim on GitHub Pages
.github/workflows/deploy.yml  GitHub Pages deployment
```

The `data/*.json` files mirror `data.js` and are shaped to the eventual real
schema, so the mock doubles as the integration contract. The fixtures are
embedded in `data.js` (rather than fetched) so the prototype runs by
double-click even with no network.

## Explicitly out of scope (not built)

Real Google sign-in/OAuth · real email sending · any database/Firestore/server
· BigQuery/Drive APIs · any PowerSchool integration or write · automated
escalation or scheduling beyond the manual stage buttons · any persistence
beyond `localStorage`.
