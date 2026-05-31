/* =========================================================================
   Trip Absence Workflow — app.js  (vanilla, no build, no backend)

   Everything is faked on the client per the build brief:
     • "BigQuery" join  -> window.FIXTURES (data.js)
     • Drive trip sheet -> a real client-side CSV upload (FileReader)
     • Firestore        -> localStorage snapshot, frozen on approval
     • Cloud Scheduler  -> manual stage buttons in the demo toolbar
     • Email sending    -> an in-app Outbox (cards rendered on screen)
     • Google SSO       -> a demo role switcher

   Pure helpers (CSV parse, roster join, affected-teacher computation,
   status logic) are exposed on window.TAS so tests.html can exercise them
   without a DOM.
   ========================================================================= */
(function () {
  "use strict";

  var FX = (typeof window !== "undefined" && window.FIXTURES) || {};
  var SENDER = "SSIS Trip Absence Workflow <no-reply@demo.example>";
  var HS_ADMIN = "HS Admin Office <hs-admin@demo.example>";
  var STORAGE_KEY = "tas:v1";

  var STAGE_ORDER = ["approved", "week_out", "departure", "day_before_return", "morning_return"];
  var STAGE_LABEL = {
    none: "Not started",
    approved: "Approved & frozen",
    week_out: "Week-out notice sent",
    departure: "Morning of departure",
    day_before_return: "Day before return",
    morning_return: "Morning of return"
  };
  var STAGE_BTN = {
    approved: "Approve & freeze",
    week_out: "Week-out notice",
    departure: "Morning of departure",
    day_before_return: "Day before return",
    morning_return: "Morning of return"
  };
  var CONTACT_OPTIONS = [
    { value: "never_saw_me",   label: "Never saw me",                hint: "Default — silence reads as non-compliance." },
    { value: "saw_me",         label: "Saw me in person",            hint: "Student arranged work face to face." },
    { value: "messaged_me",    label: "Emailed or messaged me",      hint: "Arranged remotely before leaving." },
    { value: "contacted_trip", label: "Contacted me from the trip",  hint: "Reached out while away." }
  ];
  var ASSESSMENT_TYPES = ["Test", "Assignment", "Presentation", "Group Task", "Other Task"];

  /* ---- state + persistence ------------------------------------------- */
  var state = {
    view: "director",
    viewingTeacherId: (FX.teachers && FX.teachers[0] && FX.teachers[0].id) || "",
    viewingStudentId: (FX.students && FX.students[0] && FX.students[0].id) || "",
    director: { signedIn: false, tab: "approve", loadedTripId: "", source: "", parse: null, designatedContactId: "" },
    snapshot: null
  };

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        Object.keys(saved).forEach(function (k) { state[k] = saved[k]; });
      }
    } catch (e) {}
  }
  function resetAll() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    state.view = "director";
    state.director = { signedIn: false, tab: "approve", loadedTripId: "", source: "", parse: null, designatedContactId: "" };
    state.snapshot = null;
  }

  /* ---- tiny DOM + format helpers ------------------------------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function byId(arr, key) {
    var m = {}; (arr || []).forEach(function (o) { m[o[key || "id"]] = o; }); return m;
  }
  var MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  var WD = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  function parseISO(iso) { var d = new Date(iso); return isNaN(d) ? null : d; }
  function fmtDate(iso) {
    var d = parseISO(iso); if (!d) return String(iso || "");
    return WD[d.getDay()] + " " + d.getDate() + " " + MON[d.getMonth()] + " " + d.getFullYear();
  }
  function fmtDateTime(iso) {
    var d = parseISO(iso); if (!d) return String(iso || "");
    var hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0");
    return fmtDate(iso) + ", " + hh + ":" + mm;
  }
  function daysUntil(iso) {
    var d = parseISO(iso); if (!d) return null;
    var a = new Date(); a.setHours(0,0,0,0);
    var b = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.round((b - a) / 86400000);
  }
  function pluralDays(n) { return Math.abs(n) === 1 ? "1 day" : Math.abs(n) + " days"; }

  var toastTimer = null;
  function toast(msg, isError) {
    var t = $("#toast"); if (!t) return;
    t.textContent = msg;
    t.classList.toggle("error", !!isError);
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }

  /* =====================================================================
     PURE LOGIC (testable; also attached to window.TAS at the bottom)
     ===================================================================== */

  // Minimal CSV parse (handles simple quoted fields). Returns header + rows.
  function parseCsv(text) {
    var lines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n")
      .filter(function (l) { return l.trim() !== "" && l.trim().charAt(0) !== "#"; });
    if (!lines.length) return { headers: [], rows: [] };
    var split = function (line) {
      var out = [], cur = "", q = false;
      for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (q) {
          if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (ch === '"') { q = false; }
          else cur += ch;
        } else if (ch === '"') { q = true; }
        else if (ch === ",") { out.push(cur); cur = ""; }
        else cur += ch;
      }
      out.push(cur);
      return out.map(function (s) { return s.trim(); });
    };
    var headers = split(lines[0]);
    var rows = lines.slice(1).map(function (l) { return split(l); });
    return { headers: headers, rows: rows };
  }

  // Map a parsed sheet onto the roster, flagging low-confidence rows rather
  // than guessing. Columns expected: No, ID, Last name, First name, Grade.
  function analyzeSheet(parsed, roster) {
    var idx = byId(roster.students || [], "id");
    var out = (parsed.rows || []).map(function (cells, i) {
      var no = (cells[0] || "").trim();
      var id = (cells[1] || "").trim();
      var last = (cells[2] || "").trim();
      var first = (cells[3] || "").trim();
      var grade = (cells[4] || "").trim();
      var flags = [];
      // A non-numeric "No." (e.g. XX) marks a student who is not travelling.
      var notTravelling = !!no && !/^\d+$/.test(no);
      if (notTravelling) flags.push("Not travelling");
      var student = id ? idx[id] : null;
      if (!notTravelling) {
        if (!no) flags.push("Missing No.");
        if (!id) flags.push("Missing student ID");
        else if (!student) flags.push("ID not found in roster");
        if (student && grade && String(student.grade) !== grade) {
          flags.push("Grade differs from roster (" + student.grade + ")");
        }
      }
      return {
        line: i + 1, no: no, id: id, last: last, first: first, grade: grade,
        matched: !!student && !notTravelling, student: student || null,
        notTravelling: notTravelling, flags: flags
      };
    });
    var matchedIds = out.filter(function (r) { return r.matched; })
      .map(function (r) { return r.id; });
    // de-dup preserve order
    var seen = {}, ids = [];
    matchedIds.forEach(function (id) { if (!seen[id]) { seen[id] = 1; ids.push(id); } });
    return { rows: out, matchedStudentIds: ids,
             flaggedCount: out.filter(function (r) { return r.flags.length; }).length };
  }

  // Weekdays (Mon–Fri) the trip overlaps, inclusive of departure/return days.
  function coveredWeekdays(depISO, retISO) {
    var d = parseISO(depISO), r = parseISO(retISO);
    if (!d || !r) return [];
    var set = {}, order = [];
    var cur = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var end = new Date(r.getFullYear(), r.getMonth(), r.getDate());
    var guard = 0;
    while (cur <= end && guard++ < 60) {
      var wd = WD[cur.getDay()];
      if (wd !== "Sat" && wd !== "Sun" && !set[wd]) { set[wd] = 1; order.push(wd); }
      cur.setDate(cur.getDate() + 1);
    }
    return order;
  }

  // The teacher × class × period × day meetings a trip disrupts.
  function computeMeetings(matchedIds, timetable, weekdays) {
    var ok = {}; matchedIds.forEach(function (id) { ok[id] = 1; });
    var wd = {}; (weekdays || []).forEach(function (d) { wd[d] = 1; });
    return (timetable || []).filter(function (t) { return ok[t.studentId] && wd[t.day]; });
  }

  // Group meetings by teacher (for the Director's affected-teacher view).
  function affectedByTeacher(meetings, roster) {
    var tIdx = byId(roster.teachers || [], "id");
    var groups = {};
    meetings.forEach(function (m) {
      (groups[m.teacherId] = groups[m.teacherId] || []).push(m);
    });
    return Object.keys(groups).map(function (tid) {
      var byClass = {};
      groups[tid].forEach(function (m) {
        var key = m.className + "|" + m.period + "|" + m.day;
        (byClass[key] = byClass[key] || { className: m.className, period: m.period, day: m.day, studentIds: [] })
          .studentIds.push(m.studentId);
      });
      return { teacherId: tid, teacher: tIdx[tid] || { id: tid, name: tid },
               classes: Object.keys(byClass).map(function (k) { return byClass[k]; }) };
    }).sort(function (a, b) { return a.teacherId < b.teacherId ? -1 : 1; });
  }

  // One trackable entry per student × teacher × class.
  function buildEntries(meetings) {
    var seen = {}, entries = [];
    meetings.forEach(function (m) {
      var key = m.studentId + "|" + m.teacherId + "|" + m.className;
      if (seen[key]) return;
      seen[key] = 1;
      entries.push({
        studentId: m.studentId, teacherId: m.teacherId, className: m.className,
        contactStatus: "never_saw_me",
        work: { set: "", outstanding: "" },
        missedAssessment: { flag: false, type: null },
        completedFormBeforeTrip: false,
        completedWork: false,
        assessmentNegotiated: null,
        finalized: false,
        updatedAt: null
      });
    });
    return entries;
  }

  function statusOf(e) {
    if (!e) return "red";
    if (e.finalized) return "green";
    var touched = e.contactStatus !== "never_saw_me" ||
      (e.work && (e.work.set || e.work.outstanding)) ||
      e.completedFormBeforeTrip || e.completedWork ||
      (e.missedAssessment && e.missedAssessment.flag && e.assessmentNegotiated === true);
    return touched ? "amber" : "red";
  }
  function statusLabel(s) { return s === "green" ? "Finalized" : s === "amber" ? "In progress" : "Not actioned"; }
  function assessmentVerb(type) { return type === "Test" ? "sit" : "submit"; }

  /* =====================================================================
     SNAPSHOT + WORKFLOW ACTIONS
     ===================================================================== */
  function snap() { return state.snapshot; }
  var tIdx = function () { return byId(FX.teachers || [], "id"); };
  var sIdx = function () { return byId(FX.students || [], "id"); };

  function findEntry(sid, tid, className) {
    var s = snap(); if (!s) return null;
    for (var i = 0; i < s.entries.length; i++) {
      var e = s.entries[i];
      if (e.studentId === sid && e.teacherId === tid && e.className === className) return e;
    }
    return null;
  }
  function uniq(arr) { var seen = {}, out = []; arr.forEach(function (x) { if (!seen[x]) { seen[x] = 1; out.push(x); } }); return out; }
  function teacherIdsWithEntries() { var s = snap(); return s ? uniq(s.entries.map(function (e) { return e.teacherId; })).sort() : []; }
  function studentIdsWithEntries() { var s = snap(); return s ? uniq(s.entries.map(function (e) { return e.studentId; })).sort() : []; }
  function entriesForTeacher(tid) { var s = snap(); return s ? s.entries.filter(function (e) { return e.teacherId === tid; }) : []; }
  function entriesForStudent(sid) { var s = snap(); return s ? s.entries.filter(function (e) { return e.studentId === sid; }) : []; }
  function studentName(sid) { var s = sIdx()[sid]; return s ? (s.firstName + " " + s.lastName) : sid; }
  function teacherName(tid) { var t = tIdx()[tid]; return t ? t.name : tid; }

  // Worst (most un-actioned) status across a set of entries.
  function aggregateStatus(entries) {
    if (!entries.length) return "neutral";
    var hasRed = false, allGreen = true;
    entries.forEach(function (e) { var st = statusOf(e); if (st === "red") hasRed = true; if (st !== "green") allGreen = false; });
    return allGreen ? "green" : (hasRed ? "red" : "amber");
  }

  function approve() {
    var d = state.director;
    if (!d.parse || !d.parse.matchedStudentIds.length) { toast("Load a trip sheet first.", true); return false; }
    var trip = (FX.trips || []).filter(function (t) { return t.id === d.loadedTripId; })[0];
    if (!trip) { toast("Load a trip sheet first.", true); return false; }
    var weekdays = coveredWeekdays(trip.departure, trip.return);
    var meetings = computeMeetings(d.parse.matchedStudentIds, FX.timetable, weekdays);
    state.snapshot = {
      tripId: trip.id, tripName: trip.name, program: trip.program || "Athletics",
      departure: trip.departure, return: trip.return, academicNotes: trip.academicNotes || "",
      weekdays: weekdays,
      frozenAt: new Date().toISOString(),
      stage: "approved",
      designatedContactTeacherId: d.designatedContactId || "",
      entries: buildEntries(meetings),
      acks: {}, outbox: [], firedStages: []
    };
    save();
    return true;
  }

  function pushEmail(stage, to, subject, body) {
    var s = snap(); if (!s) return;
    s.outbox.push({
      id: "e" + (s.outbox.length + 1) + "-" + Date.now(),
      ts: new Date().toISOString(), stage: stage,
      from: SENDER, to: to, subject: subject, body: body
    });
  }
  function alreadyFired(stage) { var s = snap(); return s && s.firedStages.indexOf(stage) !== -1; }
  function markFired(stage) { var s = snap(); if (s && s.firedStages.indexOf(stage) === -1) s.firedStages.push(stage); s.stage = stage; }

  function tripDatesLine() { var s = snap(); return fmtDate(s.departure) + " – " + fmtDate(s.return); }

  function classLineForTeacher(tid) {
    // "Algebra I: Demo Student 01, Demo Student 02"
    var s = snap();
    var by = {};
    s.entries.filter(function (e) { return e.teacherId === tid; }).forEach(function (e) {
      (by[e.className] = by[e.className] || []).push(studentName(e.studentId));
    });
    return Object.keys(by).map(function (c) { return "  • " + c + ": " + by[c].join(", "); }).join("\n");
  }

  function fireWeekOut() {
    if (alreadyFired("week_out")) { toast("Week-out notices already sent."); return; }
    var s = snap();
    teacherIdsWithEntries().forEach(function (tid) {
      var t = tIdx()[tid];
      var body =
        "Hello " + (t ? t.name : tid) + ",\n\n" +
        "The following students in your classes will be away on " + s.tripName +
        " (" + tripDatesLine() + "):\n\n" + classLineForTeacher(tid) + "\n\n" +
        "Students are responsible for coming to see you before they leave to arrange the work they will miss. " +
        "Please log what you set for each student in the Trip Absence Workflow when they do.\n\n— " + SENDER;
      pushEmail("week_out", (t ? t.email : tid), "Upcoming absences: " + s.tripName, body);
    });
    markFired("week_out"); save();
    toast("Week-out notices sent to the Outbox.");
  }

  function fireDeparture() {
    if (alreadyFired("departure")) { toast("Departure nudges already sent."); return; }
    var s = snap();
    var n = Math.max(1, (daysUntil(s.return) - daysUntil(s.departure)) + 1);
    teacherIdsWithEntries().forEach(function (tid) {
      var t = tIdx()[tid];
      var body =
        "Hello " + (t ? t.name : tid) + ",\n\n" +
        "These students leave today on " + s.tripName + " and will be absent for the next " + n + " school day(s):\n\n" +
        classLineForTeacher(tid) + "\n\n" +
        "Last call to record the work you have set for them. Silence is treated as non-compliance, so please log even “no work set”.\n\n— " + SENDER;
      pushEmail("departure", (t ? t.email : tid), "Leaving today: " + s.tripName, body);
    });
    markFired("departure"); save();
    toast("Departure nudges sent to the Outbox.");
  }

  function fireDayBeforeReturn() {
    if (alreadyFired("day_before_return")) { toast("Student reminders already sent."); return; }
    var s = snap();
    studentIdsWithEntries().forEach(function (sid) {
      var stu = sIdx()[sid];
      var lines = entriesForStudent(sid).map(function (e) {
        var work = (e.work && (e.work.outstanding || e.work.set)) ? (e.work.outstanding || e.work.set) : "to be confirmed with your teacher";
        var extra = "";
        if (e.missedAssessment && e.missedAssessment.flag) {
          extra = " — a " + (e.missedAssessment.type || "task") + " was missed; please " +
            assessmentVerb(e.missedAssessment.type) + " it as soon as practical after you return, in negotiation with your teacher.";
        }
        return "  • " + e.className + " (" + teacherName(e.teacherId) + "): " + work + extra;
      }).join("\n");
      var body =
        "Hi " + (stu ? stu.firstName + " " + stu.lastName : sid) + ",\n\n" +
        "You return tomorrow from " + s.tripName + ". Here is the work owed per class:\n\n" + lines + "\n\n" +
        "Open your personal page (Student view) to see the latest. Go to each teacher, show them the work, and ask them to finalize your record.\n\n— " + SENDER;
      pushEmail("day_before_return", (stu ? stu.email : sid), "Work owed for " + s.tripName, body);
    });
    markFired("day_before_return"); save();
    toast("Student reminders sent to the Outbox.");
  }

  function fireMorningReturn() {
    if (alreadyFired("morning_return")) { toast("Return reminders already sent."); return; }
    var s = snap();
    teacherIdsWithEntries().forEach(function (tid) {
      var t = tIdx()[tid];
      var lines = entriesForTeacher(tid).map(function (e) {
        var work = (e.work && (e.work.set || e.work.outstanding)) || "(no work recorded yet)";
        return "  • " + studentName(e.studentId) + " — " + e.className + ": " + work;
      }).join("\n");
      var body =
        "Hello " + (t ? t.name : tid) + ",\n\n" +
        "These students have returned from " + s.tripName + ". The work you set was:\n\n" + lines + "\n\n" +
        "Each student should show you the completed work; please sign off on their record in the Trip Absence Workflow. " +
        "We ask that you complete this within three days (a request, not an enforced deadline).\n\n— " + SENDER;
      pushEmail("morning_return", (t ? t.email : tid), "Sign-off needed: " + s.tripName, body);
    });
    markFired("morning_return"); save();
    toast("Return reminders sent to the Outbox.");
  }

  function fireFyi() {
    var s = snap(); if (!s) { toast("Approve a trip first.", true); return; }
    var contact = s.designatedContactTeacherId ? teacherName(s.designatedContactTeacherId) : "the trip's designated contact";
    var body =
      "Hello HS Admin,\n\n" +
      "For your information: " + s.tripName + " (" + s.program + ") runs " + tripDatesLine() + ". " +
      "Departure " + fmtDateTime(s.departure) + "; return " + fmtDateTime(s.return) + ".\n" +
      (s.academicNotes ? "Academic notes: " + s.academicNotes + "\n" : "") +
      "Designated contact: " + contact + ". " + studentIdsWithEntries().length + " students affected across " +
      teacherIdsWithEntries().length + " teachers.\n\n" +
      "This is an informational notice only — not an approval request.\n\n— " + SENDER;
    pushEmail("approved", HS_ADMIN, "FYI — upcoming trip: " + s.tripName, body);
    save();
    toast("FYI sent to HS Admin (see Outbox).");
  }

  /* =====================================================================
     UI INFRASTRUCTURE
     ===================================================================== */
  function copyText(text) {
    var done = function (ok) { toast(ok ? "Copied to clipboard" : "Copy failed — select the text manually.", !ok); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { legacy(); });
    } else { legacy(); }
    function legacy() {
      try {
        var ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(ta); done(ok);
      } catch (e) { done(false); }
    }
  }

  function closeModal() { var r = $("#modal-root"); if (r) r.innerHTML = ""; }
  function openModal(html) {
    var r = $("#modal-root");
    r.innerHTML = '<div class="modal-overlay" data-overlay><div class="modal" role="dialog" aria-modal="true">' + html + "</div></div>";
    var first = r.querySelector("button, [tabindex], input, select, textarea");
    if (first) first.focus();
  }

  function setView(v) { state.view = v; save(); render(); }

  function renderToolbar() {
    $$("#view-seg .seg__btn").forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-view") === state.view ? "true" : "false");
    });

    // Viewing-as selector (teachers for Teacher view, students for Student view)
    var grp = $("#viewing-as-group"), sel = $("#viewing-as");
    if (state.view === "teacher" || state.view === "student") {
      grp.hidden = false;
      var list = state.view === "teacher" ? (FX.teachers || []) : (FX.students || []);
      var cur = state.view === "teacher" ? state.viewingTeacherId : state.viewingStudentId;
      sel.innerHTML = list.map(function (o) {
        var label = state.view === "teacher" ? o.name : (o.firstName + " " + o.lastName + " (" + o.grade + ")");
        return '<option value="' + esc(o.id) + '"' + (o.id === cur ? " selected" : "") + ">" + esc(label) + "</option>";
      }).join("");
    } else {
      grp.hidden = true;
    }

    // Stage buttons
    var s = snap();
    var readyToApprove = !!(state.director.parse && state.director.parse.matchedStudentIds.length);
    var btns = STAGE_ORDER.map(function (stage) {
      var fired = stage === "approved" ? !!s : (s && s.firedStages.indexOf(stage) !== -1);
      var enabled;
      if (stage === "approved") enabled = !s && readyToApprove;
      else enabled = !!s && !fired;
      return '<button type="button" class="btn btn--stage" data-stage="' + stage + '"' +
        ' data-fired="' + (fired ? "true" : "false") + '"' + (enabled ? "" : " disabled") + '>' +
        (fired ? "✓ " : "") + esc(STAGE_BTN[stage]) + "</button>";
    }).join("");
    $("#stage-buttons").innerHTML = btns;
    $("#stage-readout").textContent = s ? STAGE_LABEL[s.stage] : STAGE_LABEL.none;
  }

  function render() {
    renderToolbar();
    var host = $("#view");
    var html;
    if (state.view === "director") html = renderDirector();
    else if (state.view === "teacher") html = renderTeacher();
    else if (state.view === "student") html = renderStudent();
    else html = renderOutbox();
    host.innerHTML = html;
    if (state.view === "director") afterDirector();
    if (state.view === "student") afterStudent();
  }

  /* =====================================================================
     DIRECTOR VIEW
     ===================================================================== */
  function rosterTableHtml(parse) {
    if (!parse) return "";
    var rows = parse.rows.map(function (r) {
      var rowCls = r.notTravelling ? "not-travelling" : (r.flags.length ? "flagged" : "");
      var flagCell = r.flags.length
        ? '<span class="cell-flag">⚠ ' + esc(r.flags.join("; ")) + "</span>"
        : '<span class="pill pill--green"><span class="dot"></span>OK</span>';
      return '<tr class="' + rowCls + '">' +
        '<td class="num">' + esc(r.no) + "</td><td>" + esc(r.id || "—") + "</td>" +
        "<td>" + esc(r.last) + "</td><td>" + esc(r.first) + "</td>" +
        "<td>" + esc(r.grade) + "</td><td>" + flagCell + "</td></tr>";
    }).join("");
    return '<div class="table-wrap"><table><thead><tr>' +
      "<th>No.</th><th>ID</th><th>Last</th><th>First</th><th>Grade</th><th>Confirmed</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
      '<p class="sheet-reload">Make any required changes on original Google Sheet and reload to confirm</p>';
  }

  // Trip details prepopulated from the loaded sheet, shown above the roster.
  function tripSummaryHtml(trip) {
    if (!trip) return "";
    return '<div class="trip-summary">' +
      '<div class="trip-summary__name">' + esc(trip.name) + "</div>" +
      '<div class="trip-summary__meta">' + esc(trip.program || "Athletics") + " · " + esc(trip.season) + "</div>" +
      '<dl class="kv">' +
      "<div><dt>Departs</dt><dd>" + fmtDateTime(trip.departure) + "</dd></div>" +
      "<div><dt>Returns</dt><dd>" + fmtDateTime(trip.return) + "</dd></div>" +
      "<div><dt>Academic notes</dt><dd>" + esc(trip.academicNotes || "—") + "</dd></div>" +
      "<div><dt>Roster on sheet</dt><dd>" + trip.rosterStudentIds.length + " students</dd></div>" +
      "</dl></div>";
  }

  function affectedHtml(parse, trip) {
    if (!parse || !trip) return '<p class="muted">Load a trip sheet to see who is impacted.</p>';
    var weekdays = coveredWeekdays(trip.departure, trip.return);
    var meetings = computeMeetings(parse.matchedStudentIds, FX.timetable, weekdays);
    var groups = affectedByTeacher(meetings, FX);
    if (!groups.length) return '<p class="muted">No timetable clashes found for the matched students on ' + esc(weekdays.join(", ")) + ".</p>";
    var body = groups.map(function (g) {
      var items = g.classes.map(function (c) {
        return "<li><b>" + esc(c.className) + "</b> (" + esc(c.day) + " P" + esc(c.period) + ") — " +
          c.studentIds.map(studentName).map(esc).join(", ") + "</li>";
      }).join("");
      return '<div class="affected-group"><h4>' + esc(g.teacher.name) +
        ' <span class="chip">' + g.classes.length + " class(es)</span></h4><ul>" + items + "</ul></div>";
    }).join("");
    return body;
  }

  function dashboardHtml() {
    var groups = { Upcoming: [], "In progress": [], Completed: [] };
    (FX.trips || []).forEach(function (t) {
      var dDep = daysUntil(t.departure), dRet = daysUntil(t.return);
      var bucket = dDep > 0 ? "Upcoming" : (dRet >= 0 ? "In progress" : "Completed");
      groups[bucket].push({ trip: t, dDep: dDep });
    });
    var approvedId = snap() ? snap().tripId : null;
    return Object.keys(groups).map(function (name) {
      var items = groups[name];
      var cards = items.length ? items.map(function (o) {
        var t = o.trip;
        var meta = name === "Upcoming"
          ? '<span class="countdown">' + (o.dDep === 0 ? "today" : "in " + pluralDays(o.dDep)) + "</span>"
          : '<span class="muted">' + fmtDate(t.departure) + "</span>";
        var pill = t.id === approvedId ? '<span class="pill pill--green"><span class="dot"></span>Approved &amp; frozen</span>' : '<span class="chip">' + esc(t.season) + "</span>";
        return '<div class="card dash-card"><div class="grow"><strong>' + esc(t.name) + "</strong><br>" +
          '<span class="muted">' + fmtDate(t.departure) + " – " + fmtDate(t.return) + " · " + t.rosterStudentIds.length + " students</span></div>" +
          "<div>" + meta + "</div><div>" + pill + "</div></div>";
      }).join("") : '<p class="muted" style="padding:4px 2px">None.</p>';
      return '<div class="dash-group"><h3>' + name + "</h3>" + cards + "</div>";
    }).join("");
  }

  // A small inline Google Drive glyph (decorative; the button is non-functional).
  var DRIVE_SVG = '<svg viewBox="0 0 87.3 78" aria-hidden="true">' +
    '<path d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8H0c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/>' +
    '<path d="M43.65 25L29.9 1.2c-1.35.8-2.5 1.9-3.3 3.3L1.2 48.5C.4 49.9 0 51.45 0 53h27.5z" fill="#00ac47"/>' +
    '<path d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5H59.8l5.85 11.5z" fill="#ea4335"/>' +
    '<path d="M43.65 25L57.4 1.2C56.05.4 54.5 0 52.9 0H34.4c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/>' +
    '<path d="M59.8 53H27.5L13.75 76.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/>' +
    '<path d="M73.4 26.5L60.65 4.5c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25 59.8 53h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/></svg>';

  function renderDirector() {
    if (!state.director.signedIn) {
      return '<div class="view-head"><h1>Director</h1><p>Athletics program · trip approvals</p></div>' +
        '<div class="card"><div class="card__head"><div class="card__title">Sign in</div>' +
        '<p class="card__sub">Stands in for Google sign-in — no real account is used.</p></div>' +
        '<div class="card__body"><button type="button" class="btn btn--primary" data-action="dir-signin">Sign in as Athletics Director</button></div></div>';
    }

    var d = state.director;
    var tab = d.tab || "approve";
    var head = '<div class="view-head"><h1>Director</h1><p>Signed in · scoped to the <b>Athletics</b> program</p></div>' +
      '<div class="tabs" role="group" aria-label="Director tabs">' +
      '<button type="button" class="tabs__btn" data-action="dir-tab" data-tab="approve" aria-pressed="' + (tab === "approve") + '">Approve a trip</button>' +
      '<button type="button" class="tabs__btn" data-action="dir-tab" data-tab="dashboard" aria-pressed="' + (tab === "dashboard") + '">Dashboard</button></div>';

    if (tab === "dashboard") return head + dashboardHtml();
    return head + approveTabHtml();
  }
  function afterDirector() {}

  // ----- Director side rail (Drive source picker, contact, approve) -----
  function sourcePickerCard() {
    var d = state.director;
    var loaded = !!d.parse;
    return '<div class="card"><div class="card__head"><div class="card__title">Trip sheet source</div>' +
      '<p class="card__sub">Select the trip sheet stored in the program&#39;s Drive folder.</p></div>' +
      '<div class="card__body"><div class="source">' +
      '<button type="button" class="source__btn" data-action="drive-open" disabled aria-disabled="true">' +
      '<span class="source__icon">' + DRIVE_SVG + "</span>" +
      '<span class="source__main"><span class="source__title">Browse Google Drive</span>' +
      '<span class="source__desc">Athletics › Trip sheets</span></span>' +
      '<span class="source__hint">demo</span></button>' +
      '<button type="button" class="source__btn" data-action="load-sample">' +
      '<span class="source__icon">📄</span>' +
      '<span class="source__main"><span class="source__title">' + (loaded ? "Reload sample trip sheet" : "Load sample trip sheet") + "</span>" +
      '<span class="source__desc">T24 – MRISA Sr Soccer 2026</span></span>' +
      "</button></div>" +
      '<p class="help">Drive browsing is stubbed for this demo — use the sample sheet, which loads exactly as a real selection would.</p>' +
      "</div></div>";
  }

  function contactApproveCard() {
    var d = state.director;
    var ready = !!(d.parse && d.parse.matchedStudentIds.length);
    var contactOpts = '<option value="">Director (you)</option>' + (FX.teachers || []).map(function (t) {
      return '<option value="' + esc(t.id) + '"' + (t.id === d.designatedContactId ? " selected" : "") + ">" + esc(t.name) + " (coach)</option>";
    }).join("");
    return '<div class="card"><div class="card__head"><div class="card__title">Designated contact &amp; approval</div></div>' +
      '<div class="card__body">' +
      '<label class="field-label" for="dir-contact">Designated contact for this trip</label>' +
      '<select class="select" id="dir-contact" data-action="dir-contact">' + contactOpts + "</select>" +
      '<p class="help">The Director or a coach travelling with the team.</p>' +
      '<div class="note-box" style="margin-top:14px">Approving means <b>“this extraction is correct.”</b> It is not permission for the trip — the app makes no decisions; it freezes a snapshot and begins notifying people.</div>' +
      '<button type="button" class="btn btn--primary btn--block" data-action="approve" style="margin-top:14px"' + (ready ? "" : " disabled") + ">Approve &amp; freeze snapshot</button>" +
      (ready ? "" : '<p class="help" style="text-align:center">Load a trip sheet to enable approval.</p>') +
      "</div></div>";
  }

  function frozenCard() {
    var s = snap(); if (!s) return "";
    return '<div class="card"><div class="card__head"><div class="card__title">' +
      '<span class="pill pill--green"><span class="dot"></span>Approved &amp; frozen</span></div>' +
      '<p class="card__sub">Frozen ' + fmtDateTime(s.frozenAt) + " — the source of truth from here on.</p></div>" +
      '<div class="card__body"><dl class="kv">' +
      "<div><dt>Students affected</dt><dd>" + studentIdsWithEntries().length + "</dd></div>" +
      "<div><dt>Teachers affected</dt><dd>" + teacherIdsWithEntries().length + "</dd></div>" +
      "<div><dt>Designated contact</dt><dd>" + esc(s.designatedContactTeacherId ? teacherName(s.designatedContactTeacherId) : "Director (you)") + "</dd></div>" +
      '</dl><button type="button" class="btn btn--block" data-action="fyi" style="margin-top:14px">Send FYI to HS Admin</button>' +
      '<button type="button" class="btn btn--block" data-action="goto" data-view="teacher" style="margin-top:8px">Open Teacher view</button>' +
      "</div></div>";
  }

  // ----- Director main column: the trip sheet is the primary view -----
  function sheetCard() {
    var d = state.director;
    var trip = (FX.trips || []).filter(function (t) { return t.id === d.loadedTripId; })[0] || null;
    if (!d.parse) {
      return '<div class="card"><div class="card__head"><div class="card__title">Trip sheet</div>' +
        '<p class="card__sub">No sheet loaded yet.</p></div>' +
        '<div class="card__body"><div class="empty"><h3>Load a trip sheet to begin</h3>' +
        "<p>Use the <b>Trip sheet source</b> panel to load the sheet from Drive. " +
        "It is parsed in your browser; low-confidence rows are flagged, never guessed.</p></div></div></div>";
    }
    return '<div class="card"><div class="card__head"><div class="card__title">' +
      '<span class="eyebrow">Trip sheet</span></div>' +
      '<p class="card__sub">Trip details and roster extracted from loaded sheet.</p></div>' +
      '<div class="card__body">' + tripSummaryHtml(trip) + rosterTableHtml(d.parse) + "</div></div>";
  }

  function approveTabHtml() {
    var d = state.director;
    var trip = (FX.trips || []).filter(function (t) { return t.id === d.loadedTripId; })[0] || null;

    var main =
      sheetCard() +
      '<div class="card"><div class="card__head"><div class="card__title">Impacted classes</div></div>' +
      '<div class="card__body">' + affectedHtml(d.parse, trip) + "</div></div>";

    var side = (snap() ? frozenCard() : "") + sourcePickerCard() + contactApproveCard();

    return '<div class="dir-grid"><div class="stack">' + main + "</div>" +
      '<aside class="dir-side">' + side + "</aside></div>";
  }

  /* =====================================================================
     TEACHER VIEW  (scoped to the selected teacher's own classes)
     ===================================================================== */
  function entryKey(e) { return e.studentId + "|" + e.teacherId + "|" + e.className; }
  function findEntryByKey(key) {
    var p = key.split("|"); return findEntry(p[0], p[1], p.slice(2).join("|"));
  }
  function studentAggForTeacher(sid, tid) {
    return aggregateStatus(entriesForTeacher(tid).filter(function (e) { return e.studentId === sid; }));
  }
  function pillHtml(status) {
    var lbl = status === "neutral" ? "—" : statusLabel(status);
    var cls = status === "neutral" ? "pill--neutral" : "pill--" + status;
    return '<span class="pill ' + cls + '"><span class="dot"></span>' + esc(lbl) + "</span>";
  }

  function renderTeacher() {
    var tid = state.viewingTeacherId;
    var s = snap();
    var head = '<div class="view-head"><h1>Teacher · ' + esc(teacherName(tid)) + "</h1>" +
      "<p>" + (s ? "Your students on <b>" + esc(s.tripName) + "</b> — only the classes you teach." : "Trip absences for your classes.") + "</p></div>";
    if (!s) {
      return head + '<div class="empty"><h3>No approved trip yet</h3><p>Ask the Director to approve a trip, then your affected students will appear here.</p>' +
        '<p><button type="button" class="btn" data-action="goto" data-view="director">Go to Director view</button></p></div>';
    }

    var sids = uniq(entriesForTeacher(tid).map(function (e) { return e.studentId; }));
    if (!sids.length) {
      return head + '<div class="empty"><h3>No affected students</h3><p>None of your classes are disrupted by ' + esc(s.tripName) + ".</p></div>";
    }

    // ensure a valid selection
    if (sids.indexOf(state.teacherSelectedStudent) === -1) state.teacherSelectedStudent = sids[0];
    var sel = state.teacherSelectedStudent;

    var list = sids.map(function (sid) {
      var stu = sIdx()[sid];
      return '<button type="button" class="list__item" data-action="teacher-select" data-sid="' + esc(sid) +
        '" aria-current="' + (sid === sel ? "true" : "false") + '">' +
        '<span class="grow"><b>' + esc(studentName(sid)) + "</b><br><small>Grade " + esc(stu ? stu.grade : "?") + " · " + esc(sid) + "</small></span>" +
        pillHtml(studentAggForTeacher(sid, tid)) + "</button>";
    }).join("");

    var left = '<div class="card"><div class="card__head"><div class="card__title">Affected students <span class="chip">' + sids.length + "</span></div>" +
      '<p class="card__sub">Default status is <b>“Not actioned”</b> — silence reads as non-compliance.</p></div>' +
      '<div class="card__body list">' + list + "</div></div>";

    var right = teacherEntryPanel(sel, tid) + closeoutTemplatesHtml(sel);
    return head + '<div class="split"><div>' + left + "</div><div class=\"stack\">" + right + "</div></div>";
  }

  function ynBtn(key, q, current, yn) {
    var pressed = (yn === "yes" && current === true) || (yn === "no" && current === false);
    return '<button type="button" class="btn btn--sm" data-action="set-q" data-key="' + esc(key) +
      '" data-q="' + q + '" data-yn="' + yn + '" aria-pressed="' + (pressed ? "true" : "false") + '">' +
      (yn === "yes" ? "Yes" : "No") + "</button>";
  }

  function classBlock(e) {
    var key = entryKey(e);
    var contact = CONTACT_OPTIONS.map(function (o) {
      return '<label class="opt"><input type="radio" name="contact-' + esc(key) + '" data-action="set-contact" data-key="' +
        esc(key) + '" value="' + o.value + '"' + (e.contactStatus === o.value ? " checked" : "") + ">" +
        '<span><span class="opt__text">' + esc(o.label) + '</span><span class="opt__hint">' + esc(o.hint) + "</span></span></label>";
    }).join("");

    var assessment =
      '<label class="opt"><input type="checkbox" data-action="toggle-missed" data-key="' + esc(key) + '"' +
      (e.missedAssessment.flag ? " checked" : "") + '><span class="opt__text">An assessment task was missed during the absence</span></label>' +
      (e.missedAssessment.flag ?
        '<label class="field-label" for="atype-' + esc(key) + '" style="margin-top:6px">Assessment type</label>' +
        '<select class="select" id="atype-' + esc(key) + '" data-action="set-atype" data-key="' + esc(key) + '">' +
        ASSESSMENT_TYPES.map(function (t) { return '<option' + (e.missedAssessment.type === t ? " selected" : "") + ">" + esc(t) + "</option>"; }).join("") +
        '</select><p class="help">Drives the student reminder verb: a Test → “sit”; everything else → “submit/complete”.</p>' : "");

    var threeQ =
      '<fieldset style="margin-top:12px"><legend>Finalize record — the three facts</legend><div class="three-q">' +
      '<div class="q"><span>1. Form completed <b>before</b> the trip?</span><span class="yn">' + ynBtn(key, "form", e.completedFormBeforeTrip, "yes") + ynBtn(key, "form", e.completedFormBeforeTrip, "no") + "</span></div>" +
      '<div class="q"><span>2. Work completed <b>while away</b>?</span><span class="yn">' + ynBtn(key, "work", e.completedWork, "yes") + ynBtn(key, "work", e.completedWork, "no") + "</span></div>" +
      (e.missedAssessment.flag ? '<div class="q"><span>3. Make-up <b>negotiated</b> for the missed ' + esc(e.missedAssessment.type || "task") + "?</span><span class=\"yn\">" + ynBtn(key, "neg", e.assessmentNegotiated, "yes") + ynBtn(key, "neg", e.assessmentNegotiated, "no") + "</span></div>" : "") +
      "</div></fieldset>";

    var finalizeRow = '<div class="row" style="margin-top:12px;justify-content:space-between">' +
      "<div>" + pillHtml(statusOf(e)) + "</div><div class=\"row\">" +
      '<button type="button" class="btn btn--sm" data-action="copy-across" data-key="' + esc(key) + '">Copy across my students</button>' +
      (e.finalized
        ? '<button type="button" class="btn btn--sm" data-action="unfinalize" data-key="' + esc(key) + '">Reopen</button>'
        : '<button type="button" class="btn btn--sm btn--primary" data-action="finalize" data-key="' + esc(key) + '">Finalize</button>') +
      "</div></div>";

    return '<fieldset><legend>' + esc(e.className) + '</legend>' +
      '<div class="field-label">Contact status</div>' + contact +
      '<label class="field-label" for="wset-' + esc(key) + '" style="margin-top:10px">Work set</label>' +
      '<textarea id="wset-' + esc(key) + '" data-action="set-work" data-key="' + esc(key) + '" data-field="set" placeholder="What you set for this student…">' + esc(e.work.set) + "</textarea>" +
      '<label class="field-label" for="wout-' + esc(key) + '" style="margin-top:8px">Still outstanding</label>' +
      '<textarea id="wout-' + esc(key) + '" data-action="set-work" data-key="' + esc(key) + '" data-field="outstanding" placeholder="What is still owed…">' + esc(e.work.outstanding) + "</textarea>" +
      '<div style="margin-top:10px">' + assessment + "</div>" + threeQ + finalizeRow + "</fieldset>";
  }

  function teacherEntryPanel(sid, tid) {
    var entries = entriesForTeacher(tid).filter(function (e) { return e.studentId === sid; });
    var blocks = entries.map(classBlock).join('<div style="height:12px"></div>');
    return '<div class="card"><div class="card__head"><div class="card__title">' + esc(studentName(sid)) + "</div>" +
      '<p class="card__sub">Two buckets: how they contacted you, and the work. Enter once, then “Copy across my students” for the rest of the group.</p></div>' +
      '<div class="card__body">' + blocks + "</div></div>";
  }

  var _templates = [];
  function buildTemplates(sid) {
    var s = snap();
    var name = sid ? studentName(sid) : "[student]";
    var trip = s ? s.tripName : "[trip]";
    var dates = s ? (fmtDate(s.departure) + " – " + fmtDate(s.return)) : "[dates]";
    var who = teacherName(state.viewingTeacherId);
    return [
      { key: "form", title: "Form not completed before the trip",
        text: "Trip Absence — " + trip + " (" + dates + ").\n" + name + " did not complete the pre-trip work-arrangement form before departure. Expectation: students arrange missed work with each teacher prior to leaving. Logged by " + who + "." },
      { key: "work", title: "Work not completed during / after the absence",
        text: "Trip Absence — " + trip + " (" + dates + ").\n" + name + " did not complete the work set for the absence. The work was provided; it remains outstanding on return. Logged by " + who + "." },
      { key: "assessment", title: "Missed assessment not yet negotiated / sat",
        text: "Trip Absence — " + trip + " (" + dates + ").\n" + name + " missed an assessment during the absence and has not yet negotiated a make-up. Student to arrange timing with the teacher as soon as practical. Logged by " + who + "." },
      { key: "combined", title: "Combined — neither form nor work completed",
        text: "Trip Absence — " + trip + " (" + dates + ").\n" + name + " neither arranged the work before departure nor completed it during the absence. Both the pre-trip form and the set work remain outstanding. Logged by " + who + "." }
    ];
  }

  function closeoutTemplatesHtml(sid) {
    _templates = buildTemplates(sid);
    var tpls = _templates.map(function (t, i) {
      return '<div class="template"><div class="template__head"><h4>' + esc(t.title) + "</h4>" +
        '<button type="button" class="btn btn--sm" data-action="copy-template" data-idx="' + i + '">Copy</button></div>' +
        "<pre>" + esc(t.text) + "</pre></div>";
    }).join("");
    return '<div class="card"><div class="card__head"><div class="card__title">Close-out templates</div>' +
      '<p class="card__sub">Copy-and-paste log entries for the failure cases. The app provides the words; you do the logging.</p></div>' +
      '<div class="card__body">' + tpls +
      '<div class="note-box" style="margin-top:14px"><b>How to log this in PowerSchool</b><br>' +
      "1. Open the student in PowerSchool → Log Entries. 2. New entry, category “Trip Absence”. 3. Paste the text above. 4. Save. " +
      "PowerSchool log entries are the school’s official record of student infractions and are always followed up by admin. " +
      "<b>Logging is done by you, not by this app</b> — there is no PowerSchool integration here.</div>" +
      "</div></div>";
  }

  /* =====================================================================
     STUDENT VIEW  (read-only for the student)
     ===================================================================== */
  function factIcon(v) {
    if (v === true) return '<span class="pill pill--green"><span class="dot"></span>Yes</span>';
    if (v === false) return '<span class="pill pill--red"><span class="dot"></span>No</span>';
    return '<span class="pill pill--neutral"><span class="dot"></span>Not yet</span>';
  }

  function renderStudent() {
    var sid = state.viewingStudentId;
    var s = snap();
    var stu = sIdx()[sid];
    var head = '<div class="view-head"><h1>' + esc(stu ? stu.firstName + " " + stu.lastName : sid) + "</h1>" +
      "<p>" + (s ? "Your responsibilities for <b>" + esc(s.tripName) + "</b>" : "Your trip page") + "</p></div>";

    if (!s) return head + '<div class="empty"><h3>Nothing to show yet</h3><p>Your page appears once the Director has approved a trip you are on.</p></div>';
    var mine = entriesForStudent(sid);
    if (!mine.length) return head + '<div class="empty"><h3>You are not on this trip</h3><p>' + esc(s.tripName) + " does not affect your classes.</p></div>";

    var acked = s.acks && s.acks[sid];
    var ackBar = acked
      ? '<div class="note-box">✓ Acknowledged ' + fmtDateTime(acked) + " — thank you. This is your proof of receipt.</div>"
      : '<div class="note-box">Please acknowledge that you have seen this page (a one-tap confirmation will appear).</div>';

    var instructions = '<div class="card"><div class="card__head"><div class="card__title">What you need to do</div></div><div class="card__body">' +
      "<p>Go to <b>each teacher below in person</b> and ask them to complete your record. " +
      "You do not enter anything here yourself — this page is read-only and just shows where things stand.</p></div></div>";

    // group by teacher
    var byTeacher = {};
    mine.forEach(function (e) { (byTeacher[e.teacherId] = byTeacher[e.teacherId] || []).push(e); });
    var blocks = Object.keys(byTeacher).sort().map(function (tid) {
      var es = byTeacher[tid];
      var classes = es.map(function (e) {
        var workSet = (e.work && e.work.set) ? e.work.set : "To be confirmed with your teacher.";
        var outstanding = (e.work && e.work.outstanding) ? e.work.outstanding : "—";
        var assess = (e.missedAssessment && e.missedAssessment.flag)
          ? '<div class="note-box" style="margin-top:8px">A <b>' + esc(e.missedAssessment.type || "task") + "</b> was missed. Please <b>" +
            esc(assessmentVerb(e.missedAssessment.type)) + "</b> it as soon as practical after you return, in negotiation with your teacher.</div>"
          : "";
        return '<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">' +
          '<div class="row" style="justify-content:space-between"><b>' + esc(e.className) + "</b>" + pillHtml(statusOf(e)) + "</div>" +
          '<dl class="kv" style="margin-top:8px">' +
          "<div><dt>Work set</dt><dd>" + esc(workSet) + "</dd></div>" +
          "<div><dt>Still outstanding</dt><dd>" + esc(outstanding) + "</dd></div>" +
          "<div><dt>Form done before trip</dt><dd>" + factIcon(e.completedFormBeforeTrip) + "</dd></div>" +
          "<div><dt>Work completed</dt><dd>" + factIcon(e.completedWork) + "</dd></div>" +
          (e.missedAssessment.flag ? "<div><dt>Make-up negotiated</dt><dd>" + factIcon(e.assessmentNegotiated) + "</dd></div>" : "") +
          "</dl>" + assess + "</div>";
      }).join("");
      return '<div class="card"><div class="card__head"><div class="card__title" style="justify-content:space-between"><span class="grow">' + esc(teacherName(tid)) + "</span>" +
        pillHtml(aggregateStatus(es)) + "</div></div><div class=\"card__body\">" + classes + "</div></div>";
    }).join("");

    return head + ackBar + instructions + blocks;
  }

  function afterStudent() {
    var s = snap(); var sid = state.viewingStudentId;
    if (!s) return;
    if (!entriesForStudent(sid).length) return;
    if (s.acks && s.acks[sid]) return;
    openAckModal(sid);
  }

  function openAckModal(sid) {
    openModal(
      "<h2>One-tap acknowledgement</h2>" +
      "<p>I have seen this page for <b>" + esc(studentName(sid)) + "</b> and understand my responsibilities: to see each teacher, arrange the work I missed, and sit/submit any missed assessment in negotiation with them.</p>" +
      '<div class="modal__actions"><button type="button" class="btn" data-action="ack-later">Later</button>' +
      '<button type="button" class="btn btn--primary" data-action="ack-confirm" data-sid="' + esc(sid) + '">I have seen this &amp; understand</button></div>'
    );
  }

  /* =====================================================================
     OUTBOX VIEW
     ===================================================================== */
  function renderOutbox() {
    var s = snap();
    var mails = (s && s.outbox) ? s.outbox.slice() : [];
    var head = '<div class="view-head"><h1>Outbox</h1><p>Every notification the workflow “sent”. Nothing is actually emailed — these are rendered on screen only.</p></div>';
    if (!mails.length) {
      return head + '<div class="empty"><h3>No messages yet</h3><p>Approve a trip and use the stage buttons in the toolbar (or “Send FYI to HS Admin”) to generate notifications.</p></div>';
    }
    mails.sort(function (a, b) { return a.ts < b.ts ? -1 : 1; });
    var cards = mails.map(function (m) {
      return '<div class="email"><div class="email__head">' +
        '<div class="email__subject">' + esc(m.subject) + "</div>" +
        '<div class="email__meta"><b>To:</b> ' + esc(m.to) + " &nbsp;·&nbsp; <b>From:</b> " + esc(m.from) +
        " &nbsp;·&nbsp; " + esc(fmtDateTime(m.ts)) + ' &nbsp; <span class="chip email__stage">' + esc(STAGE_LABEL[m.stage] || m.stage) + "</span></div></div>" +
        '<div class="email__body">' + esc(m.body) + "</div></div>";
    }).join("");
    return head + '<p class="help" style="margin:0 2px 12px">' + mails.length + " message(s), oldest first.</p>" + cards;
  }

  /* =====================================================================
     EVENTS + INIT
     ===================================================================== */
  function withEntry(key, fn) {
    var e = findEntryByKey(key); if (!e) return null;
    fn(e); e.updatedAt = new Date().toISOString(); save(); return e;
  }
  function doStage(stage) {
    if (stage === "approved") { if (approve()) { toast("Approved & frozen."); } }
    else if (!snap()) { toast("Approve a trip first.", true); }
    else if (stage === "week_out") fireWeekOut();
    else if (stage === "departure") fireDeparture();
    else if (stage === "day_before_return") fireDayBeforeReturn();
    else if (stage === "morning_return") fireMorningReturn();
    render();
  }
  // The sample sheet represents the Feb trip (the one with a full timetable).
  var SAMPLE_TRIP_ID = "T24";

  function loadSample() {
    var parsed = parseCsv(FX.sampleCsv);
    state.director.parse = analyzeSheet(parsed, FX);
    state.director.loadedTripId = SAMPLE_TRIP_ID;
    state.director.source = "drive-sample";
    save(); render();
    toast("Trip sheet loaded from Drive.");
  }

  function onClick(e) {
    var seg = e.target.closest && e.target.closest("#view-seg .seg__btn");
    if (seg) { setView(seg.getAttribute("data-view")); return; }
    if (e.target.closest && e.target.closest("#reset-demo")) {
      if (window.confirm("Reset the demo? This clears the frozen snapshot, the Outbox, every teacher entry and acknowledgement.")) {
        resetAll(); render(); toast("Demo reset.");
      }
      return;
    }
    var stageBtn = e.target.closest && e.target.closest("[data-stage]");
    if (stageBtn) { if (!stageBtn.disabled) doStage(stageBtn.getAttribute("data-stage")); return; }

    var el = e.target.closest && e.target.closest("[data-action]");
    if (el) {
      var a = el.getAttribute("data-action");
      var key = el.getAttribute("data-key");
      if (a === "goto") { setView(el.getAttribute("data-view")); return; }
      if (a === "dir-signin") { state.director.signedIn = true; save(); render(); return; }
      if (a === "dir-tab") { state.director.tab = el.getAttribute("data-tab"); save(); render(); return; }
      if (a === "drive-open") { toast("Drive browsing is stubbed for this demo — load the sample sheet."); return; }
      if (a === "load-sample") { loadSample(); return; }
      if (a === "approve") { if (approve()) { state.director.tab = "approve"; render(); toast("Approved & frozen."); } return; }
      if (a === "fyi") { fireFyi(); render(); return; }
      if (a === "teacher-select") { state.teacherSelectedStudent = el.getAttribute("data-sid"); save(); render(); return; }
      if (a === "set-q") {
        var q = el.getAttribute("data-q"), yn = el.getAttribute("data-yn") === "yes";
        withEntry(key, function (en) {
          var field = q === "form" ? "completedFormBeforeTrip" : q === "work" ? "completedWork" : "assessmentNegotiated";
          en[field] = (en[field] === yn) ? null : yn;
        });
        render(); return;
      }
      if (a === "finalize") { withEntry(key, function (en) { en.finalized = true; }); render(); toast("Record finalized."); return; }
      if (a === "unfinalize") { withEntry(key, function (en) { en.finalized = false; }); render(); return; }
      if (a === "copy-across") {
        var src = findEntryByKey(key); if (!src) return;
        var n = 0;
        (snap().entries || []).forEach(function (en) {
          if (en.teacherId === src.teacherId && en.className === src.className && en.studentId !== src.studentId) {
            en.work = { set: src.work.set, outstanding: src.work.outstanding };
            en.missedAssessment = { flag: src.missedAssessment.flag, type: src.missedAssessment.type };
            en.updatedAt = new Date().toISOString(); n++;
          }
        });
        save(); render(); toast(n ? "Copied to " + n + " other student(s) in " + src.className + "." : "No other students in this class.");
        return;
      }
      if (a === "copy-template") { var t = _templates[+el.getAttribute("data-idx")]; if (t) copyText(t.text); return; }
      if (a === "ack-confirm") {
        var sid = el.getAttribute("data-sid"); var s = snap();
        if (s) { s.acks = s.acks || {}; s.acks[sid] = new Date().toISOString(); save(); }
        closeModal(); render(); toast("Acknowledged — thank you."); return;
      }
      if (a === "ack-later") { closeModal(); return; }
    }
    if (e.target.hasAttribute && e.target.hasAttribute("data-overlay")) closeModal();
  }

  function onChange(e) {
    var t = e.target;
    if (t.id === "viewing-as") {
      if (state.view === "teacher") { state.viewingTeacherId = t.value; state.teacherSelectedStudent = null; }
      else state.viewingStudentId = t.value;
      save(); render(); return;
    }
    var a = t.getAttribute && t.getAttribute("data-action");
    if (!a) return;
    var key = t.getAttribute("data-key");
    if (a === "dir-contact") { state.director.designatedContactId = t.value; save(); render(); }
    else if (a === "set-contact") { withEntry(key, function (en) { en.contactStatus = t.value; }); render(); }
    else if (a === "set-atype") { withEntry(key, function (en) { en.missedAssessment.type = t.value; }); render(); }
    else if (a === "toggle-missed") {
      withEntry(key, function (en) {
        en.missedAssessment.flag = t.checked;
        if (t.checked) { if (!en.missedAssessment.type) en.missedAssessment.type = ASSESSMENT_TYPES[0]; }
        else { en.missedAssessment.type = null; en.assessmentNegotiated = null; }
      });
      render();
    }
    else if (a === "set-work") { withEntry(key, function (en) { en.work[t.getAttribute("data-field")] = t.value; }); render(); }
  }

  function onInput(e) {
    var t = e.target;
    if (t.getAttribute && t.getAttribute("data-action") === "set-work") {
      withEntry(t.getAttribute("data-key"), function (en) { en.work[t.getAttribute("data-field")] = t.value; });
      // no re-render on each keystroke (preserve focus); status pills refresh on blur
    }
  }

  function onKey(e) { if (e.key === "Escape") closeModal(); }

  function init() {
    load();
    document.addEventListener("click", onClick);
    document.addEventListener("change", onChange);
    document.addEventListener("input", onInput);
    document.addEventListener("keydown", onKey);
    render();
  }

  // Public, testable surface.
  window.TAS = {
    parseCsv: parseCsv, analyzeSheet: analyzeSheet, coveredWeekdays: coveredWeekdays,
    computeMeetings: computeMeetings, affectedByTeacher: affectedByTeacher,
    buildEntries: buildEntries, statusOf: statusOf, assessmentVerb: assessmentVerb
  };

  if (typeof document !== "undefined") {
    if (document.getElementById("view")) {
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
      else init();
    }
  }
})();
