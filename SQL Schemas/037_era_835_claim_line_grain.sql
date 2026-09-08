-- ============================================================================================
-- Veris 037 — 835 CLAIM and SERVICE-LINE grain.  ADDITIVE.  NOT APPLIED.
--
-- NUMBER derived from the LIVE LEDGER (supabase_migrations.schema_migrations), where the max
-- Veris entry is 036_rule_payer_alias_rowcount_assert @ 20260907063039. A file listing is not
-- the number — the 0096 collision (2026-08-10) was caught exactly here. All four worktrees were
-- checked for untracked .sql and no 037 exists on any ref. 030/031 remain authored-not-applied
-- and are NOT free slots (031 is deliberately parked, CLAUDE.md), so 037 is next and does not
-- backfill the gap.
--
-- ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
-- The app models 835s at payment grain (BPR) and CAS-triplet grain, and NOTHING in between. A
-- remit with no adjustment lands as a payment row with no detail, and its service lines are
-- never represented at all. era_ingest.ts:446-457 builds `lineFields` and then DISCARDS it when
-- sl.adjustments is empty — the line is parsed and thrown away.
--
-- Measured against the 4,004-file 835 corpus, 2026-09-07:
--     6,676 service lines / $14,381,289.67 paid  carry NO line-level CAS  (6.67% of 100,160)
--     5,829 claims        / $13,743,226.52 paid  carry NO CAS at all      (6.39%)
--     only 47 of those 6,676 are recoverable through a claim-level adjustment — 99.3% are
--     dropped outright.
-- The charge≈paid ratio on that population (14,435,117 charged vs 14,381,289 paid, 99.6%) is
-- the signature of clean-paid lines, which is exactly why they carry no CAS and exactly why the
-- current grain cannot see them.
--
-- ⚠ The older "$788K" figure is RETIRED. It named the PAYMENT-grain gap that 013 already closed
--   and is not this defect.
--
-- ⚠ SCHEMA ONLY. The emission change to era_ingest.ts is a SEPARATE PR — schema first.
-- ⚠ NOT APPLIED. Applying is a separate ruling.
--
-- ⚠ THIS IS NOT staging.claim_line. That table ALREADY EXISTS (73 columns, ~150,900 rows) and is
--   the BILLED side — CMD charge detail and the Veris ML training grain, carrying
--   charge_debit_id, tob_*, fee_schedule_applied, is_training_eligible. era_835_adjustment
--   .claim_line_id already FKs to it. The two tables below are the REMITTED side. They are
--   complements, not duplicates, which is why they keep the era_835_ prefix.
-- ============================================================================================

-- ⚠ `SET ROLE claims_admin` IS REQUIRED HERE, and an earlier draft of this file wrongly omitted
-- it — the same mistake 013's own header records making (013:105-110). apply_migration runs as
-- postgres; without the SET ROLE both tables are born owned by POSTGRES, which leaves them
-- outside the ownership census every later staging migration assumes and breaks 017's
-- FORCE-RLS/owner-bypass posture. staging.* is claims_admin-owned (verified live: relowner =
-- claims_admin on all three era_835_* tables).
--
-- ⚠ DO NOT generalise CLAUDE.md's "a SET ROLE downgrades the applier and 42501s" note to here.
-- That rule is `collections`-plane ONLY, where objects are postgres-owned (0084/0085). The
-- `staging` and `claims` planes are the opposite and REQUIRE the SET ROLE.
--
-- Structure mirrors 013 exactly: DDL + policies INSIDE the SET ROLE block so they are born
-- claims_admin-owned; GRANTs run as postgres OUTSIDE it, which is the proven-applied grant path
-- in this cluster (013 mirrors 019).

set role claims_admin;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 1. staging.era_835_claim — one row per CLP loop (Loop 2100)
-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Surrogate ids are only tenant-safe when paired with the tenant key.  These supporting
-- uniqueness constraints make the composite FKs below enforce that invariant.
create unique index if not exists era_835_payment_entity_id
  on staging.era_835_payment (business_entity_id, id);

