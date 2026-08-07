-- 029 — ref.payer_alias_map: confirmation requires attribution, and the default stops being unsafe
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Setting `needs_review = false` on a row in ref.payer_alias_map ESTABLISHES PAYER IDENTITY. Every
-- crosswalk join in src/collections/qualifyResolutionQuery.ts carries `and not m.needs_review`
-- (6 sites), so that one boolean is the entire gate between a machine proposal and a resolved payer.
-- This repo's standing rule is that a machine proposal may never resolve a payer.
--
-- Two measured defects mean that gate is not actually load-bearing today.
--
--   1. THE COLUMN DEFAULT IS THE UNSAFE DIRECTION. `needs_review` is `NOT NULL DEFAULT false`
--      (verified live 2026-08-06 via information_schema). An INSERT that simply omits the column
--      lands CONFIRMED. Nothing warns; the row silently becomes payer identity. Every seed to date
--      passed the value explicitly, so this has not bitten — it is a trap waiting for the first
--      author who does not know to.
--
--   2. CONFIRMATION IS UNATTRIBUTED. Measured live 2026-08-06:
--
--          needs_review | reviewed_by | reviewed_at | rows
--          -------------+-------------+-------------+------
--          false        | NULL        | NULL        |  695
--          true         | NULL        | NULL        |  990
--
--      All 695 confirmed rows were confirmed by nobody, at no time. The columns to record it have
--      existed since 026 and have never been populated. For a decision this consequential, "who
--      ruled this, and when" is not bookkeeping — it is the only way to review a ruling later, and
--      the only way to tell a seeded default apart from a considered judgement.
--
-- This migration does not relitigate the 695. It makes the NEXT confirmation attributable, and it
-- makes the unsafe default loud instead of silent.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY `NOT VALID`, AND WHY THAT IS THE POINT RATHER THAN A COMPROMISE
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- A plain CHECK would fail this migration instantly against those 695 legacy rows. `NOT VALID` skips
-- the backfill scan but ENFORCES ON EVERY INSERT AND UPDATE FROM NOW ON — which is exactly the
-- desired semantics, three ways over:
--
--   · A new alias row must declare its review state and, if confirmed, say who confirmed it.
--   · A legacy row is left alone while untouched, but the moment anyone UPDATEs one it must carry
--     attribution. Confirmations cannot be laundered through an edit.
--   · Section 1's default flip plus this constraint turn the silent hazard into a loud 23514: an
--     INSERT omitting `needs_review` now defaults to `true` (safe) rather than `false` (identity).
--
-- Do NOT run `VALIDATE CONSTRAINT` on this later expecting a no-op. It would fail on the 695 until
-- they are either attributed or explicitly re-confirmed. Backfilling them is a separate, reviewed
-- decision — attributing a ruling to a human who never made it is worse than leaving it unattributed.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- RELEASE NOTE — THIS IS A FORWARD-ONLY ASSURANCE BOUNDARY
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Ratified by Alec 2026-08-07 as an explicit, permanent property of this table — not a temporary
-- state to be cleaned up later:
--
--   · Rows confirmed BEFORE this migration (the 695) remain HISTORICALLY UNATTRIBUTED. They are
--     exempt by design. Their provenance is genuinely unknown and will stay that way.
--   · Every confirmation made AFTER this migration MUST be attributable — `reviewed_by` and
--     `reviewed_at` are required, enforced by the database, on INSERT and on UPDATE alike.
--
-- So `reviewed_by IS NULL` on a confirmed row is NOT a data-quality defect to be fixed. It is a
-- reliable marker that the row predates the boundary. Anyone auditing this table can read the two
-- populations apart precisely because nobody invented reviewer provenance for the older one:
--
--     confirmed + reviewed_by IS NULL      -> pre-029, provenance unknown, trust it accordingly
--     confirmed + reviewed_by IS NOT NULL  -> post-029, a named human ruled on it at a known time
--
-- A future migration that back-fills the 695 with a synthetic reviewer would destroy that
-- distinction and manufacture an audit trail that never existed. Do not do it. If those rows ever
-- need to become trustworthy, the only honest route is a human re-confirming them for real, which
-- populates the columns truthfully and moves the row across the boundary on its own merits.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- PHI DISCIPLINE
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Touches no PHI. ref.payer_alias_map holds payer NAME strings and mapping metadata only — no member
-- id, member token, patient name, employer, group number or dollar. Payer identity is public
-- information (same posture as intel.*, SQL Schemas/025). Section 3 writes only prose review notes.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- OWNERSHIP
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- ref.* objects are owned by `claims_admin` (established 015, maintained by 026/027/028), so this
-- runs under `SET ROLE claims_admin` — the OPPOSITE of the collections plane, where SET ROLE
-- downgrades the applier and fails 42501. Nothing here reads collections.* or vob.*, so no
-- `reset role` section is required: claims_admin has no SELECT on either and a SET ROLE'd read of
-- them is 42501 that rolls the whole migration back (026 §8 is the template for when you do need it).
--
-- No new grants, no new policies, no writer role. RLS posture is unchanged — 026 §4 already enables
-- RLS with one read-all SELECT policy and grants SELECT to claims_reader.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- IDEMPOTENT
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Section 1 `SET DEFAULT` is naturally idempotent. Section 2 guards the ADD CONSTRAINT in a DO block
-- on pg_constraint (there is no ADD CONSTRAINT IF NOT EXISTS). Section 3 is an UPDATE narrowed by a
-- `where review_note is null` predicate so a re-run does not clobber a reviewer's own note.
--
-- Rollback: 029_payer_alias_confirmation_gate_rollback.sql
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

