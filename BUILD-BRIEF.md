---
title: trip-form-demo — build brief for a clickable admin prototype
type: build-brief
author: Walter
filed_at: 2026-05-30
status: ready to hand to a coding agent (blank repo)
repo: trip-form-demo
host: GitHub Pages (static, no backend)
related:
  - strategy/dls-role/2026-05-29-trip-absence-app-part1-director-side-design.md
  - news/quintana/2026-05-28-trip-absence-workflow-intake.md
---

# trip-form-demo — build brief

**Audience for this document:** a coding agent (Claude) working against an empty GitHub repo named `trip-form-demo`, connected to GitHub, with no prior context on this project. This brief is self-contained — build from it directly. Ask only if something blocks you.

**What you are building:** a **high-fidelity, front-end-only clickable prototype** of a school "Trip Absence Workflow" app, to be shown to school administrators as a demonstration of the intended experience. It is **not** a production app. Every external dependency is deliberately faked. The point is to demonstrate 100% of the *flow and the screens* while building 0% of the backend.

---

## 1. Hard constraints (do not violate these)

- **No backend of any kind.** No server, no API, no database.
- **No Firestore.** Workflow state lives in browser `localStorage`.
- **No BigQuery.** The student → email/timetable data is a baked-in JSON fixture.
- **No real emails sent.** Emails are *rendered on screen* in an in-app "Outbox," never sent.
- **No real authentication / SSO.** A demo role-switcher stands in for Google sign-in.
- **No real student, teacher, or trip data.** All data is obviously fictional ("Demo Student 03", "Mr Demo Alvarez"). A persistent banner must say the data is fake.
- **Static only.** The entire app must run client-side and be served as static files.

If a feature seems to need a server, it is out of scope — fake it on the client instead.

## 2. Host & stack decision (already made — implement as stated)

- **Host: GitHub Pages.** This is a static client-side app; there is no server-side code, so GitHub Pages is correct and Cloud Run is explicitly *not* used. The app will be fronted by a Cloudflare Worker route on `explainsims.com`, so the mount path is not guaranteed to be the domain root.
- **Therefore: all asset paths must be relative.** If you use Vite, set `base: './'`. This makes the build path-agnostic behind the Worker proxy. Do not hard-code absolute `/assets/...` paths.
- **Stack (recommended): Vite + React + TypeScript**, deployed to Pages via a GitHub Actions workflow (`.github/workflows/deploy.yml` using the official Pages actions). Component structure suits the multi-view design.
  - **Acceptable simpler alternative:** a single self-contained `index.html` (plus a couple of JS/CSS files) with **no build step**, served by Pages from the repo root. This is lower-risk for a live demo and also opens by double-click locally (useful if the demo-room network is unreliable). Your call — but if you choose this, still keep all paths relative.
- **Keep it offline-capable.** No runtime calls to any external service. (Loading a small CSV-parsing library from a CDN at build time is fine; a runtime fetch to a third party is not.)
- Include a short `README.md` explaining it is a fictional-data prototype and how to run/deploy it.

## 3. The design philosophy this prototype must honour

Three governing principles from the design (respect them in how the UI behaves):

1. **The app makes no decisions.** It is a notifier and a recorder, never a gate or an approver. The Director's "approve" only means "this extraction is correct," not "this trip is permitted."
2. **Silence reads as non-compliance.** Statuses default to the *un-actioned* state (e.g. "student never saw me") so that doing nothing is visibly incomplete, not falsely "fine."
3. **The app records; the teacher acts.** The end of the process is a human act: the teacher copies a template and manually logs a PowerSchool entry. **The app never automates the consequence and never writes to any external system.**

## 4. How each faked dependency is implemented

| Real dependency | Faked with |
|---|---|
| Google SSO / real users | A **demo role-switcher** in a top toolbar: *Director · Teacher · Student*. Switching changes the whole view. Also let the presenter pick *which* teacher / student they are "viewing as." |
| BigQuery (ID → email + timetable) | A **baked-in JSON fixture** (see §7). Shape it to the eventual real schema so it doubles as the data contract. |
| Trip sheet in Google Drive | A **CSV file upload, parsed client-side for real** (see §6 Director flow). Provide a sample CSV in the repo. |
| Firestore (snapshot + entries) | **`localStorage`.** Approval freezes the trip snapshot; teacher entries write here; the student view reads here. Provide a **"Reset demo"** control that clears it. |
| Cloud Scheduler (timed triggers) | **Manual "advance the clock" stage buttons** in the demo toolbar (see §5). Each stage fires that stage's emails into the Outbox. |
| Sending email | An in-app **"Outbox"** view. Every send renders a card with to / from / subject / body. Sender identity is a workflow identity, e.g. *"SSIS Trip Absence Workflow &lt;no-reply&gt;"*, never a personal address. |

