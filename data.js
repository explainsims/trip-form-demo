/* =========================================================================
   data.js — baked-in FICTIONAL fixtures for the Trip Absence Workflow demo.
   Stands in for the BigQuery (ID -> email + timetable) join and the Drive
   trip sheet. No network calls: the data is embedded so the prototype runs
   by double-click (file://) or behind a path-stripping proxy.

   Exposes window.FIXTURES in the browser, and module.exports for Node
   tooling/tests. The data/*.json files in the repo are generated from this
   same source so they double as the integration contract.
   ========================================================================= */
(function (root) {
  "use strict";

  var teachers = [
    { id: "T01", name: "Mr Demo Alvarez",   email: "alvarez@demo.example",   subject: "Mathematics" },
    { id: "T02", name: "Ms Demo Bauer",     email: "bauer@demo.example",     subject: "English" },
    { id: "T03", name: "Mr Demo Castillo",  email: "castillo@demo.example",  subject: "Science" },
    { id: "T04", name: "Ms Demo Devi",      email: "devi@demo.example",      subject: "Humanities" },
    { id: "T05", name: "Mr Demo Eriksson",  email: "eriksson@demo.example",  subject: "PE & Health" }
  ];

  var students = [
    { id: "S0001", firstName: "Demo", lastName: "Student 01", grade: 9,  email: "s0001@demo.example" },
    { id: "S0002", firstName: "Demo", lastName: "Student 02", grade: 10, email: "s0002@demo.example" },
    { id: "S0003", firstName: "Demo", lastName: "Student 03", grade: 11, email: "s0003@demo.example" },
    { id: "S0004", firstName: "Demo", lastName: "Student 04", grade: 9,  email: "s0004@demo.example" },
    { id: "S0005", firstName: "Demo", lastName: "Student 05", grade: 12, email: "s0005@demo.example" },
    { id: "S0006", firstName: "Demo", lastName: "Student 06", grade: 10, email: "s0006@demo.example" },
    { id: "S0007", firstName: "Demo", lastName: "Student 07", grade: 11, email: "s0007@demo.example" },
    { id: "S0008", firstName: "Demo", lastName: "Student 08", grade: 12, email: "s0008@demo.example" }
  ];

  // Expand one class meeting across several students.
  function cls(day, period, className, teacherId, ids) {
    return ids.map(function (id) {
      return { studentId: id, day: day, period: period, className: className, teacherId: teacherId };
    });
  }

  // A believable weekly timetable. The Feb trip (T24) spans Thu–Sun, so the
  // Thursday/Friday meetings below are what the absence join will surface.
  var timetable = [].concat(
    cls("Mon", 1, "Algebra I",     "T01", ["S0001", "S0002", "S0003"]),
    cls("Tue", 2, "Biology",       "T03", ["S0004", "S0005"]),
    cls("Wed", 3, "English 9",     "T02", ["S0006", "S0007"]),
    // Thursday — a trip day
    cls("Thu", 1, "Algebra I",     "T01", ["S0001", "S0002", "S0004"]),
    cls("Thu", 2, "Biology",       "T03", ["S0001", "S0003", "S0005", "S0007"]),
    cls("Thu", 3, "English 9",     "T02", ["S0002", "S0004", "S0006"]),
    cls("Thu", 4, "World History", "T04", ["S0003", "S0005"]),
    cls("Thu", 5, "PE",            "T05", ["S0001", "S0006", "S0007"]),
    // Friday — a trip day
    cls("Fri", 1, "English 9",     "T02", ["S0001", "S0003"]),
    cls("Fri", 2, "Algebra I",     "T01", ["S0005", "S0007"]),
    cls("Fri", 3, "Biology",       "T03", ["S0002", "S0006"]),
    cls("Fri", 4, "PE",            "T05", ["S0003", "S0004"]),
    cls("Fri", 5, "World History", "T04", ["S0001", "S0002", "S0004", "S0006"])
  );

  var seasons = ["Season 1 (Fall)", "Season 2 (Winter)", "Season 3 (Spring)"];

  var trips = [
    {
      id: "T24", season: "Season 2 (Winter)", program: "Athletics",
      name: "T24 – MRISA Sr Soccer 2026",
      departure: "2026-02-12T07:00", return: "2026-02-15T18:00",
      academicNotes: "No late start permitted Monday.",
      rosterStudentIds: ["S0001", "S0002", "S0003", "S0004", "S0005", "S0006", "S0007"]
    },
    {
      id: "T28", season: "Season 3 (Spring)", program: "Athletics",
      name: "T28 – Model UN Conference 2026",
      departure: "2026-05-29T07:00", return: "2026-06-01T18:00",
      academicNotes: "Students present Friday afternoon.",
      rosterStudentIds: ["S0002", "S0004", "S0006"]
    },
    {
      id: "T31", season: "Season 3 (Spring)", program: "Athletics",
      name: "T31 – MRISA Sr Volleyball 2026",
      departure: "2026-06-08T07:00", return: "2026-06-11T18:00",
      academicNotes: "Return flight may be delayed; plan for Friday.",
      rosterStudentIds: ["S0001", "S0003", "S0005", "S0007"]
    }
  ];

  // The sheet the Director "uploads". Deliberately messy: an XX in the No.
  // column, a blank ID, and an unknown ID — so the parser has rows to flag.
  var sampleCsv = [
    "No,ID,Last name,First name,Grade",
    "1,S0001,Student 01,Demo,9",
    "2,S0002,Student 02,Demo,10",
    "3,S0003,Student 03,Demo,11",
    "4,S0004,Student 04,Demo,9",
    "XX,S0005,Student 05,Demo,12",
    "6,,Student 06,Demo,10",
    "7,S0007,Student 07,Demo,11",
    "8,S9999,Student 99,Demo,12"
  ].join("\n");

  var FIXTURES = {
    teachers: teachers, students: students, timetable: timetable,
    seasons: seasons, trips: trips, sampleCsv: sampleCsv
  };

  if (typeof module !== "undefined" && module.exports) module.exports = FIXTURES;
  if (typeof window !== "undefined") window.FIXTURES = FIXTURES;
})(typeof globalThis !== "undefined" ? globalThis : this);
