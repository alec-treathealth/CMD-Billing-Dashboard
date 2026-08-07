-- 031 — ref.payer_brand_allowlist: a controlled vocabulary of real payer brands
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- `anchorsOf()` in app/lib/qualify/carrierCluster.ts already extracts a name's COMPANY ANCHORS — what
-- is left after Blue branding and geography are removed. What it has never had is anywhere
-- authoritative to check that residue against. Without an allowlist, any token that survives the
-- filter is treated as a company name, which is how `BLUE CROSS AND BLUE SHIELD OF HAWAII` (71 VOBs)
-- came to be proposed to `pi_bcbs_texas`: the scorer had no way to know HAWAII names a licensee that
-- exists and TEXAS names a different one.
--
-- This table is that authority. It is small, hand-curated and low-churn — licensee changes are rare,
-- publicised events — which is exactly the profile that justifies freezing and versioning something,
-- unlike the typo-correction layer, which is population-relative on purpose and must stay dynamic.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- CARDINALITY IS THE WHOLE POINT: BRAND -> MANY ENTITIES, NOT BRAND -> ONE
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- The obvious design is one row per brand with a `canonical_id` and a `product_scope` column. It is
-- wrong, and the reason matters.
--
-- A `product_scope` column on a brand row cannot do resolution work, because THE BRAND TOKEN IS WHAT
-- IS AMBIGUOUS. "FLORIDA BLUE" does not say whether the member is on the PPO entity (Blue Cross and
-- Blue Shield of Florida) or the HMO entity (Health Options, Inc.) — two separate legal entities
-- under GuideWell, where a provider credentialed with one cannot bill the other. A scalar column can
-- only mark the brand "needs a co-signal", which is what the manual-only review note already does.
--
-- What is actually needed is the ability to hold MORE THAN ONE canonical entity per brand token, with
-- a discriminator that says which is which. Hence: `payer_brand` is the parent, `payer_brand_entity`
-- is the child, and a brand with two billing entities has two child rows.
--
-- The discriminator is `product_scope`, and it is populated from a signal that EXISTS: the VOB's
-- `plan_type` column, measured 2026-08-06 as populated on ~96% of rows
-- (PPO 21,859 · POS 4,487 · HMO 2,472 · EPO 1,363 · ASO 1,254 · OAP 799 · null 1,303).
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- `entity_resolution` HAS NO SAFE DEFAULT — that is deliberate
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- An enum value of `ALL` would be doing dangerous work: it cannot distinguish "this brand genuinely
-- has one billing entity" from "nobody has looked yet". Those are opposite states and only one of
-- them is safe to auto-confirm against.
--
-- So `payer_brand.entity_resolution` is NOT NULL with NO default and three values:
--   `single_entity`    — checked; this brand bills through one entity.
--   `split_by_product` — checked; two or more entities, use product_scope to pick.
--   `unreviewed`       — nobody has looked. Auto-confirm must refuse.
-- A brand row therefore cannot come into existence without someone choosing one. Same discipline as
-- 029's `needs_review` default flip: the missing-field case must never imply a decision.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- `parent_entity` IS METADATA AND MUST NEVER BECOME THE CANONICAL KEY
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- HCSC is ONE legal entity operating BCBS of IL, TX, OK, NM and MT. It is genuine corporate fact and
-- it is genuinely useful for reporting. It is also actively wrong as a grouping key for this product:
-- those five state plans negotiate separately and behave as distinct payers for allowed-vs-charged
-- and time-to-payment. Rolling them up to HCSC would make the KPIs worse, not better.
--
-- Measured presence in this book, so this is not hypothetical: BCBS Texas 1,609 VOBs · Illinois 1,405
-- · Oklahoma 248 · Montana 63 · New Mexico 31 — about 3,356 VOBs across five separately-negotiating
-- plans under one company.
--
-- `parent_entity` is therefore a plain text column with NO foreign key and NO uniqueness. It exists
-- to answer "who owns this brand" in a report. Nothing joins on it. Do not add an index that invites
-- a GROUP BY, and do not promote it to a canonical id.
--
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- SEED SCOPE — 8 BRANDS, DELIBERATELY NOT ~36
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- This seeds only brands where a real decision has been made in-session: the two dual-entity cases
-- ruled on 2026-08-07, plus the HCSC family that demonstrates parent_entity. The remaining licensees
-- land as `unreviewed` or not at all, because seeding ~36 rows as `single_entity` on nobody's
-- authority would be exactly the fabricated-provenance failure 029 exists to prevent. The table is
-- built to be filled in by review, not pre-filled by assumption.
--
-- ⚠ NOTHING READS THIS TABLE YET. 026 and 027 both refused to mint a surface with no caller and this
-- migration is the same shape, so justify it honestly: it is the FK target that a wiring change
-- needs, and the wiring is a separate reviewed change. If that wiring is not coming, do not apply
-- this.
--
-- PHI DISCIPLINE: none. Public payer reference data, same posture as 025/026/027/028/029/030.
-- OWNERSHIP: ref.* is claims_admin-owned, so `SET ROLE claims_admin`. RLS + grants mirror 026 §4
--   exactly — RLS on, one read-all SELECT policy, SELECT to claims_reader, no writer role minted.
-- IDEMPOTENT: create table if not exists, drop policy if exists before create, seed via
--   `on conflict do nothing`.
--
-- Rollback: 031_payer_brand_allowlist_rollback.sql
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