Plus: a persistent **"PROTOTYPE — all data fictional"** banner across the top, and obviously fictional names throughout.

## 5. The demo toolbar (always visible)

A slim control bar, clearly marked as demo-only, containing:
- **Role switcher:** Director / Teacher / Student, plus a "viewing as" selector for teacher and student.
- **Clock / stage advancer** — the workflow spans weeks; these buttons jump it:
  1. **Approve & freeze** (Director approves the parsed trip)
  2. **Week-out notice** (teachers notified of upcoming absences)
  3. **Morning of departure** (last-call nudge to teachers)
  4. **Day before return** (student reminder of work owed)
  5. **Morning of return** (teacher reminder to sign off)
- A read-out of the current simulated stage.
- **Reset demo** (clears localStorage, returns to the start).

## 6. The three views (screens to build)

### A. Director view
1. **"Sign in"** (fake) → lands scoped to one program (Athletics).
2. **Pick a season** (dropdown) → **pick a trip** from that season.
3. **Upload the trip sheet** (CSV) → the app **parses it client-side** and shows a **structured "approve" screen**: trip name, date range, departure/return times, academic notes, and the roster table (No. / ID / Last / First / Grade). **Flag low-confidence rows** (e.g. `XX` in the No. column, blank IDs, unparsed dates) rather than guessing silently.
4. **Show the computed affected-teacher list at approval** (join each student to their timetable → the set of teacher × class × period combinations the trip will disrupt). Early visibility is the point — let the Director see who's impacted before anything is sent.
5. **Approve = freeze a snapshot** to localStorage (the source of truth from here on; later edits to the source sheet do not leak in).
6. **Pick the trip's designated contact** (the Director or a coach — dropdown).
7. **Send FYI to HS Admin** button → renders an FYI email to the Outbox (informational, **not** an approval gate).
8. **Dashboard tab:** trips grouped **Upcoming** (with a days-countdown) / **In progress** / **Completed**.

### B. Teacher view (scoped to this teacher's own classes only)
- A list of the students affected **in this teacher's classes** for the active trip(s) — not the whole roster.
- **Select a student →** an entry panel with **two separate buckets**:
  - **Contact status:** *saw me / emailed-or-messaged me / never saw me / contacted me from the trip.* **Default = "never saw me"** (silence = non-compliance).
  - **Work:** what work is set / outstanding, free-text plus state.
- **Missed-assessment flag:** a **checkbox "an assessment task was missed during the absence."** When ticked, reveal a **dropdown: Test · Assignment · Presentation · Group Task · Other Task.** This selection drives the student reminder verb later (Test → "sit"; others → "submit/complete") and shows on the student's page.
- **"Copy across my students"** — let the teacher enter once and copy the same work entry to their other affected students (group sizes are usually small and the work is often identical). This is load-bearing, not a nice-to-have.
- **Per-student status** updates (green tick when finalized, amber/red otherwise — see §9).
- **At the bottom of the teacher form: the close-out templates** (see §8) — copy-paste messages for the failure cases, plus on-page instructions for registering a PowerSchool log entry. The app provides the words and the how-to; the teacher does the logging by hand. **Build the copy button; do not build any PowerSchool integration.**

### C. Student view (read-only for the student)
- Personalized page: the trip, the classes/teachers affected, and the **work owed per class** (populated from the teacher entries).
- **First-open acknowledgement pop-up** — the first time the page is opened, a one-tap "I have seen this and understand my responsibilities" acknowledgement (proof of receipt; no data entry).
- **Per-teacher status indicators** (green / amber / red — see §9).
- **Instructions** telling the student to physically go to each teacher and ask them to complete the form. The student **never enters form data.**
- If an assessment was missed: a reminder to **submit/sit it as soon as practical after returning, in negotiation with the teacher** (placeholder timing language — do not invent a hard deadline).

### D. Outbox view
- A chronological list of every email the workflow has "sent," each as a card (to / from / subject / body). This is how the audience sees the notifications without anything being mailed.

## 7. Fixture data (ship these in the repo)

Match these shapes so the mock doubles as the real-integration contract. Use ~8 students, ~5 teachers, a believable timetable, and 1–2 demo trips.

```json
// data/roster.json  (stands in for the BigQuery join)
{
  "teachers": [
    { "id": "T01", "name": "Mr Demo Alvarez", "email": "alvarez@demo.example" }
  ],
  "students": [
    { "id": "S0001", "firstName": "Demo", "lastName": "Student 01", "grade": 9, "email": "s0001@demo.example" }
  ],
  "timetable": [
    { "studentId": "S0001", "day": "Mon", "period": 1, "className": "Algebra I", "teacherId": "T01" }
  ]
}
```