set role claims_admin;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 1. The default becomes the SAFE direction
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- An omitted `needs_review` used to mean "this is payer identity". It now means "this needs a human".
-- Existing rows are untouched — SET DEFAULT only affects future INSERTs that omit the column.

alter table ref.payer_alias_map alter column needs_review set default true;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 2. A confirmation must say who made it, and when
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- needs_review = true  → unconstrained (a proposal owes nobody an attribution).
-- needs_review = false → reviewed_by AND reviewed_at must both be present.

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'payer_alias_map_confirmation_attributed'
       and conrelid = 'ref.payer_alias_map'::regclass
  ) then
    alter table ref.payer_alias_map
      add constraint payer_alias_map_confirmation_attributed
      check (needs_review or (reviewed_by is not null and reviewed_at is not null))
      not valid;
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 3. Annotate the structurally-underspecified aliases so a reviewer is warned BEFORE confirming
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- These strings name a company but no state, product line or other discriminator. A cosine score
-- cannot resolve them because the INPUT is ambiguous, not because the scoring is weak — so raising a
-- threshold does nothing and confirming on score alone is how a wrong payer becomes payer identity.
--
-- The worst is bare `UHC`: 944 VOBs, the largest single ambiguous string in the book, proposed at
-- confidence 0.510 to `pi_united_healthcare_medicare_advantage` — i.e. to a MEDICARE product, on no
-- evidence that any of those 944 members are Medicare. The VOB carries a `plan_type` field populated
-- on ~96% of rows; that is the co-signal a resolution would need, and it is not consulted today.
--
-- Only PROPOSAL rows are annotated. A row already marked confirmed is a ruling, and rewriting its
-- note here would be this migration editing a decision it has no standing to revisit. Two of these
-- strings ARE already confirmed and are deliberately left alone — see the verification block.