create table if not exists staging.era_835_claim (
  id                             bigint generated always as identity primary key,

  -- Tenant column, and the LEADING column of every non-FK index below. uuid NOT NULL, FK to
  -- core.business_entity with ON DELETE RESTRICT — never CASCADE: a tenant row must not be
  -- deletable out from under remittance history. Copied from era_835_payment/adjustment.
  business_entity_id             uuid not null
                                   references core.business_entity(id) on delete restrict,

  payment_id                     bigint not null,

    -- Tenant-qualified remit relationship; the payment must belong to this claim's tenant.
    constraint era_835_claim_payment_fk
      foreign key (business_entity_id, payment_id)
      references staging.era_835_payment(business_entity_id, id) on delete restrict,

  facility_code                  text not null check (char_length(facility_code) <= 50),
  cmd_customer_id                text not null check (char_length(cmd_customer_id) <= 50),

  -- Position of this CLP within the transaction set. Mirrors era_835_adjustment.adjustment_index
  -- and .service_line_number: an integer defaulting to 0, so the fingerprint stays total even
  -- when the payer supplies neither control number.
  claim_index                    integer not null default 0,

  -- ── CLP01..CLP07, verbatim from Era835Claim (era835Parser.ts:60-81). ──────────────────────
  patient_control_number         text check (char_length(patient_control_number) <= 50),    -- CLP01
  claim_status_code              text check (char_length(claim_status_code) <= 5),          -- CLP02
  claim_charge_amount            numeric(12,2),                                             -- CLP03
  claim_paid_amount              numeric(12,2),                                             -- CLP04
  patient_responsibility_amount  numeric(12,2),                                             -- CLP05
  claim_filing_indicator         text check (char_length(claim_filing_indicator) <= 5),     -- CLP06
  payer_claim_control_number     text check (char_length(payer_claim_control_number) <= 50),-- CLP07

  -- ST02. STORED, NEVER HASHED — see the fingerprint note below. Matches era_835_adjustment,
  -- which also carries the column and also keeps it out of its hash.
  era_control_number             text check (char_length(era_control_number) <= 50),

  -- ── PHI. Types copied byte for byte from era_835_adjustment (verified live 2026-09-08). ───
  -- libsodium secretbox (nonce‖ct) via src/collections/phiCrypto.ts, encrypted ONLY at the
  -- INSERT boundary — no plaintext PHI reaches the database. NM1*QC and NM1*IL.
  patient_name_enc               bytea,
  member_id_enc                  bytea,

  -- ⚠ THE JOIN KEY IS THIS COLUMN, NEVER member_id_enc. secretbox uses a RANDOM NONCE, so two
  -- encryptions of the same member id differ byte for byte and can never be equality-joined.
  -- The blind index is a SEPARATE keyed-HMAC column (INDEX_HMAC_KEY). Same split that
  -- era_835_adjustment.member_id_bidx already uses.
  --
  -- ⚠ MINT VIA src/collections/blindIndex.ts, WHICH IMPORTS ./normalize.js — the COLLECTIONS
  -- normalizeMemberId, NEVER src/normalize.ts. The two differ: collections strips ALL internal
  -- whitespace and ALL leading hyphens (/\s+/g, /^-+/) and maps '' to null; the root strips
  -- neither internal whitespace nor more than one hyphen. Measured on 5,000 live member ids on
  -- 2026-09-07, 2 diverge — 0.04%. The failure is SILENT: no error, no exception, just a token
  -- that joins nothing. The emission PR must carry a byte-match pin test against a stored bidx.
  member_id_bidx                 text,

  era_source_file                text check (char_length(era_source_file) <= 200),
  source                         text not null default 'cmd_835_api'
                                   check (char_length(source) <= 30),

  -- ── THE NATURAL KEY ───────────────────────────────────────────────────────────────────────
  -- SHA-256 over NON-PHI natural keys computed BEFORE encryption — the era_ingest.ts:26
  -- contract, and the same text NOT NULL UNIQUE shape both sibling tables already use.
  --
  -- RECIPE (7), modelled on era835Fingerprint (era_ingest.ts:208), which is the CHILD-grain
  -- precedent. Every ingredient is stable across a CMD re-download:
  --   1 cmd_customer_id             our roster constant; never parsed from the EDI
  --   2 payer_claim_control_number  CLP07, the payer's ICN/DCN, fixed at adjudication
  --   3 patient_control_number      CLP01, our own 837 claim id echoed back
  --   4 claim_index                 CLP position; stable under the SAME ordering assumption
  --                                 013 already makes for ST02 — adds no new fragility
  --   5 claim_charge_amount         CLP03, adjudicated money, NORMALISED fixed-2 (not raw text:
  --                                 013 records payment_amount_raw as fragile because '100.0'
  --                                 and '100.00' are the same money and different bytes)
  --   6 claim_paid_amount           CLP04, same
  --   7 payment_date                BPR16; era835Fingerprint ingredient 15 already rests on it
  --
  -- DELIBERATELY EXCLUDED:
  --   · era_source_file — CMD regenerates the archive per request, so the same remit can arrive
  --     under a different filename; hashing it mints a NEW fingerprint on re-download, ON
  --     CONFLICT DO NOTHING misses, and the row duplicates. 013:149 already closed this back
  --     door and NEITHER live recipe includes it.
  --   · era_control_number (ST02) — era835PaymentFingerprint DOES include it, to separate two
  --     transaction sets co-located in one interchange. But era835Fingerprint, the CHILD-grain
  --     recipe, does NOT: at child grain (CLP07, CLP01) already identifies the claim, and ST02
  --     is a per-file sequence that CMD can re-assign. These tables are child grain, so they
  --     follow the child precedent. Stored above, never hashed.
  --
  -- ⚠ NOT (cmd_customer_id, claim_id). That key is DB 2's, where claim_id was a synthetic
  --   per-file id minted by parse835.ts and collided across 12,491 keys in a per-customer
  --   namespace. Era835Claim has no claim_id field at all. Adding one to mirror the other
  --   codebase would import a defect this schema does not have. RULED 2026-09-08.
  --
  -- ⚠ Changing the ingredient set or ORDER silently breaks dedup and requires a full re-ingest
  --   (the warning era_ingest.ts:292 already carries).
  row_fingerprint                text not null unique,

  ingested_at                    timestamptz not null default now(),
  ingested_by                    text not null check (char_length(ingested_by) <= 100)
);

  create unique index if not exists era_835_claim_entity_id_payment
    on staging.era_835_claim (business_entity_id, id, payment_id);