```json
// data/trips.json
{
  "seasons": ["Season 1 (Fall)", "Season 2 (Winter)", "Season 3 (Spring)"],
  "trips": [
    {
      "id": "T24",
      "season": "Season 2 (Winter)",
      "name": "T24 – MRISA Sr Soccer 2026",
      "departure": "2026-02-12T07:00",
      "return":    "2026-02-15T18:00",
      "academicNotes": "No late start permitted Monday.",
      "rosterStudentIds": ["S0001", "S0002", "S0003"]
    }
  ]
}
```

```csv
# data/sample-trip-sheet.csv  (what the Director "uploads"; include a couple of XX / messy rows on purpose)
No,ID,Last name,First name,Grade
1,S0001,Student 01,Demo,9
2,S0002,Student 02,Demo,10
XX,S0003,Student 03,Demo,11
```

**Frozen snapshot (localStorage) shape** — written on approval, then mutated by teacher entries:
```json
{
  "tripId": "T24",
  "frozenAt": "<ISO timestamp>",
  "stage": "approved",
  "designatedContactTeacherId": "T01",
  "entries": [
    {
      "studentId": "S0001",
      "teacherId": "T01",
      "className": "Algebra I",
      "contactStatus": "never_saw_me",
      "work": { "set": "", "outstanding": "" },
      "missedAssessment": { "flag": false, "type": null },
      "completedFormBeforeTrip": false,
      "completedWork": false,
      "assessmentNegotiated": null,
      "finalized": false,
      "updatedAt": null
    }
  ]
}
```

## 8. The close-out templates (teacher view, bottom of form)

Provide copy-paste templates for the failure cases, each with a **Copy** button, plus a short "How to log this in PowerSchool" instruction block. Suggested set:
- **Form not completed before the trip** (student never arranged it pre-departure).
- **Work not completed during/after the absence.**
- **Missed assessment not yet negotiated / not sat.**
- **Combined** (e.g. neither form nor work done).

Each template is a short, professional log-entry message the teacher pastes into PowerSchool. Make the wording neutral and factual. Add a one-line note on the page: *"PowerSchool log entries are the school's official record of student infractions and are always followed up by admin. Logging is done by you, not by this app."*

## 9. Status / visual language

- **Green tick** — finalized / complete for that teacher.
- **Amber** — in progress / awaiting (e.g. contact made but work outstanding).
- **Red** — un-actioned (default state: no contact, nothing logged).
- Apply per student × teacher × class. The student page aggregates per-teacher.
- Keep the visual design clean, credible, and school-appropriate — this is going in front of administrators. Light and dark are nice-to-have, not required.

## 10. The three-question record (what the whole thing is for)

The entire workflow collapses to **three teacher-attestable facts** per student × class. Surface them clearly on the teacher's finalize step and on the student page:
1. **Did the student get the form completed before they left on the trip?**
2. **Did the student complete the work while they were away?**
3. **If an assessment was missed, has the make-up been negotiated between teacher and student?**

The form **does not go anywhere beyond this** — it is a shared teacher/student record, not an admin dashboard. There is no admin completion view by design.

## 11. Email content to render (into the Outbox)

Write believable, concise copy for each, fired by the matching stage button:
- **Week-out teacher notice** — which students, which classes/periods, which dates; students are responsible for coming to see you.
- **Morning-of-departure nudge** — "these students will be absent for the next N days"; functionally a last-call to log entries.
- **Day-before-return student reminder** — the work owed (from teacher entries) + link to their form; show your teacher the work and ask them to finalize; if an assessment was missed, submit/sit it as soon as practical, in negotiation with your teacher. (Use the assessment *type* to pick "sit" vs "submit".)
- **Morning-of-return teacher reminder** — the students who were absent and the work they were set; the student must show you the work and you sign off on the site; please complete the form within three days (a request, not an enforced deadline).
- **Director FYI to HS Admin** — informational notice of the upcoming trip.

## 12. Explicitly out of scope (do not build)

- Real Google sign-in / OAuth.
- Real email sending (SMTP, APIs, mailto-as-send).
- Any database, Firestore, or server.
- Any BigQuery or Drive API connection.
- Any PowerSchool integration or API write.
- Any automated escalation, reminder scheduling beyond the manual stage buttons, or admin oversight dashboard.
- Real persistence beyond `localStorage`.

When in doubt, fake it on the client and keep the screen real.