set role claims_admin;

-- CHECK constraints cannot contain subqueries, so keep the array scan in an immutable helper.
create or replace function ref.is_state_code_array(states text[])
returns boolean
language sql
immutable
as $$
  select states is null
    or coalesce(
      (select bool_and(s is not null and s ~ '^[A-Z]{2}$') from unnest(states) as s),
      true
    )
$$;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 1. The parent: one row per brand token
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists ref.payer_brand (
  brand_token       text not null,
  display_name      text not null,
  parent_entity     text,          -- metadata only. No FK, no uniqueness, nothing joins on it.
  entity_resolution text not null, -- no default, on purpose — see the header
  licensed_states   text[],        -- brand<->state impossibility check; NOT member-level geography
  effective_from    date not null default current_date,
  effective_to      date,
  reviewed_by       text not null,
  reviewed_at       timestamptz not null default now(),
  notes             text,

  constraint payer_brand_pkey primary key (brand_token),
  constraint payer_brand_token_normalized check (brand_token = upper(btrim(brand_token))),
  constraint payer_brand_token_len check (char_length(brand_token) between 2 and 80),
  constraint payer_brand_display_len check (char_length(display_name) between 2 and 200),
  constraint payer_brand_resolution check (
    entity_resolution in ('single_entity', 'split_by_product', 'unreviewed')),
  constraint payer_brand_dates check (effective_to is null or effective_to > effective_from),
  -- Every state code is exactly two upper-case letters. Stops 'California' entering a code array.
  constraint payer_brand_states_are_codes check (ref.is_state_code_array(licensed_states))
);

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 2. The child: the brand -> MANY entities cardinality
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- A single-entity brand has one row here. A split_by_product brand has two or more, and
-- `product_scope` is what picks between them once the VOB's plan_type is consulted.

create table if not exists ref.payer_brand_entity (
  brand_token        text not null,
  canonical_payer_id text not null,
  product_scope      text not null,
  legal_entity_name  text,
  notes              text,

  constraint payer_brand_entity_pkey primary key (brand_token, product_scope),
  constraint payer_brand_entity_brand_fkey
    foreign key (brand_token) references ref.payer_brand (brand_token) on delete cascade,
  constraint payer_brand_entity_canonical_fkey
    foreign key (canonical_payer_id) references ref.payer_identity (canonical_payer_id),
  constraint payer_brand_entity_scope check (
    product_scope in ('COMMERCIAL', 'HMO', 'MEDICARE_ADVANTAGE', 'MEDICAID', 'ANY'))
);

