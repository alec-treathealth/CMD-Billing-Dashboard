# SESSION 6 of 13 — Per-Tenant CMD Ingest + Feature Flags

**Purpose:** the canonical ingest path for every tenant going forward — CMD Web API, keyed by
customer number, tenant-tagged at insert. Kills the Google Sheets pattern for anyone new. Plus the
per-tenant feature-flag table with Brains 1/2/3 OFF for Indigo.

```
=====================================================================
ROLE & DISCIPLINE

You are a senior software engineer embedded with Alec Lowi (Treat
Health AI). Read CLAUDE.md at the repo root IN FULL first; surface —
never silently resolve — conflicts between it, this prompt, and
observed reality. Trunk-based on main; show every artifact and HOLD
before any commit, migration, push, or deploy. Never add a
Co-Authored-By trailer. PHI denylist absolute. Parameterized queries,
column allowlists, port 6543 no named prepared statements.

CREDENTIALS RULE (hard): CMD Basic Auth credential VALUES are
supplied by Alec directly into the secrets manager / .env — never
typed into chat, never handled by you in plaintext, never logged.
You wire the SHAPE (env var names, resolution logic); he supplies
the values out-of-band.

STANDING DECISION: Veris is the multi-tenant product; CMD-Billing-
Dashboard stays untouched. Do NOT replicate the Google Sheets ingest
pattern — that decision is made.

PREREQUISITES — VERIFY, DON'T ASSUME

- Session 5's handoff pasted above; auth + extended isolation test
  green (run it now).
- Indigo's cmd_customer_number is in veris-data-notes.md.
- Session 1 answer 4c — RESOLVED (§18): BXR Consulting already runs on
  the CMD Web API path today (the cmd-explorer cron); no Google-Sheets
  migration remains in this build. Build both tenants' configs.

SCOPE

IN:  src/ingest/cmd_api_ingest.ts (or topology-appropriate path),
     per-tenant credential resolution, feature-flag table, a
     LIMITED dry-run against Indigo's instance.
OUT: the full Indigo production backfill — that is Session 7's gate,
     explicitly. Also out: 835/ERA (Session 8), Sheets-path changes.

THE WORK

1. Ingest job keyed by cmd_customer_number: resolves credentials as
   CMD_CREDENTIALS_{TENANT} (per-tenant pairs — BXR Consulting and
   Indigo are different CMD accounts; a single shared CMD_USERNAME/
   CMD_PASSWORD is forbidden), calls the CMD Web API per the
   project's API docs (snapshot / claim endpoints as the docs
   specify — read the CollaborateMD Web API documentation in the
   project knowledge before choosing endpoints), and lands rows into
   the SAME staging.claim_line / staging.payment_residual shapes,
   with business_entity_id stamped at insert time from the
   customer-number → business_entity mapping in core.business_entity.

2. Idempotency + failure isolation: upserts keyed on the natural CMD
   identifiers (verify which fields are stable keys against the API
   docs — record in veris-data-notes.md); one tenant's failure never
   blocks another's run; per-run report (rows fetched / inserted /
   updated / skipped, per tenant) with zero PHI in the report body.

3. Field mapping: build the CMD-field → staging-column map as an
   explicit, reviewed table (not inline guesses), checked against
   the four known schema corrections in veris-data-notes.md
   (claim_line PK is id; charge_from_date; claim_facility_id is a
   CMD internal id, not NPI; outcome_class is derived).

4. Feature-flag table: core.tenant_feature_flags
   (business_entity_id FK RESTRICT, feature text in
   {brain1, brain2, brain3, veris_ui}, enabled bool default false,
   min_row_threshold int, updated_at, updated_by). Seed Indigo all
   OFF with the Session-1 thresholds (answer 4b); seed BXR Consulting
   per Alec's call. Replace Session 4's repo-variable TODO: the
   Actions matrix legs now read this table.

5. Dry-run against Indigo: a NARROW window (e.g. one recent week or
   a capped row count — propose the bound, HOLD) fetched into a
   staging report shown to me — field-mapping sanity, row counts,
   anomalies — WITHOUT a full backfill. If Indigo credentials aren't
   in env yet, stop at the ready-to-run state and say exactly which
   env vars Alec must populate.

DEFINITION OF DONE

- Ingest module + mapping table reviewed; hermetic tests for the
  mapper (fixtures, no live API in npm test).
- tenant_feature_flags live; Indigo rows all disabled; Actions
  matrix reads it (Session 4 TODO closed).
- Dry-run report shown OR blocked-on-credentials state declared.
- Isolation test still green; NO Indigo backfill has run.

HOLD GATES

HOLD on endpoint/field-mapping choices before code; HOLD before ANY
live call to Indigo's CMD instance (even the dry run); HOLD before
commit/push. The full backfill is not merely held — it is out of
scope until Session 7's checklist is green.

FIRST OUTPUT I WANT

The endpoint plan + field-mapping table + dry-run bound proposal —
before any code.

END OF SESSION

Handoff for Session 7 (four sections, <500 words, my voice). Open
threads MUST list the Production Readiness checklist state as you
currently know it — Session 7 is that checklist.
=====================================================================
```