update ref.payer_alias_map m
   set review_note = v.note
  from (values
    ('UHC',
     'STRUCTURALLY AMBIGUOUS — names no state or product line. 944 VOBs. Proposed to a MEDICARE '
     || 'ADVANTAGE identity at 0.510 on no product evidence. Do not confirm without a plan_type '
     || 'co-signal; the VOB carries one on ~96% of rows.'),
    ('ANTHEM',
     'STRUCTURALLY AMBIGUOUS — Anthem operates per-state plans; a bare brand names none of them.'),
    ('BLUE CROSS BLUE SHIELD',
     'STRUCTURALLY AMBIGUOUS — names no licensee. Every Blue plan matches this string equally.'),
    ('BCBS FED',
     'STRUCTURALLY AMBIGUOUS — reads as the Federal Employee Program, not a state licensee. '
     || 'Proposed at 0.169, the lowest score in the book.'),
    ('TRICARE',
     'STRUCTURALLY AMBIGUOUS — TRICARE East and West are different contractors; this names neither.'),
    ('REGENCE BCBS',
     'STRUCTURALLY AMBIGUOUS — Regence is four separate state licensees (WA/OR/ID/UT).'),
    ('BCBS REGENCE',
     'STRUCTURALLY AMBIGUOUS — Regence is four separate state licensees (WA/OR/ID/UT).'),
    ('EMPIRE BCBS',
     'STRUCTURALLY AMBIGUOUS — no state token; verify NY before confirming.'),
    ('INDEPENDENCE BCBS',
     'STRUCTURALLY AMBIGUOUS — no state token; verify PA before confirming.'),
    ('PREMERA BC',
     'STRUCTURALLY AMBIGUOUS — Premera administers both WA and AK; this names neither.')
  ) as v(alias, note)
 where m.vocabulary = 'vob_insurance_co'
   and m.alias_norm = v.alias
   and m.needs_review           -- proposals only; never rewrite a ruling
   and m.review_note is null;   -- never clobber a reviewer's own note

reset role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. Verification (run manually after apply)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- (a) The default is now the safe direction.
-- select column_default from information_schema.columns
--  where table_schema='ref' and table_name='payer_alias_map' and column_name='needs_review';
-- -- expect: true
--
-- (b) The constraint exists and is deliberately NOT validated.
-- select conname, convalidated from pg_constraint
--  where conrelid='ref.payer_alias_map'::regclass and conname='payer_alias_map_confirmation_attributed';
-- -- expect: payer_alias_map_confirmation_attributed | f      <- f is CORRECT, see header
--
-- (c) The 695 legacy rows are untouched.
-- select needs_review, count(*) from ref.payer_alias_map group by 1 order by 1;
-- -- expect: false | 695     true | 990
--
-- (d) The gate actually bites. Both of these must ERROR 23514; neither may insert a row.
-- set role claims_admin;
--   insert into ref.payer_alias_map (vocabulary, alias_norm, canonical_payer_id, relationship,
--                                    provenance, needs_review)
--   values ('vob_insurance_co', 'ZZ_029_GATE_PROBE', null, 'unmapped', 'human', false);
--   -- expect: ERROR 23514 payer_alias_map_confirmation_attributed
--
--   update ref.payer_alias_map set needs_review = false
--    where vocabulary='vob_insurance_co' and alias_norm='UHC';
--   -- expect: ERROR 23514 — a legacy-shaped confirmation can no longer be laundered through an UPDATE
-- reset role;
--
-- (e) Ten proposals annotated; the two already-confirmed ambiguous strings left alone.
-- select alias_norm, needs_review, left(review_note, 40) as note
--   from ref.payer_alias_map
--  where vocabulary='vob_insurance_co'
--    and alias_norm in ('UHC','ANTHEM','BLUE CROSS BLUE SHIELD','BCBS FED','TRICARE','REGENCE BCBS',
--                       'BCBS REGENCE','EMPIRE BCBS','INDEPENDENCE BCBS','PREMERA BC',
--                       'KAISER','ANTHEM BCBS','HIGHMARK BCBS','CAREFIRST BCBS','WELLMARK BCBS')
--  order by needs_review desc, alias_norm;
-- -- expect: the 10 proposals carry a STRUCTURALLY AMBIGUOUS note;
-- --         KAISER / ANTHEM BCBS / HIGHMARK BCBS / CAREFIRST BCBS / WELLMARK BCBS have note = NULL
-- --         and needs_review = false. Those five are ALSO structurally ambiguous and are ALREADY
-- --         confirmed — that is a real finding for the reviewer, not something this migration fixes.
--
-- (f) RLS posture unchanged by this migration.
-- select relrowsecurity from pg_class where oid='ref.payer_alias_map'::regclass;  -- expect: t
-- select count(*) from pg_policies where schemaname='ref' and tablename='payer_alias_map';  -- expect: 1