-- `ANY` is the catch-all for a single-entity brand. It must not coexist with a specific scope on the
-- same brand, or resolution has two answers and no rule for choosing. Enforced rather than documented.
create unique index if not exists payer_brand_entity_any_is_exclusive
  on ref.payer_brand_entity (brand_token)
  where product_scope = 'ANY';

create index if not exists payer_brand_entity_canonical_idx
  on ref.payer_brand_entity (canonical_payer_id);

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 3. RLS + grants — mirrors the verified live posture of ref.payer_alias_map (026 §4) exactly
-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- ⚠ A GRANT AND A POLICY ARE SEPARATE GATES AND ONLY THE GRANT ERRORS. A missing policy yields a
-- silent empty result, not 42501 — and postgres bypasses RLS entirely, so it cannot be caught by
-- testing as postgres. Both are set here; verification block (d) checks them as claims_reader.

alter table ref.payer_brand enable row level security;
alter table ref.payer_brand_entity enable row level security;

drop policy if exists payer_brand_read_all on ref.payer_brand;
create policy payer_brand_read_all on ref.payer_brand for select using (true);

drop policy if exists payer_brand_entity_read_all on ref.payer_brand_entity;
create policy payer_brand_entity_read_all on ref.payer_brand_entity for select using (true);

grant select on ref.payer_brand to claims_reader;
grant select on ref.payer_brand_entity to claims_reader;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 4. Seed — only decisions actually made, see the header
-- ───────────────────────────────────────────────────────────────────────────────────────────────────

insert into ref.payer_brand
  (brand_token, display_name, parent_entity, entity_resolution, licensed_states, reviewed_by, notes)
values
  ('HEALTH NET', 'Health Net', 'Centene', 'split_by_product', array['CA'],
   'alec@treathealth.ai (031 seed, 2026-08-07)',
   'The strongest split_by_product case in the book. pi_health_net is 55% HMO and pi_healthnet 51% '
   || 'across 452 VOBs; a near-even split is the signature of an HMO company and a life-insurance '
   || 'company under one brand. 030 deliberately did NOT merge these two ids.'),

  ('FLORIDA BLUE', 'Florida Blue', 'GuideWell', 'split_by_product', array['FL'],
   'alec@treathealth.ai (031 seed, 2026-08-07)',
   'Blue Cross and Blue Shield of Florida (PPO/EPO) and Health Options, Inc. (HMO) are separate '
   || 'legal entities; a provider credentialed with one cannot bill the other. Measured exposure in '
   || 'this book is currently 192 VOBs of which 191 are PPO and 1 is HMO, so the split is real but '
   || 'barely exercised. Seeded as the reference example of the pattern, not because it bites today.'),

  ('BCBS TEXAS', 'Blue Cross and Blue Shield of Texas', 'HCSC', 'unreviewed', array['TX'],
   'alec@treathealth.ai (031 seed, 2026-08-07)',
   'HCSC operates IL/TX/OK/NM/MT as one legal entity. parent_entity records that; it must NEVER '
   || 'become the grouping key — these plans negotiate separately and roll-up would corrupt the KPIs.'),
  ('BCBS ILLINOIS', 'Blue Cross and Blue Shield of Illinois', 'HCSC', 'unreviewed', array['IL'],
   'alec@treathealth.ai (031 seed, 2026-08-07)', 'HCSC family — see BCBS TEXAS.'),
  ('BCBS OKLAHOMA', 'Blue Cross and Blue Shield of Oklahoma', 'HCSC', 'unreviewed', array['OK'],
   'alec@treathealth.ai (031 seed, 2026-08-07)', 'HCSC family — see BCBS TEXAS.'),
  ('BCBS NEW MEXICO', 'Blue Cross and Blue Shield of New Mexico', 'HCSC', 'unreviewed', array['NM'],
   'alec@treathealth.ai (031 seed, 2026-08-07)', 'HCSC family — see BCBS TEXAS.'),
  ('BCBS MONTANA', 'Blue Cross and Blue Shield of Montana', 'HCSC', 'unreviewed', array['MT'],
   'alec@treathealth.ai (031 seed, 2026-08-07)', 'HCSC family — see BCBS TEXAS.'),

  ('ANTHEM', 'Anthem (Elevance Health)', 'Elevance Health', 'unreviewed',
   array['CA','CO','CT','GA','IN','KY','ME','MO','NH','NV','NY','OH','VA','WI'],
   'alec@treathealth.ai (031 seed, 2026-08-07)',
   'Per-state plans under one parent. Historical names WELLPOINT and BLUE CROSS OF CALIFORNIA are '
   || 'legitimate predecessors (Blue Cross of California -> Anthem Blue Cross 2004; WellPoint -> '
   || 'Anthem Inc 2014 -> Elevance Health 2022), NOT misfilings. Both are present and confirmed in '
   || 'ref.payer_alias_map today and are dedup candidates, not anomalies to suppress.')
