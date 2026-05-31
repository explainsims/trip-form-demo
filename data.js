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
    { id: "T01", name: "Mr Alvarez",   email: "alvarez@demo.example",   subject: "Mathematics" },
    { id: "T02", name: "Ms Bauer",     email: "bauer@demo.example",     subject: "English" },
    { id: "T03", name: "Mr Castillo",  email: "castillo@demo.example",  subject: "Science" },
    { id: "T04", name: "Ms Devi",      email: "devi@demo.example",      subject: "Humanities" },
    { id: "T05", name: "Mr Eriksson",  email: "eriksson@demo.example",  subject: "PE & Health" }
  ];

  var students = [
    { id: "S0001", firstName: "Maya",    lastName: "Bennett",   grade: 9,  email: "maya.bennett@demo.example" },
    { id: "S0002", firstName: "Liam",    lastName: "Castellano", grade: 10, email: "liam.castellano@demo.example" },
    { id: "S0003", firstName: "Aisha",   lastName: "Rahman",    grade: 11, email: "aisha.rahman@demo.example" },
    { id: "S0004", firstName: "Noah",    lastName: "Whitfield", grade: 9,  email: "noah.whitfield@demo.example" },
    { id: "S0005", firstName: "Sofia",   lastName: "Marchetti", grade: 12, email: "sofia.marchetti@demo.example" },
    { id: "S0006", firstName: "Ethan",   lastName: "Okafor",    grade: 10, email: "ethan.okafor@demo.example" },
    { id: "S0007", firstName: "Hannah",  lastName: "Lindqvist", grade: 11, email: "hannah.lindqvist@demo.example" },
    { id: "S0008", firstName: "Daniel",  lastName: "Yamamoto",  grade: 12, email: "daniel.yamamoto@demo.example" }
  ];

  // Expand one class meeting across several students.
  function cls(day, period, className, teacherId, ids) {
    return ids.map(function (id) {
      return { studentId: id, day: day, period: period, className: className, teacherId: teacherId };
    });
  }

  // A believable weekly timetable. The Feb trip (T24) spans Thu–Sun, so the
  // Thursday/Friday meetings below are what the absence join surfaces.
  //
  // Trip participants (matched from the sample sheet): Maya (S0001),
  // Liam (S0002), Aisha (S0003), Noah (S0004), Hannah (S0007). The trip-day
  // meetings are arranged so that every teacher is impacted in two different
  // classes — except Mr Eriksson (one class) — and Mr Alvarez has the same
  // student (Maya) in both of his classes.
  var timetable = [].concat(
    // ---- Mon–Wed filler (not trip days; adds realism, never surfaced) ----
    cls("Mon", 1, "Algebra I",     "T01", ["S0001", "S0002", "S0005", "S0008"]),
    cls("Tue", 2, "Biology",       "T03", ["S0001", "S0003", "S0006"]),
    cls("Wed", 3, "English 9",     "T02", ["S0004", "S0006", "S0008"]),

    // ---- Thursday (trip day) ----
    cls("Thu", 1, "Algebra I",     "T01", ["S0001", "S0002", "S0005"]),       // Alvarez — class 1
    cls("Thu", 2, "Biology",       "T03", ["S0001", "S0003", "S0006"]),       // Castillo — class 1
    cls("Thu", 3, "English 9",     "T02", ["S0004", "S0008"]),                // Bauer — class 1
    cls("Thu", 4, "World History", "T04", ["S0002", "S0004", "S0005"]),       // Devi — class 1
    cls("Thu", 5, "PE",            "T05", ["S0003", "S0004", "S0008"]),       // Eriksson — single class

    // ---- Friday (trip day) ----
    cls("Fri", 1, "English 11",    "T02", ["S0003", "S0007"]),                // Bauer — class 2
    cls("Fri", 2, "Geometry",      "T01", ["S0001", "S0003"]),                // Alvarez — class 2 (Maya again)
    cls("Fri", 3, "Chemistry",     "T03", ["S0002", "S0007"]),               // Castillo — class 2
    cls("Fri", 5, "Geography",     "T04", ["S0001", "S0007", "S0006"])        // Devi — class 2
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
  // column (not travelling), a blank ID, and an unknown ID — so the parser
  // has rows to flag.
  var sampleCsv = [
    "No,ID,Last name,First name,Grade",
    "1,S0001,Bennett,Maya,9",
    "2,S0002,Castellano,Liam,10",
    "3,S0003,Rahman,Aisha,11",
    "4,S0004,Whitfield,Noah,9",
    "XX,S0005,Marchetti,Sofia,12",
    "6,,Okafor,Ethan,10",
    "7,S0007,Lindqvist,Hannah,11",
    "8,S9999,Delgado,Priya,12"
  ].join("\n");

  var FIXTURES = {
    teachers: teachers, students: students, timetable: timetable,
    seasons: seasons, trips: trips, sampleCsv: sampleCsv
  };

  if (typeof module !== "undefined" && module.exports) module.exports = FIXTURES;
  if (typeof window !== "undefined") window.FIXTURES = FIXTURES;
})(typeof globalThis !== "undefined" ? globalThis : this);