-- ── business_entity_id LEADS every non-FK index, shown rather than asserted. ────────────────
-- The RLS policy below filters on business_entity_id before anything else, so an index that
-- does not lead with it cannot serve the policy's own predicate. The FK-only indexes are the
-- deliberate exception and match era_835_payment_id / era_835_claim_line on the sibling table:
-- point lookups by surrogate id, carrying no tenant predicate.
create index if not exists era_835_claim_payment         on staging.era_835_claim (payment_id);
create index if not exists era_835_claim_facility_entity on staging.era_835_claim (business_entity_id, facility_code);
create index if not exists era_835_claim_patient_control on staging.era_835_claim (business_entity_id, patient_control_number);
create index if not exists era_835_claim_payer_control   on staging.era_835_claim (business_entity_id, payer_claim_control_number);
create index if not exists era_835_claim_member_bidx     on staging.era_835_claim (business_entity_id, member_id_bidx);

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 2. staging.era_835_service_line — one row per SVC loop (Loop 2110)
-- ════════════════════════════════════════════════════════════════════════════════════════════
create table if not exists staging.era_835_service_line (
  id                       bigint generated always as identity primary key,
  business_entity_id       uuid not null
                             references core.business_entity(id) on delete restrict,

  -- ⚠ claim_id here is a BIGINT SURROGATE pointing at staging.era_835_claim above. It is NOT
  -- DB 2's text claim_id, and NOT staging.claim_line. Naming follows the sibling convention
  -- (era_835_adjustment.payment_id → era_835_payment.id).
  claim_id                 bigint not null,

    -- Tenant-qualified and payment-consistent parent relationship.
    constraint era_835_line_claim_fk
      foreign key (business_entity_id, claim_id, payment_id)
      references staging.era_835_claim(business_entity_id, id, payment_id) on delete restrict,
                             
  -- Denormalised the way era_835_adjustment carries payment_id directly: a line must be
  -- attributable to its remit without a two-hop join, and the ingest already holds the id.
  payment_id               bigint not null,

    constraint era_835_line_payment_fk
      foreign key (business_entity_id, payment_id)
      references staging.era_835_payment(business_entity_id, id) on delete restrict,
                             
  facility_code            text not null check (char_length(facility_code) <= 50),
  cmd_customer_id          text not null check (char_length(cmd_customer_id) <= 50),
  claim_index              integer not null default 0,

  -- ── SVC, verbatim from Era835ServiceLine (era835Parser.ts:39-57). ─────────────────────────
  service_line_number      integer not null default 0,                                     -- position
  procedure_code           text check (char_length(procedure_code) <= 50),                 -- SVC01
  line_charge_amount       numeric(12,2),                                                  -- SVC02
  line_paid_amount         numeric(12,2),                                                  -- SVC03
  line_units               numeric(12,2),                                                  -- SVC05
  service_date             date,                                                           -- DTM*472
  line_item_control_number text check (char_length(line_item_control_number) <= 50),       -- REF*6R

  -- LQ*HE remark (RARC) codes. See the column comment at the foot of this file for the emitter
  -- contract; the CHECK bounds it the way every text column on the sibling tables is bounded.
  remark_codes             text[] check (
                             remark_codes is null
                             or (cardinality(remark_codes) between 1 and 50
                                 and array_position(remark_codes, null) is null)
                           ),

  era_control_number       text check (char_length(era_control_number) <= 50),
  era_source_file          text check (char_length(era_source_file) <= 200),
  source                   text not null default 'cmd_835_api'
                             check (char_length(source) <= 30),

  -- ── THE NATURAL KEY ───────────────────────────────────────────────────────────────────────
  -- RECIPE (8) — literally era835Fingerprint with the CAS-triplet ingredients removed, which is
  -- the correct relationship: an adjustment IS a line plus a triplet. Stability, per ingredient:
  --   1 cmd_customer_id             our roster constant; never parsed from the EDI
  --   2 payer_claim_control_number  CLP07 — ties the line to its claim by NATURAL key, so the
  --                                 line's identity never depends on the parent's surrogate id
  --                                 or on insert order
  --   3 patient_control_number      CLP01, our own 837 claim id echoed back
  --   4 claim_index                 CLP position; disambiguates when both control numbers null
  --   5 service_line_number         SVC position within the claim (era835Fingerprint #4)
  --   6 line_item_control_number    REF*6R, our own 837 service-line id echoed back (#5)
  --   7 procedure_code              SVC01, what was adjudicated (#14)
  --   8 service_date                DTM*472, a clinical fact (#13)
  --   9 payment_id                  remit identity; prevents corrected-remit collisions
--  10 payment_date                remit identity, matching the adjustment precedent
--  11 line_charge_amount          adjudicated line value
--  12 line_paid_amount            adjudicated line value
-- EXCLUDED for the same reasons as the claim table: era_source_file (CMD regenerates the
  -- archive per request) and era_control_number (per-file sequence; the child precedent omits
  -- it). Both are stored columns above.
  row_fingerprint          text not null unique,

  ingested_at              timestamptz not null default now(),
  ingested_by              text not null check (char_length(ingested_by) <= 100)
);

create index if not exists era_835_line_claim     on staging.era_835_service_line (claim_id);
create index if not exists era_835_line_payment   on staging.era_835_service_line (payment_id);
create index if not exists era_835_line_facility  on staging.era_835_service_line (business_entity_id, facility_code, service_date);
create index if not exists era_835_line_procedure on staging.era_835_service_line (business_entity_id, procedure_code);

-- ⚠ PREDICATE IS cardinality(...) > 0, NOT `remark_codes is not null`. An empty array is NOT
-- null, so `is not null` would match a codeless line the moment the emitter writes {} — which
-- is the natural thing to write, since the parser returns string[] and an absent LQ*HE yields
-- []. The index would then cover every row and the saving would be silently zero. Measured:
-- 49,117 of 100,160 lines carry at least one code, so the correct predicate excludes 50,943.
create index if not exists era_835_line_remarks on staging.era_835_service_line
  using gin (remark_codes) where (cardinality(remark_codes) > 0);

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 3. THE WRITER GRANT AND THE RLS POLICY, SIDE BY SIDE.
--
--    A GRANT IS HALF THE GATE. 0089 granted SELECT with no policy and read zero rows for weeks
--    with no error. 0101 granted a column-scoped UPDATE with no policy and matched zero rows,
--    silently, until 0102 added the policy. RLS is enabled below and cmd_rollup_writer is NOT
--    rolbypassrls, so a grant without a policy writes nothing AND RAISES NOTHING.
--
--    THE ROLE IS `cmd_rollup_writer`, NAMED EXPLICITLY. Reads are `claims_reader`. Neither is
--    claims_admin and neither is the Supabase service-role key.
--
--      GRANT (as postgres, after RESET ROLE)      POLICY (here, as claims_admin)
--      ------------------------------------      ------------------------------------------
--      insert            → cmd_rollup_writer     *_writer_insert    INSERT with check <GUC>
--      select(id,row_fp) → cmd_rollup_writer     *_writer_select    SELECT using      <GUC>
--      select            → claims_reader         *_reader_isolation SELECT using      <GUC>
--
--    where <GUC> is business_entity_id = current_setting('app.business_entity_id')::uuid.
--
--    ⚠ WRITER GETS INSERT PLUS A COLUMN-SCOPED SELECT — no UPDATE, no DELETE. Remittance
--      history is append-only. The column-scoped SELECT is NOT a widening: it covers
--      row_fingerprint (and `id` on the claim table) and nothing else, so the writer can
--      arbitrate ON CONFLICT and read back the id it needs for the child FK, while every PHI
--      and money column stays unreadable to it.
--
--    ⚠ THE *_writer_select POLICIES ARE LOAD-BEARING, NOT DECORATION. An earlier draft of this
--      file called them "inert, reproduced for symmetry" — that was WRONG, and it came from
--      reading pg_class.relacl (which shows `cmd_rollup_writer=a`) and missing that column
--      grants live in pg_attribute.attacl. The writer's column-scoped SELECT is real, verified
--      live 2026-09-08, and RLS gates it: without these policies the grant reads zero rows and
--      ON CONFLICT breaks. Grant and policy are both required — that IS the 0089 lesson, applied
--      rather than merely cited.
--
alter table staging.era_835_claim        enable row level security;
alter table staging.era_835_service_line enable row level security;

drop policy if exists era_835_claim_reader_isolation on staging.era_835_claim;
create policy era_835_claim_reader_isolation on staging.era_835_claim
  for select to claims_reader
  using (business_entity_id = (current_setting('app.business_entity_id'))::uuid);

drop policy if exists era_835_claim_writer_insert on staging.era_835_claim;
create policy era_835_claim_writer_insert on staging.era_835_claim
  for insert to cmd_rollup_writer
  with check (business_entity_id = (current_setting('app.business_entity_id'))::uuid);

drop policy if exists era_835_claim_writer_select on staging.era_835_claim;
create policy era_835_claim_writer_select on staging.era_835_claim
  for select to cmd_rollup_writer
  using (business_entity_id = (current_setting('app.business_entity_id'))::uuid);

drop policy if exists era_835_line_reader_isolation on staging.era_835_service_line;
create policy era_835_line_reader_isolation on staging.era_835_service_line
  for select to claims_reader
  using (business_entity_id = (current_setting('app.business_entity_id'))::uuid);

drop policy if exists era_835_line_writer_insert on staging.era_835_service_line;
create policy era_835_line_writer_insert on staging.era_835_service_line
  for insert to cmd_rollup_writer
  with check (business_entity_id = (current_setting('app.business_entity_id'))::uuid);

drop policy if exists era_835_line_writer_select on staging.era_835_service_line;
create policy era_835_line_writer_select on staging.era_835_service_line
  for select to cmd_rollup_writer
  using (business_entity_id = (current_setting('app.business_entity_id'))::uuid);

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 4. THE MONEY-GRAIN CONTRACT — ON THE COLUMNS, NOT IN THIS HEADER.
--
--    This is 013's defect class arriving at a new grain. 013 killed the 10-100x inflation
--    STRUCTURALLY, by making payment_amount unwritable on the adjustment table — the wrong sum
--    became impossible rather than merely discouraged. That move is NOT available here: these
--    amount columns are the entire point of the migration.
--
--    So the warning goes where a reader actually meets it. There are now THREE nested summable
--    money columns one join apart — payment_amount (BPR02) → claim_paid_amount (CLP04) →
--    line_paid_amount (SVC03) — and summing an outer one across an inner join multiplies it by
--    the inner row count. Every one carries its grain in its own COMMENT below.
-- ════════════════════════════════════════════════════════════════════════════════════════════
comment on column staging.era_835_claim.claim_charge_amount is
  'CLP03, CLAIM grain. Summable ONLY per claim. A claim->service_line join REPEATS this value '
  'once per line: aggregate the lines first (or sum over distinct claim id) before summing this '
  'column. This is 013''s inflation defect at a new grain — 013 could make the wrong sum '
  'unwritable; here the column is the point, so the contract lives on the column.';
comment on column staging.era_835_claim.claim_paid_amount is
  'CLP04, CLAIM grain. Summable ONLY per claim. A claim->service_line join REPEATS this value '
  'once per line. Aggregate before summing. For remitted dollars at REMIT grain use '
  'staging.era_835_payment.payment_amount (BPR02) — never the sum of this column across a join.';
comment on column staging.era_835_service_line.line_charge_amount is
  'SVC02, LINE grain. Summable per line and, summed within one claim, reconcilable against '
  'era_835_claim.claim_charge_amount. Never sum it alongside the claim column in one query '
  'without aggregating — that double-counts.';
comment on column staging.era_835_service_line.line_paid_amount is
  'SVC03, LINE grain. Summable per line; within one claim it should reconcile to '
  'era_835_claim.claim_paid_amount. THE THIRD of three nested money columns (BPR02 -> CLP04 -> '
  'SVC03), each one join apart. Summing an outer column across an inner join multiplies it by '
  'the inner row count — the 10-100x shape 013 was written to kill.';

reset role;

-- ── GRANTS run as postgres, OUTSIDE the SET ROLE block — 013 mirrors 019 here. ──────────────
grant usage on schema staging to cmd_rollup_writer;   -- self-contained; 013 already granted it
grant usage on schema staging to claims_reader;

revoke all on staging.era_835_claim        from public;
revoke all on staging.era_835_service_line from public;

grant select on staging.era_835_claim        to claims_reader;
grant select on staging.era_835_service_line to claims_reader;
grant insert on staging.era_835_claim        to cmd_rollup_writer;
grant insert on staging.era_835_service_line to cmd_rollup_writer;

-- ⚠ COLUMN-SCOPED SELECT FOR THE WRITER — REQUIRED, NOT OPTIONAL, AND EASY TO MISS.
-- `on conflict (row_fingerprint) do nothing` makes Postgres READ the conflicting row, so the
-- writer needs SELECT on the conflict key or the insert 42501s. That is exactly what CLAUDE.md's
-- 0106 entry records learning the hard way, and 013 had already implemented it:
--     013:33  grant select (id, row_fingerprint) on staging.era_835_payment    to cmd_rollup_writer;
--     013:39  grant select (row_fingerprint)     on staging.era_835_adjustment to cmd_rollup_writer;
-- Verified live 2026-09-08 in pg_attribute.attacl (NOT pg_class.relacl — a column grant does not
-- appear there, which is how an earlier draft of this file concluded "INSERT only" and proposed
-- shipping without these two lines).
--
-- `id` is granted on the claim table for the same reason era_835_payment.id is: the emitter does
-- `... on conflict do nothing returning id` and then needs that id as the FK for its lines.
-- The service_line table needs only row_fingerprint — nothing FKs to it.
grant select (id, row_fingerprint) on staging.era_835_claim        to cmd_rollup_writer;
grant select (row_fingerprint)     on staging.era_835_service_line to cmd_rollup_writer;

comment on table staging.era_835_claim is
  'One row per 835 CLP loop — the REMITTED claim. NOT staging.claim_line, which is the BILLED '
  'side (CMD charge detail, the Veris training grain). Dedup key is row_fingerprint over non-PHI '
  'natural keys; there is deliberately no claim_id text column (Veris 037).';
comment on table staging.era_835_service_line is
  'One row per 835 SVC loop. Exists because era_ingest.ts emitted line detail ONLY inside the '
  'CAS-triplet loop, so 6,676 clean-paid lines / $14,381,289.67 were parsed and discarded.';
comment on column staging.era_835_claim.member_id_bidx is
  'Keyed-HMAC blind index. THE join key — member_id_enc is secretbox with a random nonce and is '
  'never equality-joinable. Mint via src/collections/blindIndex.ts, which uses the COLLECTIONS '
  'normalizeMemberId (./normalize.js), NEVER src/normalize.ts: 2 of 5,000 live ids diverge, '
  'silently.';
comment on column staging.era_835_claim.era_control_number is
  'ST02. Stored for debugging, NEVER hashed into row_fingerprint — it is a per-file sequence CMD '
  'can re-assign. era835PaymentFingerprint includes it (to separate co-located transaction '
  'sets); the child-grain era835Fingerprint does not, and this table follows the child.';
comment on column staging.era_835_service_line.remark_codes is
  'LQ*HE RARC codes, LINE grain. 49,117 of 100,160 lines carry at least one; the parser has '
  'always returned them (Era835ServiceLine.remarkCodes) and era_ingest.ts:945 counted them into '
  'stats.remark_codes_seen and then discarded them — no migration ever defined a column. '
  'EMITTER CONTRACT: write NULL for a line with no codes, never {}. The partial GIN index uses '
  'cardinality(remark_codes) > 0 so either works for correctness, but NULL keeps "absent" and '
  '"present but empty" from becoming two spellings of the same fact. The CHECK enforces 1..50 '
  'entries and no NULL element, so {} is rejected outright. '
  'NOT on era_835_adjustment, and not merely out of scope: the PARSER CANNOT SUPPLY IT. '
  '`remarkCodes` appears three times in era835Parser.ts (:56, :339, :369) and all three are on '
  '`line` — there is no claim-level or triplet-level remark field. A claim-grain RARC needs a '
  'parser change first, named as a follow-up.';