on conflict (brand_token) do nothing;

-- The entity rows. Only brands whose split has actually been ruled on get more than one.
insert into ref.payer_brand_entity
  (brand_token, canonical_payer_id, product_scope, legal_entity_name, notes)
select v.brand, v.canon, v.scope, v.legal, v.note
  from (values
    ('HEALTH NET', 'pi_health_net', 'HMO', 'Health Net of California, Inc.',
     'Carries the 55%-HMO id. Confirm against VOB plan_type before resolving.'),
    ('HEALTH NET', 'pi_healthnet', 'COMMERCIAL', 'Health Net Life Insurance Company',
     'Carries the 51%-HMO id — the mix is near-even on both, which is the finding. PPO/EPO underwriter.')
  ) as v(brand, canon, scope, legal, note)
 where exists (select 1 from ref.payer_identity pi where pi.canonical_payer_id = v.canon)
on conflict (brand_token, product_scope) do nothing;

reset role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 5. Verification (run manually after apply)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- (a) Eight brands, two entity rows, and the cardinality is genuinely one-to-many.
-- select entity_resolution, count(*) from ref.payer_brand group by 1 order by 1;
-- -- expect: split_by_product | 2     unreviewed | 6
-- select brand_token, count(*) from ref.payer_brand_entity group by 1;   -- expect: HEALTH NET | 2
--
-- (b) The ANY-is-exclusive index actually bites. Must ERROR 23505:
-- set role claims_admin;
--   insert into ref.payer_brand_entity (brand_token, canonical_payer_id, product_scope)
--   values ('HEALTH NET', 'pi_health_net', 'ANY');
--   -- expect: ERROR 23505 payer_brand_entity_any_is_exclusive
-- reset role;
--
-- (c) entity_resolution has no default, so an INSERT omitting it must ERROR 23502 (not-null):
-- set role claims_admin;
--   insert into ref.payer_brand (brand_token, display_name, reviewed_by)
--   values ('ZZ_PROBE', 'probe', 'probe');
--   -- expect: ERROR 23502 null value in column "entity_resolution"
-- reset role;
--
-- (d) claims_reader can actually READ both tables — the grant-vs-policy trap. Must return rows, not 0:
-- set role claims_reader;
--   select count(*) from ref.payer_brand;          -- expect: 8   (0 means the POLICY is missing)
--   select count(*) from ref.payer_brand_entity;   -- expect: 2
-- reset role;
--
-- (e) RLS is on and each table has exactly one policy.
-- select relname, relrowsecurity from pg_class
--  where oid in ('ref.payer_brand'::regclass, 'ref.payer_brand_entity'::regclass);   -- expect: both t
-- select tablename, count(*) from pg_policies
--  where schemaname='ref' and tablename in ('payer_brand','payer_brand_entity')
--  group by 1 order by 1;                                                            -- expect: 1 each
--
-- (f) No writer role was minted — nothing but claims_admin can write.
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_schema='ref' and table_name='payer_brand' and privilege_type <> 'SELECT';
-- -- expect: claims_admin only
