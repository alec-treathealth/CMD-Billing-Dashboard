# Kipu Billing Report fixture — PHI-FREE, derived, do not add raw exports here

Derived from the real Kipu "Billable" Billing Report export of 2026-08-21
(the Aug 10 week, `…Time-12-28am`) by a throwaway scrubber
(`scripts/make-kipu-fixture.mjs`, now TRACKED — it is the audit trail for the
PHI-free claim below, and an unauditable claim is not worth much):

- **Patient names** → `Fixture Patient NN` (deterministic, order of first appearance).
- **Provider / Signed By** → `Provider NN`.
- **Authorization numbers** → `AUTH-5NNN` (`No Auth Required` literal preserved).
- **Session / Evaluation / Template ids** → remapped to 91xxx / 92xxx / 93xxx.
- **Every `MM/DD/YYYY` date shifted −364 days** (exactly 52 weeks, so weekday
  structure and week bucketing are preserved: the real 2026-08-10 week is this
  fixture's 2025-08-11 week).
- Preserved byte-for-byte where it matters: the UTF-8 BOM, the
  `Insurance 1   Insurance Company` three-space header, embedded newlines inside
  quoted Authorizations cells, telehealth attestation suffixes, statuses,
  durations, times of day, and group roster counts.

The scrubber's leak check verified **zero** original name tokens survive.
Structure counts match the real export: 27 patients, 122 session rows,
61 evaluation rows, header-only Labs.

**Never place a raw Kipu export in this directory.** Real exports live outside
the repo and are exercised by the manual harness
(`scripts/test-kipu-report-import.mjs`), not by the hermetic suite.
