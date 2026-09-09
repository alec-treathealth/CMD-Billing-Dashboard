-- 038 — ref.code_description: curated HCPCS / CPT / revenue-code labels for the Code Performance tab
--
-- WHY: /code-performance (the renamed Code Reference tab) aggregates
--   collections.cmd_explorer_charge_rollup by procedure code × revenue code and needs a
--   human-readable label per code, plus a visible review state. Measured 2026-09-08 over the
--   trailing 180 days: 27 distinct procedure-slot values and 22 distinct revenue codes (plus a NULL) across both
--   tenants. (The build thread earlier carried "24 values" for revenue and "34" static-only
--   procedure codes; both were miscounts, not a data change — 22 and 32 are the observed truth.) Codes and labels are reference text, not tenant data, so this lives in the global
--   reference plane next to ref.payer_alias_map — which the product plane already reads
--   (src/collections/qualifyResolutionQuery.ts, six joins; claims_reader USAGE on ref + SELECT
--   verified live 2026-09-08).
--
--   ⚠ NOT ref.service_codes, and that was decided rather than overlooked (ruling 2026-09-08).
--   service_codes is the 0010 VOB-foundation table: zero rows, zero code readers on any branch or
--   worktree, BUT two other 0010 tables foreign-key into it (benefit_check_services,
--   claim_line_features) and its vocabulary is ('CPT','HCPCS','REV','OTHER'). A table two others
--   FK into is a fixed point regardless of row count. The fold (this table into service_codes, or
--   dropping the unused 0010 scaffolding) is FILED as a follow-up gated on the VOB foundation's
--   fate. To keep that fold cheap, THIS TABLE USES service_codes' code_type VOCABULARY VERBATIM.
--
-- CODE_TYPE RULE — explicit, enforced by CHECK, arguable by design:
--   'CPT'   = HCPCS Level I  — five digits             ^[0-9]{5}$        (90853, 90837, 99499, 90791)
--   'HCPCS' = HCPCS Level II — one letter + four digits ^[A-Z][0-9]{4}$   (H0018, S9480, G0410)
--   'REV'   = NUBC revenue code — four digits, or three digits + 'X' for a range placeholder
--                                                       ^[0-9]{3}[0-9X]$  (0905, 1001, 043X)
--   'OTHER' = anything CMD emits in the procedure-code slot that is not a code: the literal em
--             dash '—' (no code reported), and the interest markers 'INT' / 'INTRST'.
--   The split of Level I from Level II is a consequence of adopting service_codes' enum, not a
--   choice this surface needed. READERS LOOK UP PROCEDURE CODES ACROSS ('CPT','HCPCS','OTHER') AND
--   REVENUE CODES AS 'REV' — the app never asks "is this CPT or HCPCS", it asks "what does this
--   procedure-slot value mean". The CHECK makes the classification deterministic so the same
--   string can never be seeded under two types.
--   ⚠ Category III CPT codes (four digits + T, e.g. 0042T) do NOT match the CPT shape and fall to
--   OTHER under this rule. None are live today; when one appears, the choice is a migration that
--   either widens the CPT pattern to ^[0-9]{4}[0-9T]$ or seeds it as OTHER on purpose — not a silent
--   guess at read time. Recording an exception needs a migration; for a curated, migration-seeded
--   table with no ingest path that rigidity is the feature.
--
-- SEED PROVENANCE — two sources, BOTH ship needs_review = true (Rulings 2 and 4, 2026-09-08):
--   'alec-seed-2026-09-08'            per-code descriptors written from general knowledge in the
--                                     build thread for the 27 + 22 values observed live.
--   'code-reference-static-2026-06-18' the retired static dataset in app/components/code-reference.tsx
--                                     (commit 27ccea8, Alec, cited to CMS PHP Billing Article, CMS
--                                     Transmittal A01-111, Novitas IOP, NUBC UB-04, Ensora, Behave
--                                     Health). Better provenance than the thread text — but it keys
--                                     GROUP labels ("Individual Psychotherapy" for 13 codes), cannot
--                                     key a per-code table, and OMITS 90853, the second-highest-volume
--                                     group code live (3,814 charges). A corroborating source, not a
--                                     source of truth. Its 32 procedure codes and 4 revenue codes not
--                                     observed live are seeded from its text so nothing curated is lost.
--   Where both sources describe a code: the per-code descriptor is short_label/long_description, the
--   static text is prior_description, source_citation carries the static row's citation(s).
--   ONE conflict, held open on purpose (Ruling 3): S9475 — the HCPCS descriptor says ambulatory
--   detoxification per diem; the static row says PHP per diem for non-Medicare payers. Both can be
--   true (what the code means vs how a payer adjudicates it). description_conflict = true routes it
--   to review; nothing here resolves it.
--   Neither source is authoritative enough to skip human review — the UI must visibly mark
--   needs_review rows, and needs_review = false REQUIRES reviewed_by + reviewed_at (029's shape).
--
-- PRECEDENCE — the READ contract (B, ruled 2026-09-08). The unique key permits a GLOBAL row
--   (business_entity_id NULL) and a TENANT row for the same code to coexist. When both exist the
--   TENANT-SPECIFIC ROW WINS; the global row is the fallback. Readers implement it as ONE query —
--     select distinct on (code_type, code) …
--       where business_entity_id is null or business_entity_id = $1::uuid
--       order by code_type, code, business_entity_id nulls last
--   — so a tenant override shadows the global text without deleting it, and a tenant with no override
--   sees the global row. No row of any other tenant is ever returned (the WHERE admits exactly two
--   candidates per code). src/collections/codePerformanceQuery.ts is the reference implementation and
--   its test locks the ORDER BY; do not add a second reader with different precedence.
--
-- NO-CODE PRESENTATION — two representations, ONE code path (D, ruled 2026-09-08). "No code reported"
--   reaches this surface in two shapes: the literal em dash in the procedure slot (seeded here as OTHER
--   '—', so it appears in the review queue with its data-quality explanation) and a NULL revenue code
--   (BXR, ~408 charges, not seeded — a NULL cannot key a lookup). To a biller they are the same fact.
--   The builders emit them UNCHANGED (hcpcs = '—', revcode = NULL); the app resolves BOTH through one
--   helper that yields the same label family ("No procedure code reported" / "No revenue code
--   reported"), the same `no_code` row flag and identical styling. The em dash row's table label is
--   what the helper returns for the procedure side, and the revenue-side constant lives beside it in
--   the same helper, so the two wordings cannot drift and no component ever renders a bare blank for
--   the NULL. That helper is the only place either is interpreted.
--
-- PHI DISCIPLINE: contains NO PHI. Codes and descriptive text only; nothing here is patient-,
--   member-, or claim-derived, and nothing joins to a PHI table. business_entity_id is nullable and
--   NULL on every seeded row (global). A tenant-specific override row is representable (the unique
--   key includes the tenant, NULLS NOT DISTINCT so two global rows for one code still collide), but
--   none is seeded and the app does not write here.
-- OWNERSHIP: claims_admin via `set role claims_admin` — the 026/029/035 pattern for `ref`
--   (`ref` is postgres-owned; claims_admin holds CREATE on it — verified live 2026-09-08).
--   Reads: claims_reader (SELECT + RLS read-all, the 015 posture every ref table carries).
--   Writes: NONE. No writer role, no definer. Edits are a migration or a future attributed
--   definer; until then a review is an UPDATE run by the operator with reviewed_by filled in.
-- IDEMPOTENT: create table if not exists; drop policy if exists before create policy; the seed is
--   insert … on conflict on constraint code_description_code_uniq do nothing, so a re-run neither
--   duplicates nor overwrites a row someone has since reviewed; grants are unconditional.
-- DEPENDENCY: 015 (ref plane RLS posture), core.business_entity (tenancy S1; claims_admin-owned,
--   REFERENCES verified live). Independent of 037 (era-835 claim-line grain), which is authored on
--   feat/era-835-claim-line-grain and NOT applied — this file skipped that number on purpose.
--   Number re-verified against the live ledger (max 036 @ 20260907063039), origin/main, every
--   branch and all seven worktrees immediately before authoring.
-- Rollback: 038_ref_code_description_rollback.sql

set role claims_admin;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 1. THE TABLE
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists ref.code_description (
  code_description_id  bigint generated always as identity primary key,

  -- NULL = global row. A tenant override is representable but none is seeded.
  business_entity_id   uuid references core.business_entity(id),

  code_type            text        not null,
  code                 text        not null,

  short_label          text        not null,
  long_description     text,

  -- The OTHER source's text when two sources describe one code (see header). Kept, never merged.
  prior_description    text,
  -- Citation(s) carried from the static dataset: "<label> — <url>", ' | '-joined when several.
  source_citation      text,
  provenance           text        not null,

  -- Review state — 029's shape: leaving review requires attribution.
  needs_review         boolean     not null default true,
  description_conflict boolean     not null default false,
  reviewed_by          text,
  reviewed_at          timestamptz,

  created_at           timestamptz not null default now(),

  -- NULLS NOT DISTINCT: two global rows (tenant NULL) for one code are a collision, not two rows.
  constraint code_description_code_uniq
    unique nulls not distinct (code_type, code, business_entity_id),

  -- service_codes' vocabulary, verbatim — see the header for why.
  constraint code_description_code_type
    check (code_type in ('CPT', 'HCPCS', 'REV', 'OTHER')),

  -- The CODE_TYPE RULE, machine-enforced so classification is deterministic.
  constraint code_description_code_shape check (
       (code_type = 'CPT'   and code ~ '^[0-9]{5}$')
    or (code_type = 'HCPCS' and code ~ '^[A-Z][0-9]{4}$')
    or (code_type = 'REV'   and code ~ '^[0-9]{3}[0-9X]$')
    or (code_type = 'OTHER' and code !~ '^[0-9]{5}$' and code !~ '^[A-Z][0-9]{4}$' and code !~ '^[0-9]{3}[0-9X]$')
  ),

  constraint code_description_code_len      check (char_length(code) between 1 and 12),
  constraint code_description_label_len     check (char_length(short_label) between 1 and 120),
  constraint code_description_provenance_len check (char_length(provenance) between 3 and 80),

  -- A row may leave review ONLY with attribution (029's gate, restated here).
  constraint code_description_review_attributed
    check (needs_review or (reviewed_by is not null and reviewed_at is not null)),

  -- A flagged conflict must carry the text it conflicts with.
  constraint code_description_conflict_has_prior
    check (not description_conflict or prior_description is not null)
);

comment on table ref.code_description is
  'Curated labels for procedure-slot values (CPT / HCPCS / OTHER) and revenue codes (REV) read by '
  '/code-performance. Global reference text, NO PHI. Every seeded row ships needs_review = true; '
  'leaving review requires reviewed_by + reviewed_at. Two sources are kept side by side '
  '(short_label/long_description vs prior_description) and description_conflict marks a disagreement '
  'that is deliberately unresolved. code_type vocabulary is ref.service_codes'' verbatim so a later '
  'fold is cheap (follow-up filed 2026-09-08).';

comment on column ref.code_description.business_entity_id is
  'NULL = global row. A tenant row for the same code SHADOWS the global one for that tenant only '
  '(distinct on … order by business_entity_id nulls last); global is the fallback. See the PRECEDENCE '
  'block in 038''s header.';
comment on column ref.code_description.code_type is
  'CPT = HCPCS Level I (^[0-9]{5}$) · HCPCS = Level II (^[A-Z][0-9]{4}$) · REV = NUBC revenue code '
  '(^[0-9]{3}[0-9X]$, X = range placeholder) · OTHER = non-code procedure-slot markers (em dash, INT, '
  'INTRST). Readers look procedure codes up across (CPT, HCPCS, OTHER) and revenue codes as REV.';
comment on column ref.code_description.prior_description is
  'The other source''s description when two sources describe one code. Never merged into '
  'short_label — a reviewer sees both.';
comment on column ref.code_description.description_conflict is
  'TRUE when the two sources disagree in SUBSTANCE (not wording). Seeded true for exactly one row: '
  'S9475. Left unresolved by ruling; both readings can be true.';
comment on column ref.code_description.needs_review is
  'TRUE on every seeded row. Neither seed source was validated against an authoritative descriptor. '
  'The UI must mark unreviewed rows visibly.';

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 2. RLS + READER GRANT — the 015 posture every ref table carries
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
alter table ref.code_description enable row level security;

drop policy if exists code_description_read_all on ref.code_description;
create policy code_description_read_all on ref.code_description
  for select using (true);

-- READ-ONLY TO THE APP. No insert/update/delete grant to anyone — there is no writer.
grant select on ref.code_description to claims_reader;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 3. SEED — 85 rows: 27 + 22 observed live (per-code text) and 32 + 4 carried from the static dataset.
--    The NULL revenue code (BXR, 408 charges) is NOT a row — a NULL cannot key a lookup; the reader labels it in code.
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
with cite(key, txt) as (values
  ('cms_php', 'CMS PHP Billing Article — https://www.cms.gov/medicare-coverage-database/view/article.aspx?articleId=57053&ver=21'),
  ('ensora',  'Ensora PHP Billing Guide (updated May 2026) — https://ensorahealth.com/blog/php-billing-codes-every-facility-should-know/'),
  ('a01111',  'CMS Transmittal A01-111 — https://www.cms.gov/regulations-and-guidance/guidance/transmittals/downloads/a01111.pdf'),
  ('novitas', 'Novitas IOP Billing Requirements — https://www.novitas-solutions.com/webcenter/portal/MedicareJH/pagebyid?contentId=00284581'),
  ('nubc',    'NUBC UB-04 Manual — https://www.nubc.org'),
  ('behave',  'Behave Health HCPCS Glossary — https://behavehealth.com/glossary/hcpcs-codes')
),
seed(code_type, code, short_label, long_description, prior_description, cite_keys, provenance, description_conflict) as (values
  -- ── A. Procedure-slot values observed live (27) — per-code descriptors, static text as prior ──
  ('HCPCS', 'H0018', 'BH short-term residential (non-hospital), per diem',
     'Behavioral health; short-term residential (non-hospital residential treatment program), without room and board, per diem.',
     null::text, array[]::text[], 'alec-seed-2026-09-08', false),
  ('OTHER', '—', 'No procedure code reported',
     'CMD emits a literal em dash (U+2014) in the procedure-code slot when the charge line carries no HCPCS/CPT. A data-quality marker, not a code. Observed on both tenants (BXR 2,359 charges / Indigo 5,172, trailing 180 days at 2026-09-08).',
     null, array[]::text[], 'alec-seed-2026-09-08', false),
  ('HCPCS', 'H2018', 'Psychosocial rehabilitation services, per diem',
     'Psychosocial rehabilitation services, per diem.',
     null, array[]::text[], 'alec-seed-2026-09-08', false),
  ('HCPCS', 'S9480', 'Intensive outpatient psychiatric services, per diem',
     'Intensive outpatient psychiatric services, per diem.',
     'Intensive Outpatient Program (IOP) — rev 0905/0906 with H0015, H0035, S9480.', array['novitas'], 'alec-seed-2026-09-08', false),
  ('HCPCS', 'H0017', 'BH residential (hospital), w/o room & board, per diem',
     'Behavioral health; residential (hospital residential treatment program), without room and board, per diem.',
     null, array[]::text[], 'alec-seed-2026-09-08', false),
  ('CPT', '99499', 'Unlisted evaluation & management service',
     'Unlisted evaluation and management service.',
     null, array[]::text[], 'alec-seed-2026-09-08', false),
  ('HCPCS', 'H0019', 'BH long-term residential (non-medical), per diem',
     'Behavioral health; long-term residential (non-medical, non-acute care in a residential treatment program where stay is typically longer than 30 days), without room and board, per diem.',
     null, array[]::text[], 'alec-seed-2026-09-08', false),
  ('HCPCS', 'H0035', 'Mental health partial hospitalization, < 24 hrs',
     'Mental health partial hospitalization, treatment, less than 24 hours.',
     'PHP Per Diem — Non-Medicare Payers (rev 0912 = less intensive PHP; 0913 = intensive PHP; pair with bill type 131 on UB-04). Also listed under Intensive Outpatient Program (rev 0905/0906).',
     array['ensora', 'novitas'], 'alec-seed-2026-09-08', false),
  ('HCPCS', 'H2020', 'Therapeutic behavioral services, per diem',
     'Therapeutic behavioral services, per diem.',
     null, array[]::text[], 'alec-seed-2026-09-08', false),
  ('HCPCS', 'H2013', 'Psychiatric health facility service, per diem',
     'Psychiatric health facility service, per diem.',
     null, array[]::text[], 'alec-seed-2026-09-08', false),
  ('HCPCS', 'H0015', 'Alcohol/drug intensive outpatient, per diem',
     'Alcohol and/or drug services; intensive outpatient (treatment program that operates at least 3 hours/day and at least 3 days/week and is based on an individualized treatment plan), including assessment, counseling, crisis intervention, and activity therapies or education.',
     'Intensive Outpatient Program (IOP) — rev 0905/0906 with H0015, H0035, S9480.', array['novitas'], 'alec-seed-2026-09-08', false),
  ('HCPCS', 'H0010', 'Alcohol/drug sub-acute detoxification, residential',
     'Alcohol and/or drug services; sub-acute detoxification (residential addiction program inpatient).',
     'Detoxification Services (ASAM 3.7 / 4.0) — IP Detox, rev 0126, alongside H0008.', array['behave'], 'alec-seed-2026-09-08', false),
  ('HCPCS', 'S0201', 'Partial hospitalization services, per diem',
     'Partial hospitalization services, less than 24 hours, per diem.',
     null, array[]::text[], 'alec-seed-2026-09-08', false),
  ('CPT', '90853', 'Group psychotherapy',
     'Group psychotherapy (other than of a multiple-family group). Absent from the 2026-06-18 static reference''s Group Psychotherapy row (G0410, G0411, 90849) despite being the second-highest-volume group code live (3,814 charges, trailing 180 days at 2026-09-08) — the gap that made the static set a corroborating source, not a source of truth.',
     null, array[]::text[], 'alec-seed-2026-09-08', false),
  ('HCPCS', 'H2001', 'Rehabilitation program, per 1/2 day',
     'Rehabilitation program, per 1/2 day.',
     null, array[]::text[], 'alec-seed-2026-09-08', false),
  ('HCPCS', 'H2012', 'Behavioral health day treatment, per hour',
     'Behavioral health day treatment, per hour.',
     null, array[]::text[], 'alec-seed-2026-09-08', false),
  ('HCPCS', 'H2019', 'Therapeutic behavioral services, per 15 min',
     'Therapeutic behavioral services, per 15 minutes.',
     null, array[]::text[], 'alec-seed-2026-09-08', false),
  ('CPT', '90837', 'Psychotherapy, 60 min with patient',
     'Psychotherapy, 60 minutes with patient.',
     'Individual Psychotherapy (PHP/OP, rev 0914) / Individual Therapy (IOP, rev 0914) — same individual therapy codes apply at IOP level of care.',
     array['ensora', 'novitas'], 'alec-seed-2026-09-08', false),
  ('HCPCS', 'H0011', 'Alcohol/drug acute detoxification, residential',
     'Alcohol and/or drug services; acute detoxification (residential addiction program inpatient).',
     null, array[]::text[], 'alec-seed-2026-09-08', false),
  ('HCPCS', 'H2036', 'Alcohol/drug treatment program, per diem',
     'Alcohol and/or other drug treatment program, per diem.',
     null, array[]::text[], 'alec-seed-2026-09-08', false),
  ('CPT', '90791', 'Psychiatric diagnostic evaluation',
     'Psychiatric diagnostic evaluation (no medical services).',
     'BH Assessment / Intake (PHP/OP, rev 0900) — required on same claim line; repeat rev code per HCPCS if multiple.',
     array['cms_php'], 'alec-seed-2026-09-08', false),
  ('CPT', '90834', 'Psychotherapy, 45 min with patient',
     'Psychotherapy, 45 minutes with patient.',
     'Individual Psychotherapy (PHP/OP, rev 0914) / Individual Therapy (IOP, rev 0914) — same individual therapy codes apply at IOP level of care.',
     array['ensora', 'novitas'], 'alec-seed-2026-09-08', false),
  -- ⚠ THE ONE CONFLICT — held open by ruling. Descriptor vs payer adjudication; both may be true.
  ('HCPCS', 'S9475', 'Ambulatory setting detoxification, per diem',
     'Ambulatory setting substance abuse treatment or detoxification services, per diem.',
     'PHP Per Diem — Non-Medicare Payers (rev 0912 = less intensive PHP; 0913 = intensive PHP; pair with bill type 131 on UB-04).',
     array['ensora'], 'alec-seed-2026-09-08', true),
  ('CPT', '90832', 'Psychotherapy, 30 min with patient',
     'Psychotherapy, 30 minutes with patient.',
     'Individual Psychotherapy (PHP/OP, rev 0914) / Individual Therapy (IOP, rev 0914) — same individual therapy codes apply at IOP level of care.',
     array['ensora', 'novitas'], 'alec-seed-2026-09-08', false),
  ('CPT', '90847', 'Family psychotherapy with patient present',
     'Family psychotherapy (conjoint psychotherapy) (with patient present), 50 minutes.',
     'Family Psychotherapy (PHP/OP, rev 0916; 90846 = without patient; 90847 = with patient) / Family Therapy (IOP, rev 0916).',
     array['ensora', 'novitas'], 'alec-seed-2026-09-08', false),
  ('OTHER', 'INTRST', 'Interest posting — not clinical',
     'Interest / finance-charge posting that CMD emits in the procedure-code slot. Not a clinical service; exclude from clinical yield reads. BXR only.',
     null, array[]::text[], 'alec-seed-2026-09-08', false),
  ('OTHER', 'INT', 'Interest posting — not clinical',
     'Interest / finance-charge posting that CMD emits in the procedure-code slot. Not a clinical service; exclude from clinical yield reads. BXR only.',
     null, array[]::text[], 'alec-seed-2026-09-08', false),

  -- ── B. Procedure codes carried from the static dataset, not observed live (32) ──
  ('CPT', '90792', 'BH Assessment / Intake',
     'PHP/OP with rev 0900 (BH Assessment / Intake). Required on same claim line; repeat rev code per HCPCS if multiple.',
     null, array['cms_php'], 'code-reference-static-2026-06-18', false),
  ('CPT', '97153', 'ABA Therapy (Applied Behavior Analysis)', 'PHP/OP with rev 0900. Added Dec 2025 expansion; verify payer coverage.', null, array['cms_php'], 'code-reference-static-2026-06-18', false),
  ('CPT', '97154', 'ABA Therapy (Applied Behavior Analysis)', 'PHP/OP with rev 0900. Added Dec 2025 expansion; verify payer coverage.', null, array['cms_php'], 'code-reference-static-2026-06-18', false),
  ('CPT', '97155', 'ABA Therapy (Applied Behavior Analysis)', 'PHP/OP with rev 0900. Added Dec 2025 expansion; verify payer coverage.', null, array['cms_php'], 'code-reference-static-2026-06-18', false),
  ('CPT', '97156', 'ABA Therapy (Applied Behavior Analysis)', 'PHP/OP with rev 0900. Added Dec 2025 expansion; verify payer coverage.', null, array['cms_php'], 'code-reference-static-2026-06-18', false),
  ('CPT', '97157', 'ABA Therapy (Applied Behavior Analysis)', 'PHP/OP with rev 0900. Added Dec 2025 expansion; verify payer coverage.', null, array['cms_php'], 'code-reference-static-2026-06-18', false),
  ('CPT', '97158', 'ABA Therapy (Applied Behavior Analysis)', 'PHP/OP with rev 0900. Added Dec 2025 expansion; verify payer coverage.', null, array['cms_php'], 'code-reference-static-2026-06-18', false),
  ('CPT', '90785', 'Individual Psychotherapy — interactive complexity add-on',
     'PHP/OP with rev 0914. 90785 is an add-on code for interactive complexity; use with a primary procedure.',
     null, array['ensora'], 'code-reference-static-2026-06-18', false),
  ('CPT', '90833', 'Individual Psychotherapy', 'PHP/OP with rev 0914 (Individual Psychotherapy group).', null, array['ensora'], 'code-reference-static-2026-06-18', false),
  ('CPT', '90836', 'Individual Psychotherapy', 'PHP/OP with rev 0914 (Individual Psychotherapy group).', null, array['ensora'], 'code-reference-static-2026-06-18', false),
  ('CPT', '90838', 'Individual Psychotherapy', 'PHP/OP with rev 0914 (Individual Psychotherapy group).', null, array['ensora'], 'code-reference-static-2026-06-18', false),
  ('CPT', '90839', 'Individual Psychotherapy', 'PHP/OP with rev 0914 (Individual Psychotherapy group).', null, array['ensora'], 'code-reference-static-2026-06-18', false),
  ('CPT', '90840', 'Individual Psychotherapy', 'PHP/OP with rev 0914 (Individual Psychotherapy group).', null, array['ensora'], 'code-reference-static-2026-06-18', false),
  ('CPT', '90845', 'Individual Psychotherapy', 'PHP/OP with rev 0914 (Individual Psychotherapy group).', null, array['ensora'], 'code-reference-static-2026-06-18', false),
  ('CPT', '90865', 'Individual Psychotherapy', 'PHP/OP with rev 0914 (Individual Psychotherapy group).', null, array['ensora'], 'code-reference-static-2026-06-18', false),
  ('CPT', '90880', 'Individual Psychotherapy', 'PHP/OP with rev 0914 (Individual Psychotherapy group).', null, array['ensora'], 'code-reference-static-2026-06-18', false),
  ('CPT', '90899', 'Individual Psychotherapy', 'PHP/OP with rev 0914 (Individual Psychotherapy group).', null, array['ensora'], 'code-reference-static-2026-06-18', false),
  ('CPT', '90849', 'Group Psychotherapy', 'PHP/OP with rev 0915 (Group Psychotherapy group).', null, array['cms_php'], 'code-reference-static-2026-06-18', false),
  ('CPT', '90846', 'Family Psychotherapy — without patient present',
     'PHP/OP and IOP with rev 0916. 90846 = without patient; 90847 = with patient.',
     null, array['ensora', 'novitas'], 'code-reference-static-2026-06-18', false),
  ('CPT', '96100', 'Psychiatric / Neuropsychological Testing', 'PHP/OP with rev 0918.', null, array['ensora'], 'code-reference-static-2026-06-18', false),
  ('CPT', '96112', 'Psychiatric / Neuropsychological Testing', 'PHP/OP with rev 0918.', null, array['ensora'], 'code-reference-static-2026-06-18', false),
  ('CPT', '96113', 'Psychiatric / Neuropsychological Testing', 'PHP/OP with rev 0918.', null, array['ensora'], 'code-reference-static-2026-06-18', false),
  ('CPT', '96115', 'Psychiatric / Neuropsychological Testing', 'PHP/OP with rev 0918.', null, array['ensora'], 'code-reference-static-2026-06-18', false),
  ('CPT', '96116', 'Psychiatric / Neuropsychological Testing', 'PHP/OP with rev 0918; also Behavioral Health Testing at IOP level of care.', null, array['ensora', 'novitas'], 'code-reference-static-2026-06-18', false),
  ('CPT', '96117', 'Psychiatric / Neuropsychological Testing', 'PHP/OP with rev 0918.', null, array['ensora'], 'code-reference-static-2026-06-18', false),
  ('CPT', '96121', 'Psychiatric / Neuropsychological Testing', 'PHP/OP with rev 0918; also Behavioral Health Testing at IOP level of care.', null, array['ensora', 'novitas'], 'code-reference-static-2026-06-18', false),
  ('HCPCS', 'G0410', 'Group Psychotherapy', 'PHP/OP with rev 0915; same group codes used in IOP as PHP.', null, array['cms_php', 'novitas'], 'code-reference-static-2026-06-18', false),
  ('HCPCS', 'G0411', 'Group Psychotherapy', 'PHP/OP with rev 0915; same group codes used in IOP as PHP.', null, array['cms_php', 'novitas'], 'code-reference-static-2026-06-18', false),
  ('HCPCS', 'G0129', 'Occupational Therapy',
     'PHP/OP with rev 043X. G0129 = OT by a qualified OT, per 45-min session; only bill under PHP.',
     null, array['a01111'], 'code-reference-static-2026-06-18', false),
  ('HCPCS', 'G0176', 'Activity Therapy (music, dance, art, play)', 'PHP/OP with rev 0904.', null, array['a01111'], 'code-reference-static-2026-06-18', false),
  ('HCPCS', 'G0177', 'Patient Education / Training for Psychiatric Purposes', 'PHP/OP with rev 0942.', null, array['a01111'], 'code-reference-static-2026-06-18', false),
  ('HCPCS', 'H0008', 'Detoxification Services (ASAM 3.7 / 4.0)', 'IP Detox with rev 0126, alongside H0010.', null, array['behave'], 'code-reference-static-2026-06-18', false),

  -- ── C. Revenue codes observed live (22) — per-code descriptors, static text as prior ──
  ('REV', '0905', 'BH treatment/services — intensive outpatient, psychiatric',
     'Behavioral health treatments/services — intensive outpatient services, psychiatric.',
     'Intensive Outpatient Program (IOP) — rev 0905/0906 with H0015, H0035, S9480.', array['novitas'], 'alec-seed-2026-09-08', false),
  ('REV', '1001', 'BH accommodations — residential treatment, psychiatric',
     'Behavioral health accommodations — residential treatment, psychiatric.',
     null, array[]::text[], 'alec-seed-2026-09-08', false),
  ('REV', '0913', 'BH treatment/services — partial hospitalization, intensive',
     'Behavioral health treatments/services — partial hospitalization, intensive.',
     'PHP Per Diem — Non-Medicare Payers: 0913 = intensive PHP; pair with bill type 131 on UB-04.', array['ensora'], 'alec-seed-2026-09-08', false),
  ('REV', '0158', 'Room & board, ward — rehabilitation',
     'Room and board, ward (medical or general) — rehabilitation.',
     null, array[]::text[], 'alec-seed-2026-09-08', false),
  ('REV', '1002', 'BH accommodations — residential treatment, chemical dependency',
     'Behavioral health accommodations — residential treatment, chemical dependency.',
     'Residential Treatment Center (RTC) — rev 1000/1002; HCPCS varies by payer.', array['nubc'], 'alec-seed-2026-09-08', false),
  ('REV', '0906', 'BH treatment/services — intensive outpatient, chemical dependency',
     'Behavioral health treatments/services — intensive outpatient services, chemical dependency.',
     'Intensive Outpatient Program (IOP) — rev 0905/0906 with H0015, H0035, S9480.', array['novitas'], 'alec-seed-2026-09-08', false),
  ('REV', '0126', 'Room & board, semi-private 2-bed — detoxification',
     'Room and board, semi-private two-bed — detoxification.',
     'Detoxification Services (ASAM 3.7 / 4.0) — IP Detox with H0008, H0010.', array['behave'], 'alec-seed-2026-09-08', false),
  ('REV', '0915', 'BH treatment/services — group therapy',
     'Behavioral health treatments/services — group therapy.',
     'Group Psychotherapy (PHP/OP: G0410, G0411, 90849) / Group Therapy (IOP: G0410, G0411).', array['cms_php', 'novitas'], 'alec-seed-2026-09-08', false),
  ('REV', '0100', 'All-inclusive room & board',
     'All-inclusive rate — room and board plus ancillary.',
     null, array[]::text[], 'alec-seed-2026-09-08', false),
  ('REV', '0124', 'Room & board, semi-private 2-bed — psychiatric',
     'Room and board, semi-private two-bed — psychiatric.',
     'Inpatient Psychiatric — All-Inclusive Per Diem (rev 0114/0124; per diem, no line-level HCPCS required).', array['nubc'], 'alec-seed-2026-09-08', false),
  ('REV', '0912', 'BH treatment/services — partial hospitalization, less intensive',
     'Behavioral health treatments/services — partial hospitalization, less intensive.',
     'PHP Per Diem — Non-Medicare Payers: 0912 = less intensive PHP; pair with bill type 131 on UB-04.', array['ensora'], 'alec-seed-2026-09-08', false),
  ('REV', '0128', 'Room & board, semi-private 2-bed — rehabilitation',
     'Room and board, semi-private two-bed — rehabilitation.',
     null, array[]::text[], 'alec-seed-2026-09-08', false),
  ('REV', '0907', 'BH treatment/services — community behavioral health day treatment',
     'Behavioral health treatments/services — community behavioral health program (day treatment).',
     null, array[]::text[], 'alec-seed-2026-09-08', false),
  ('REV', '0914', 'BH treatment/services — individual therapy',
     'Behavioral health treatments/services — individual therapy.',
     'Individual Psychotherapy (PHP/OP) / Individual Therapy (IOP).', array['ensora', 'novitas'], 'alec-seed-2026-09-08', false),
  ('REV', '0911', 'BH treatment/services — rehabilitation',
     'Behavioral health treatments/services — rehabilitation.',
     null, array[]::text[], 'alec-seed-2026-09-08', false),
  ('REV', '1000', 'BH accommodations — residential treatment, general',
     'Behavioral health accommodations — residential treatment, general classification.',
     'Residential Treatment Center (RTC) — rev 1000/1002; HCPCS varies by payer.', array['nubc'], 'alec-seed-2026-09-08', false),
  ('REV', '0918', 'BH treatment/services — testing',
     'Behavioral health treatments/services — testing.',
     'Psychiatric / Neuropsychological Testing (PHP/OP) / Behavioral Health Testing (IOP).', array['ensora', 'novitas'], 'alec-seed-2026-09-08', false),
  ('REV', '0156', 'Room & board, ward — detoxification',
     'Room and board, ward — detoxification.',
     null, array[]::text[], 'alec-seed-2026-09-08', false),
  ('REV', '0154', 'Room & board, ward — psychiatric',
     'Room and board, ward — psychiatric.',
     null, array[]::text[], 'alec-seed-2026-09-08', false),
  ('REV', '0900', 'BH treatment/services — general',
     'Behavioral health treatments/services — general classification.',
     'BH Assessment / Intake (90791, 90792); ABA Therapy (97153–97158).', array['cms_php'], 'alec-seed-2026-09-08', false),
  ('REV', '0916', 'BH treatment/services — family therapy',
     'Behavioral health treatments/services — family therapy.',
     'Family Psychotherapy (PHP/OP) / Family Therapy (IOP) — 90846, 90847.', array['ensora', 'novitas'], 'alec-seed-2026-09-08', false),
  ('REV', '0101', 'All-inclusive room & board, alternate',
     'All-inclusive rate — room and board only.',
     null, array[]::text[], 'alec-seed-2026-09-08', false),

  -- ── D. Revenue codes carried from the static dataset, not observed live (4) ──
  ('REV', '0114', 'Inpatient Psychiatric — All-Inclusive Per Diem', 'IP Psych with rev 0124; per diem — no line-level HCPCS required.', null, array['nubc'], 'code-reference-static-2026-06-18', false),
  ('REV', '0904', 'Activity Therapy (music, dance, art, play)', 'PHP/OP with G0176.', null, array['a01111'], 'code-reference-static-2026-06-18', false),
  ('REV', '0942', 'Patient Education / Training for Psychiatric Purposes', 'PHP/OP with G0177.', null, array['a01111'], 'code-reference-static-2026-06-18', false),
  ('REV', '043X', 'Occupational Therapy',
     'Revenue code RANGE placeholder as carried by the static reference (043X = 0430–0439). PHP/OP with G0129; only bill under PHP.',
     null, array['a01111'], 'code-reference-static-2026-06-18', false)
)
insert into ref.code_description
  (code_type, code, short_label, long_description, prior_description, source_citation, provenance, needs_review, description_conflict)
select
  s.code_type, s.code, s.short_label, s.long_description, s.prior_description,
  (select string_agg(c.txt, ' | ' order by c.txt) from cite c where c.key = any(s.cite_keys)),
  s.provenance,
  true,                       -- EVERY row ships needs_review = true (Ruling 2)
  s.description_conflict
from seed s
on conflict on constraint code_description_code_uniq do nothing;

reset role;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 4. Verification (run manually after apply)
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- -- (a) 85 rows, all unreviewed, exactly one conflict, all global:
-- select count(*) as rows, count(*) filter (where needs_review) as unreviewed,
--        count(*) filter (where description_conflict) as conflicts,
--        count(*) filter (where business_entity_id is null) as global_rows
--   from ref.code_description;
-- -- expect: 85 | 85 | 1 | 85
--
-- -- (b) type split matches the CODE_TYPE RULE:
-- select code_type, count(*) from ref.code_description group by 1 order by 1;
-- -- expect: CPT 33 | HCPCS 23 | OTHER 3 | REV 26   (27 live proc = 7 CPT + 17 HCPCS + 3 OTHER;
-- --         32 static proc = 26 CPT + 6 HCPCS; 22 + 4 REV)
--
-- -- (c) the one conflict is S9475 and carries both texts:
-- select code, short_label, prior_description from ref.code_description where description_conflict;
--
-- -- (d) every live procedure-slot value resolves (join the trailing-180d rollup to the table).
-- --     ⚠ REVIEWED CROSS-TENANT EXCEPTION, deliberate (Qodo #346 rule finding 2): this check carries
-- --     NO business_entity_id predicate because it verifies that the GLOBAL fallback rows
-- --     (business_entity_id IS NULL) cover every procedure code billed by ANY tenant — a per-tenant
-- --     read cannot answer that question. It reads procedure CODES only (no PHI), runs once as an
-- --     operator post-apply check, and is never on the app path: the app reads descriptions through
-- --     buildCodeDescriptionQuery, which is tenant-scoped. Comment-only; the applied DDL is unchanged.
-- with live as (
--   select distinct regexp_replace(nullif(btrim(cpt_code),''),'(IOP|PHP|RTC|UHC)$','') as hcpcs
--     from collections.cmd_explorer_charge_rollup
--    where charge_date >= (now() at time zone 'America/Los_Angeles')::date - 180)
-- select l.hcpcs from live l left join ref.code_description d
--   on d.code = l.hcpcs and d.code_type in ('CPT','HCPCS','OTHER') and d.business_entity_id is null
--  where l.hcpcs is not null and d.code is null;
-- -- expect: 0 rows
--
-- -- (e) posture — owner, RLS, reader grant, no writer:
-- select relowner::regrole, relrowsecurity from pg_class where oid = 'ref.code_description'::regclass;
-- select policyname, cmd, roles from pg_policies where schemaname='ref' and tablename='code_description';
-- select has_table_privilege('claims_reader','ref.code_description','SELECT') as reader_select,
--        has_table_privilege('claims_reader','ref.code_description','INSERT') as reader_insert;
-- -- expect: claims_admin | t ; code_description_read_all SELECT {public} ; t | f
--
-- -- (f) the standing operator grant SURVIVED (no revoke tail in this file):
-- select pg_has_role('postgres','claims_admin','SET');
-- -- expect: t
