-- 026 — ref.payer_identity + ref.payer_alias_map: the payer crosswalk (Qualify v3, workstream D1)
--
-- WHY: Qualify's policy card names the payer from VOB (`insurance_co`); its facility ranking is fetched
--   by `claims.primary_payer`. MEASURED 2026-08-04: 1,120 distinct VOB names vs 465 claims names with
--   only 191 exact (upper/trimmed) matches — 17.1%. There is no join, so the two halves of the screen
--   have never been about the same payer except by coincidence. This migration creates the spine that
--   makes them joinable, anchored on `vob.payer_id` (99.87% populated, 380 ids).
--
--   The crosswalk's job is NOT to maximise mapped share. It is to partition alias strings into
--   {mergeable | resolve-per-member | own-identity | unmapped} and be honest about which. A
--   map-everything crosswalk would score better on coverage and be strictly worse, because it would
--   hand the facility ranking a payer that does not exist. Three measured cases force that shape:
--
--     1. BlueCard is a ROUTING PROGRAM, not a payer. The bare, state-less claims strings
--        ('BLUE CARD PROGRAM' 24,489 lines, 'BLUE CARD' 871, 'BLUECARD PROGRAM' 840,
--        'BLUE CARD PROGRAM - SECONDARY' 79 = ~26,280 lines, 5.4% of all claim volume) resolve to a
--        DIFFERENT home plan per member: those members' VOB rows name BCBS of Illinois (77 members),
--        BCBS of Texas (50), Highmark PA (42), BCBS Massachusetts (25), Blue Shield CA (23), BCBS
--        Minnesota (23), Horizon NJ (23), and more. Mapping them to one canonical payer is wrong by
--        construction, so `relationship = 'program_label'` forces `canonical_payer_id` NULL and D2
--        resolves the home plan per member. NOTE the state-SUFFIXED variants are a different case and
--        are already correct in `ref.payer_alias` ('BLUECARD PROGRAM OF TX' -> 'BCBS TEXAS'): when the
--        string names the home plan it genuinely IS the same payer. Only the bare ones are a program.
--
--     2. BEHAVIORAL-HEALTH CARVE-OUTS are a separate dimension, not payer aliases. Halcyon (11,790
--        lines), Magellan (4,313 + variants), Carelon/Beacon (2,741 + 1,791 + 12 more variants), MHN
--        (691 + 73), HMC HealthWorks (793), ComPsych (787), MHSA (112), Behavioral Health Systems (24)
--        = ~22k lines, 4.5% of volume. The insurer may be Cigna while BH benefits are administered by
--        a delegate. Merging a carve-out into its underlying insurer produces a CONFIDENTLY WRONG
--        rating — the exact failure mode Qualify v3 exists to remove, relocated to the crosswalk. Each
--        carve-out therefore gets its OWN identity row and is never merged.
--
--     3. 48 claims payer names carrying 47,656 lines (9.7% of ALL volume) have NO trigram candidate in
--        VOB at all — the acronym<->expansion class (UMR/UnitedHealthcare, MHN/Health Net) that string
--        similarity structurally cannot bridge. Low similarity is NOT evidence of no match; it means
--        no machine proposal exists and a human must supply the alias. Hence `provenance='no_candidate'`
--        as a first-class recorded state rather than a silent miss.
--
--   NO FUZZY MATCH IS EVER AUTO-ACCEPTED. Every trigram-derived row lands `needs_review = true`.
--
-- PHI DISCIPLINE: This migration creates and populates NON-PHI reference data only. Payer identity is
--   public information (same posture as `intel.*`, SQL Schemas/025). The populated columns are payer
--   name strings, an enum, a similarity score and counts. NO member id, member token, patient name,
--   employer, group number or dollar amount is read into, or stored in, either table. Section 8 reads
--   `vob.member_benefits_latest` and `collections.cmd_explorer_charge_rollup` — both PHI-bearing — but
--   projects ONLY `insurance_co` / `primary_payer` / `payer_id` (payer labels) and aggregate counts.
--   Neither table gains a `business_entity_id`: `ref` is global, and Qualify is the ratified
--   cross-tenant surface (BXR + Indigo read together), so a tenancy column here would be wrong.
--
-- OWNERSHIP: Both tables born owned by `claims_admin` via `SET ROLE` (sections 1-7), matching the
--   verified live posture of the sibling `ref.payer_alias` (owner claims_admin, RLS on, one read-all
--   policy, claims_reader SELECT). Section 8 runs AFTER `RESET ROLE` — see its header for why that is
--   mandatory, not stylistic.
--
-- IDEMPOTENT: `IF NOT EXISTS` on both tables and all five indexes; `DROP POLICY IF EXISTS` before each
--   `CREATE POLICY` (else 42710); every seed INSERT is `ON CONFLICT DO NOTHING` on a real key. Surrogate
--   ids are a deterministic slug of the source name, so a re-run maps to the same id rather than
--   minting a duplicate. Section 9 RAISEs on slug collision instead of letting `DO NOTHING` silently
--   merge two different payers into one identity.
--
-- DEPENDENCY: `ref` schema + `ref.payer_alias` (SQL Schemas/005, RLS-remediated by 015). `pg_trgm` —
--   which on this project is installed in schema **claims**, NOT `extensions` (verified 2026-08-04);
--   every trigram call and opclass below is schema-qualified accordingly, or the apply dies 42883.
--   `claims_admin` holds USAGE on claims/ref/vob (verified), so no transient GRANT bracket is needed
--   the way 025 needed one for `extensions`.
--
-- APPLY NOTE: plain `CREATE INDEX`, not CONCURRENTLY — both tables are created empty in this same
--   transaction, so there is nothing to lock and CONCURRENTLY cannot run inside apply_migration's
--   transaction wrapper anyway.
--
-- Rollback: 026_payer_identity_rollback.sql

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. ref.payer_identity — one row per real-world billing entity
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

set role claims_admin;

create table if not exists ref.payer_identity (
  canonical_payer_id text not null,
  display_name       text not null,
  payer_family       text,
  entity_kind        text not null,
  -- The corporate/underlying insurer, where that is a FIXED fact about the entity (e.g. a TPA owned by
  -- a carrier). Deliberately NULLABLE and deliberately NOT required for carve-outs: a carve-out's
  -- underlying insurer varies PER MEMBER (Magellan administers BH for many carriers), so a single value
  -- here would be exactly the kind of many-to-one collapse this whole re-architecture removes. The
  -- (payer, administrator) PAIR is resolution-time state (D2), not entity state.
  administers_for    text,
  is_active          boolean not null default true,
  notes              text,
  created_at         timestamptz not null default now(),
  -- No trigger maintains updated_at (kept deliberately: 025 ships 0 user triggers, and a trigger adds
  -- an object the rollback must chase). Writers set it explicitly.
  updated_at         timestamptz not null default now(),

  constraint payer_identity_pkey primary key (canonical_payer_id),
  constraint payer_identity_administers_for_fkey
    foreign key (administers_for) references ref.payer_identity (canonical_payer_id),

  constraint payer_identity_id_len
    check (char_length(canonical_payer_id) between 3 and 80),
  constraint payer_identity_id_shape
    check (canonical_payer_id ~ '^pi_[a-z0-9_]+$'),
  constraint payer_identity_display_name_len
    check (char_length(display_name) between 2 and 200),
  constraint payer_identity_payer_family_len
    check (payer_family is null or char_length(payer_family) between 2 and 60),
  constraint payer_identity_entity_kind
    check (entity_kind in ('insurer','carve_out','tpa','program','employer_self_funded',
                           'non_payer','unclassified')),
  -- A row can never administer for itself. (Longer cycles are not expressible in a CHECK; section 10's
  -- verification block carries the query that detects them.)
  constraint payer_identity_no_self_administer
    check (administers_for is null or administers_for <> canonical_payer_id)
);

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. ref.payer_alias_map — many alias strings -> at most one canonical, from BOTH vocabularies
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

create table if not exists ref.payer_alias_map (
  vocabulary         text not null,
  alias_norm         text not null,
  canonical_payer_id text,
  relationship       text not null,
  provenance         text not null,
  confidence         numeric(4,3),
  needs_review       boolean not null default false,
  review_note        text,
  reviewed_by        text,
  reviewed_at        timestamptz,
  created_at         timestamptz not null default now(),

  constraint payer_alias_map_pkey primary key (vocabulary, alias_norm),
  constraint payer_alias_map_canonical_fkey
    foreign key (canonical_payer_id) references ref.payer_identity (canonical_payer_id),

  constraint payer_alias_map_vocabulary
    check (vocabulary in ('vob_insurance_co','claims_primary_payer','vob_payer_id')),
  constraint payer_alias_map_alias_len
    check (char_length(alias_norm) between 1 and 200),
  -- The join key is ALWAYS stored normalized, so a lookup can never silently miss on case/whitespace.
  constraint payer_alias_map_alias_normalized
    check (alias_norm = upper(btrim(alias_norm))),
  constraint payer_alias_map_relationship
    check (relationship in ('same_payer','program_label','carve_out','tpa',
                            'employer_self_funded','unmapped')),
  constraint payer_alias_map_provenance
    check (provenance in ('payer_alias_seed','exact_match','vob_payer_id',
                          'trigram_proposal','no_candidate','human')),
  constraint payer_alias_map_confidence_range
    check (confidence is null or (confidence >= 0 and confidence <= 1)),
  constraint payer_alias_map_review_note_len
    check (review_note is null or char_length(review_note) between 2 and 500),

  -- THE pairing constraint: a resolving relationship MUST name a canonical; a non-resolving one MUST
  -- NOT. This is what makes "we deliberately did not pick a payer" unrepresentable-as-a-guess rather
  -- than a convention someone remembers.
  constraint payer_alias_map_relationship_canonical check (
    (relationship in ('same_payer','carve_out','tpa','employer_self_funded')
       and canonical_payer_id is not null)
    or
    (relationship in ('program_label','unmapped')
       and canonical_payer_id is null)
  )
);

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. Indexes  (plain CREATE INDEX — both tables are empty in this transaction; see APPLY NOTE)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

create index if not exists payer_identity_entity_kind_idx
  on ref.payer_identity (entity_kind);
create index if not exists payer_identity_administers_for_idx
  on ref.payer_identity (administers_for);

create index if not exists payer_alias_map_canonical_idx
  on ref.payer_alias_map (canonical_payer_id);
-- The human review queue, volume-ordered by the caller. Partial: only unreviewed rows are ever scanned.
create index if not exists payer_alias_map_needs_review_idx
  on ref.payer_alias_map (needs_review) where needs_review;
-- Fuzzy alias lookup for the proposal/review tooling. `claims.gin_trgm_ops` — pg_trgm lives in schema
-- `claims` on this project, so the opclass MUST be schema-qualified here.
create index if not exists payer_alias_map_alias_trgm_idx
  on ref.payer_alias_map using gin (alias_norm claims.gin_trgm_ops);

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. RLS + policies + grants — mirrors the verified live posture of ref.payer_alias exactly
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

alter table ref.payer_identity  enable row level security;
alter table ref.payer_alias_map enable row level security;

drop policy if exists payer_identity_read_all on ref.payer_identity;
create policy payer_identity_read_all on ref.payer_identity
  for select using (true);

drop policy if exists payer_alias_map_read_all on ref.payer_alias_map;
create policy payer_alias_map_read_all on ref.payer_alias_map
  for select using (true);

grant select on ref.payer_identity  to claims_reader;
grant select on ref.payer_alias_map to claims_reader;

-- Defence in depth. 0010 already revoked USAGE on schema `ref` from these roles, so they hold no reach;
-- these table-level revokes make that explicit and survive a future schema-level grant.
revoke all on ref.payer_identity  from public, anon, authenticated, service_role;
revoke all on ref.payer_alias_map from public, anon, authenticated, service_role;
grant select on ref.payer_identity  to claims_reader;
grant select on ref.payer_alias_map to claims_reader;

-- NOTE: no writer role is created. P0 writes happen on the apply path (claims_admin, the owner).
-- A review UI that lets a human accept/reject proposals needs a narrow writer with UPDATE on
-- (canonical_payer_id, relationship, needs_review, review_note, reviewed_by, reviewed_at) ONLY — that
-- is a separate, explicitly-scoped migration, not a widening of this one.

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 5. Column documentation
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

comment on table ref.payer_identity is
  'One row per real-world billing entity (Qualify v3 D1). NON-PHI public reference data. Cross-tenant '
  'by design — no business_entity_id. entity_kind distinguishes an insurer from a carve-out, TPA, '
  'routing program or non-payer marker, because their reimbursement behaviour is not interchangeable.';
comment on column ref.payer_identity.canonical_payer_id is
  'Stable surrogate, deterministic slug of the name at mint time (pi_<slug>). A later display_name '
  'change does NOT change the id. If an upstream canonical name changes, a re-run mints a NEW identity '
  'that a human must merge — surfaced by the section 10 orphan-alias check, never silent.';
comment on column ref.payer_identity.entity_kind is
  'insurer | carve_out | tpa | program | employer_self_funded | non_payer | unclassified. '
  '`unclassified` is the honest default for a bulk-seeded row whose kind no human has set — the seed '
  'refuses to assert "insurer" for 143 canonicals it cannot verify (ref.payer_alias demonstrably '
  'contains TPAs, workers-comp carriers and self-pay markers alongside real carriers). '
  '`non_payer` marks SELF PAY / NO INSURANCE, which must never produce a coverage group at all. '
  '`program` marks a routing label (BlueCard) that is never a resolution target — see next comment.';
comment on column ref.payer_identity.administers_for is
  'The underlying insurer ONLY where that is a fixed fact about the entity. NULL for carve-outs whose '
  'insurer varies per member — the (payer, administrator) pair is resolution state, not entity state.';

comment on table ref.payer_alias_map is
  'Alias strings from BOTH payer vocabularies mapped to at most one canonical identity. The pairing '
  'CHECK makes a non-resolving relationship (program_label, unmapped) structurally unable to carry a '
  'canonical, so "we did not pick a payer" cannot decay into "we quietly picked one".';
comment on column ref.payer_alias_map.vocabulary is
  'vob_insurance_co (VOB free-text carrier) | claims_primary_payer (rollup payer label) | '
  'vob_payer_id (the 380-id VOB spine). One alias string can legitimately appear in more than one '
  'vocabulary, hence the composite PK.';
comment on column ref.payer_alias_map.relationship is
  'same_payer: safe to merge. program_label: resolves to MANY canonicals per member (BlueCard) — '
  'canonical is NULL and D2 resolves it from the member VOB row. carve_out / tpa / '
  'employer_self_funded: the alias names a distinct billing entity that gets its OWN identity and is '
  'never merged into an underlying insurer. unmapped: no canonical established — renders as *unmapped* '
  'in the UI (invariant I8), never as a match.';
comment on column ref.payer_alias_map.provenance is
  'How this row got here. `no_candidate` records that trigram search found NOTHING above threshold — '
  'a measured fact (48 claims names, 47,656 lines) and not the same thing as "not looked at".';
comment on column ref.payer_alias_map.needs_review is
  'TRUE on every machine-proposed row. No fuzzy match is ever auto-accepted into production: a wrong '
  'payer merge is a confidently-wrong answer at the worst possible layer.';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 6. HAND-SEEDED identities — the measured findings, not trigram guesses
--
--    Ids are the slug of the matching ref.payer_alias canonical_name WHERE ONE EXISTS, so the generic
--    seed in section 7 collides on the PK and leaves these rows intact rather than minting a duplicate
--    under a different id. pi_mhn and pi_hmc_healthworks have no ref.payer_alias canonical.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

insert into ref.payer_identity (canonical_payer_id, display_name, payer_family, entity_kind, notes) values
  -- The routing program. entity_kind='program'. NOTHING in payer_alias_map ever points a
  -- canonical_payer_id at this row (the pairing CHECK forbids it for program_label aliases) — that
  -- asymmetry is deliberate and section 10 asserts it. The row exists so a RESOLUTION can name the
  -- routing state ("filed through BlueCard; home plan resolves per member") and so D2 has a stable
  -- target to record alongside the per-member-resolved home plan. Without it, "BlueCard" would live
  -- only as a magic string in application code — the untraceable heuristic being removed.
  ('pi_bcbs_bluecard', 'BCBS BlueCard (inter-plan program)', 'BCBS', 'program',
   'Routing label, not a carrier. Bare/state-less claims strings resolve per member via the VOB row; '
   'state-suffixed variants (BLUECARD PROGRAM OF TX) are same_payer to that state plan and are already '
   'correct in ref.payer_alias. Anchor for a future BlueCard prefix -> home-plan table.'),

  -- Behavioural-health carve-outs. Each keeps its OWN identity; administers_for stays NULL because the
  -- underlying insurer varies per member.
  ('pi_halcyon_behavioral_health',  'Halcyon Behavioral Health',  'COMMERCIAL', 'carve_out', null),
  ('pi_magellan_behavioral_health', 'Magellan Behavioral Health', 'MAGELLAN',   'carve_out', null),
  ('pi_carelon_behavioral_health',  'Carelon Behavioral Health',  'COMMERCIAL', 'carve_out',
   'Single identity for the Beacon/Carelon lineage. Merges THREE ref.payer_alias canonicals — '
   'CARELON BEHAVIORAL HEALTH, BEACON HEALTH OPTIONS, BEACON HEALTH STRATEGIES (fka ValueOptions) — '
   'plus 14 claims-side spelling variants.'),
  ('pi_mhn',                        'Managed Health Network (MHN)', 'COMMERCIAL', 'carve_out',
   'Health Net behavioural-health carve-out. No ref.payer_alias canonical existed. The VOB strings '
   'HEALTHNET (MHN) / MHN- HEALTHNET literally encode the (insurer, administrator) pair.'),
  ('pi_hmc_healthworks',            'HMC HealthWorks',            'COMMERCIAL', 'carve_out',
   'Claims-only: absent from both ref.payer_alias and VOB.'),
  ('pi_compsych',                   'ComPsych',                   'COMMERCIAL', 'carve_out', null),
  ('pi_mhsa',                       'MHSA',                       'COMMERCIAL', 'carve_out',
   'Kept SEPARATE from Magellan. Claims strings pair them (MAGELLAN BEHAVIORAL HEALTH / MHSA) but a '
   'merge is not substantiated by the data — a human rules.'),
  ('pi_behavioral_health_systems',  'Behavioral Health Systems',  'COMMERCIAL', 'carve_out', null),
  ('pi_optum',                      'Optum',                      'OPTUM',      'carve_out',
   'UnitedHealthcare behavioural-health administrator. Reclassified from the generic seed, which would '
   'have called the OPTUM family an insurer.'),

  -- Third-party administrators.
  ('pi_umr',             'UMR',             'UNITED', 'tpa', 'UnitedHealthcare TPA, not a carrier.'),
  ('pi_meritain_health', 'Meritain Health', 'AETNA',  'tpa', 'Aetna TPA, not a carrier.'),

  -- Absence-of-coverage markers. These must NEVER produce a coverage group; D2 excludes non_payer.
  ('pi_self_pay',      'Self Pay',      'OTHER', 'non_payer', null),
  ('pi_no_insurance',  'No Insurance',  'OTHER', 'non_payer', null)
on conflict (canonical_payer_id) do nothing;

-- 6b. HAND-SEEDED aliases. Inserted BEFORE section 7 so that where a string also appears in
--     ref.payer_alias, this evidence-based relationship (carve_out / program_label) wins the PK
--     conflict over the generic 'same_payer'.

-- BlueCard: the four BARE, state-less claims strings only. canonical MUST be NULL (pairing CHECK).
insert into ref.payer_alias_map
  (vocabulary, alias_norm, canonical_payer_id, relationship, provenance, needs_review, review_note)
select 'claims_primary_payer', v.alias, null, 'program_label', 'human', false,
       'BlueCard inter-plan routing label: home plan resolves per member from the VOB row (D2). '
       'Measured: these members'' VOB rows name BCBS IL/TX/MA/MN, Highmark PA, Blue Shield CA, '
       'Horizon NJ and others.'
from (values ('BLUE CARD PROGRAM'), ('BLUE CARD'), ('BLUECARD PROGRAM'),
             ('BLUE CARD PROGRAM - SECONDARY')) as v(alias)
on conflict (vocabulary, alias_norm) do nothing;

-- Carve-out aliases, claims side.
insert into ref.payer_alias_map
  (vocabulary, alias_norm, canonical_payer_id, relationship, provenance, needs_review)
select 'claims_primary_payer', v.alias, v.canon, 'carve_out', 'human', false
from (values
  ('HALCYON BEHAVIORAL HEALTH',                        'pi_halcyon_behavioral_health'),
  ('MAGELLAN BEHAVIORAL HEALTH',                       'pi_magellan_behavioral_health'),
  ('MAGELLAN BEHAVIORAL HEALTH / MHSA',                'pi_magellan_behavioral_health'),
  ('MAGELLAN BEHAVIORAL HEALTH - MHSA',                'pi_magellan_behavioral_health'),
  ('MAGELLAN BEHAVIORAL HEALTH - SECONDARY',           'pi_magellan_behavioral_health'),
  ('MAGELLAN LIFE RESOURCES',                          'pi_magellan_behavioral_health'),
  ('BEACON (CARELON)',                                 'pi_carelon_behavioral_health'),
  ('BEACON CARELON',                                   'pi_carelon_behavioral_health'),
  ('BEACON (CARELON) SECONDARY',                       'pi_carelon_behavioral_health'),
  ('BEACON HEALTH OPTIONS',                            'pi_carelon_behavioral_health'),
  ('BEACON HEALTH OPTIONS (CARELON)',                  'pi_carelon_behavioral_health'),
  ('BEACON HEALTH OPTIONS FKA VALUE OPTIONS',          'pi_carelon_behavioral_health'),
  ('BEACON HEALTH OPTIONS - COLORADO HEALTH NETWORKS', 'pi_carelon_behavioral_health'),
  ('BEACON HEALTH STRATEGIES',                         'pi_carelon_behavioral_health'),
  ('BEACON HEALTH CARELON',                            'pi_carelon_behavioral_health'),
  ('CARELON',                                          'pi_carelon_behavioral_health'),
  ('CARELON BEACON',                                   'pi_carelon_behavioral_health'),
  ('CARELON-BEACON',                                   'pi_carelon_behavioral_health'),
  ('CARELON BEHAVIORAL HEALTH',                        'pi_carelon_behavioral_health'),
  ('CARELON BEHAVIORAL HEALTH (BEACON HEALTH)',        'pi_carelon_behavioral_health'),
  ('MANAGED HEALTH NETWORK',                           'pi_mhn'),
  ('MHN',                                              'pi_mhn'),
  ('HMC HEALTHWORKS',                                  'pi_hmc_healthworks'),
  ('COMPSYCH',                                         'pi_compsych'),
  ('MHSA',                                             'pi_mhsa'),
  ('BEHAVIORAL HEALTH SYSTEMS',                        'pi_behavioral_health_systems')
) as v(alias, canon)
on conflict (vocabulary, alias_norm) do nothing;

-- Carve-out aliases, VOB side.
insert into ref.payer_alias_map
  (vocabulary, alias_norm, canonical_payer_id, relationship, provenance, needs_review)
select 'vob_insurance_co', v.alias, v.canon, 'carve_out', 'human', false
from (values
  ('HALCYON',                   'pi_halcyon_behavioral_health'),
  ('MAGELLAN HEALTHCARE',       'pi_magellan_behavioral_health'),
  ('BEACON',                    'pi_carelon_behavioral_health'),
  ('BEACON HEALTH',             'pi_carelon_behavioral_health'),
  ('BEACON HEALTH OPTIONS',     'pi_carelon_behavioral_health'),
  ('CARELON',                   'pi_carelon_behavioral_health'),
  ('CARELON BEHAVIORAL HEALTH', 'pi_carelon_behavioral_health'),
  ('COMPSYCH',                  'pi_compsych'),
  ('HEALTHNET (MHN)',           'pi_mhn'),
  ('MHN- HEALTHNET',            'pi_mhn')
) as v(alias, canon)
on conflict (vocabulary, alias_norm) do nothing;

-- The (insurer, carve-out) PAIR case. D1 cannot represent a pair, so these are held for review rather
-- than mapped to either half — mapping to Magellan would silently discard "Presbyterian".
insert into ref.payer_alias_map
  (vocabulary, alias_norm, canonical_payer_id, relationship, provenance, needs_review, review_note)
select 'claims_primary_payer', v.alias, null, 'unmapped', 'human', true,
       'Encodes an (insurer, carve-out) PAIR that D1 cannot represent: Presbyterian is the insurer, '
       'Magellan the behavioural-health administrator. Mapping to either half loses information. '
       'Resolve when CoverageGroup carries administratorId (D2). Low volume (12 lines).'
from (values ('PRESBYTERIAN (MAGELLAN)'),
             ('PRESBYTERIAN - MAGELLAN BEHAVIORAL HEALTH')) as v(alias)
on conflict (vocabulary, alias_norm) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 7. GENERIC seed from ref.payer_alias (262 curated rows -> 143 canonicals, 12 families)
--
--    MEASURED: this existing asset alone already covers 248 of 465 claims payer names = 76.7% of claim
--    volume, which is MORE than the 191 exact matches buy (67.5%). D1 absorbs and supersedes it rather
--    than starting from scratch.
--
--    entity_kind rule — deliberately conservative:
--      families BCBS/ANTHEM/CIGNA/AETNA/UNITED/MEDICARE/MEDICAID/TRICARE -> 'insurer'
--      families COMMERCIAL/OTHER/OPTUM/MAGELLAN                         -> 'unclassified'
--    COMMERCIAL and OTHER are demonstrably mixed (TPAs, workers-comp carriers, self-funded employers
--    and SELF PAY / NO INSURANCE sit beside real carriers), so asserting 'insurer' across them would
--    write falsehoods into a reference table. Section 6's hand-classified rows already hold the
--    exceptions inside the insurer families (UMR, Meritain, BCBS BlueCard) and are protected by the PK.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

-- 7a. Identities, one per distinct canonical_name. `payer_identity_id_shape` guarantees the slug is
--     well-formed; section 9 guarantees it is unique per source name.
insert into ref.payer_identity (canonical_payer_id, display_name, payer_family, entity_kind)
select distinct on (slug)
       slug,
       -- The seed's canonical_name verbatim. NOT initcap() — that would mangle every acronym
       -- ('BCBS' -> 'Bcbs', 'UMR' -> 'Umr'). display_name is editable later by a human.
       canon                                           as display_name,
       fam                                             as payer_family,
       case when fam in ('BCBS','ANTHEM','CIGNA','AETNA','UNITED',
                         'MEDICARE','MEDICAID','TRICARE')
            then 'insurer' else 'unclassified' end     as entity_kind
-- NOTE the two-level nesting. Deriving `slug` from `lower(btrim(canonical_name))` while grouping on
-- `upper(btrim(canonical_name))` is SQLSTATE 42803: they are different expressions, so the planner
-- cannot prove slug is functionally dependent on the group key. Normalize FIRST (inner), then group,
-- then derive slug from the group key itself.
from (
  select canon,
         max(payer_family) as fam,
         'pi_' || left(btrim(regexp_replace(lower(canon),
                                            '[^a-z0-9]+', '_', 'g'), '_'), 77) as slug
  from (
    select upper(btrim(a.canonical_name)) as canon, a.payer_family
    from ref.payer_alias a
    where nullif(btrim(a.canonical_name),'') is not null
  ) n
  group by canon
) s
-- >= 4, not >= 3: 'pi_' alone is length 3 and would PASS a >=3 filter but FAIL
-- payer_identity_id_shape ('^pi_[a-z0-9_]+$' needs >=1 char after the prefix), erroring the whole
-- migration instead of skipping the row. A name with no alphanumerics slugs to exactly 'pi_'.
where char_length(slug) >= 4
order by slug, canon
on conflict (canonical_payer_id) do nothing;

-- 7b. Claims-vocabulary aliases. ref.payer_alias is a CLAIMS-vocabulary asset by construction (248 of
--     its raw_names match claims payer names vs 139 matching VOB names); section 8a adds the VOB side
--     for those that appear there, which THIS section cannot determine because claims_admin has no
--     SELECT on vob.member_benefits_latest.
--
--     The two Beacon canonicals are redirected into the single Carelon identity (section 6's merge).
insert into ref.payer_alias_map
  (vocabulary, alias_norm, canonical_payer_id, relationship, provenance, needs_review)
select 'claims_primary_payer',
       upper(btrim(a.raw_name)),
       coalesce(ovr.forced_id,
                'pi_' || left(btrim(regexp_replace(lower(btrim(a.canonical_name)),
                                                   '[^a-z0-9]+', '_', 'g'), '_'), 77)),
       'same_payer',
       'payer_alias_seed',
       false
from ref.payer_alias a
left join (values
  ('BEACON HEALTH OPTIONS',    'pi_carelon_behavioral_health'),
  ('BEACON HEALTH STRATEGIES', 'pi_carelon_behavioral_health')
) as ovr(canon_name, forced_id)
  on ovr.canon_name = upper(btrim(a.canonical_name))
where nullif(btrim(a.raw_name),'') is not null
  and nullif(btrim(a.canonical_name),'') is not null
  -- 'BCBS BLUECARD' is not a payer. Its single alias ('BLUE CARD PROGRAM') is hand-seeded as
  -- program_label in 6b; skip it here so no insurer mapping is created for it.
  and upper(btrim(a.canonical_name)) <> 'BCBS BLUECARD'
  and exists (select 1 from ref.payer_identity pi
               where pi.canonical_payer_id = coalesce(ovr.forced_id,
                     'pi_' || left(btrim(regexp_replace(lower(btrim(a.canonical_name)),
                                                        '[^a-z0-9]+', '_', 'g'), '_'), 77)))
on conflict (vocabulary, alias_norm) do nothing;

reset role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 8. DATA-DERIVED ladder — runs as the apply role (postgres), NOT as claims_admin
--
--    ⚠ WHY RESET ROLE IS MANDATORY HERE, not stylistic. VERIFIED 2026-08-04:
--        has_table_privilege('claims_admin','collections.cmd_explorer_charge_rollup','SELECT') = FALSE
--        has_table_privilege('claims_admin','vob.member_benefits_latest','SELECT')             = FALSE
--      Both objects are owned by `postgres`; claims_admin is absent from both ACLs. Running these
--      sections under SET ROLE claims_admin fails 42501 and rolls the whole migration back — the same
--      privilege-wall class that cost 025 two failed applies. The apply role (postgres) has BYPASSRLS
--      and reads both, so no new grant is created and the end-state posture is unchanged. Inserts still
--      land in claims_admin-owned tables; row ownership is not a thing in Postgres.
--
--    ⚠ DATA-VINTAGE COUPLING (accepted, recorded). These sections read live data — the rollup refreshes
--      hourly at :45 — so the proposals frozen here are a snapshot. Re-proposing as new payer names
--      appear is a RECURRING job and belongs in a re-runnable backfill script, not in DDL. Every insert
--      is ON CONFLICT DO NOTHING, so re-running this file only ADDS newly-seen names and never disturbs
--      a human's review decision.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

-- 8a. VOB-vocabulary rows for aliases already mapped on the claims side (139 of ref.payer_alias's
--     raw_names appear in VOB). Same canonical, same provenance, still not a guess.
insert into ref.payer_alias_map
  (vocabulary, alias_norm, canonical_payer_id, relationship, provenance, needs_review)
select 'vob_insurance_co', m.alias_norm, m.canonical_payer_id, m.relationship, 'payer_alias_seed', false
from ref.payer_alias_map m
where m.vocabulary = 'claims_primary_payer'
  and m.canonical_payer_id is not null
  and m.relationship in ('same_payer','carve_out','tpa','employer_self_funded')
  and exists (select 1 from vob.member_benefits_latest v
               where upper(btrim(v.insurance_co)) = m.alias_norm)
on conflict (vocabulary, alias_norm) do nothing;

-- 8b. The 191 exact (upper/trimmed) VOB<->claims name matches not already covered. A name present
--     verbatim in BOTH vocabularies is a match by identity, not by similarity — needs_review = false.
with both_sides as (
  select upper(btrim(v.insurance_co)) as nm
  from vob.member_benefits_latest v
  where nullif(btrim(v.insurance_co),'') is not null
  intersect
  select upper(btrim(r.primary_payer))
  from collections.cmd_explorer_charge_rollup r
  where nullif(btrim(r.primary_payer),'') is not null
), fresh as (
  select nm,
         'pi_' || left(btrim(regexp_replace(lower(nm), '[^a-z0-9]+', '_', 'g'), '_'), 77) as slug
  from both_sides b
  where not exists (select 1 from ref.payer_alias_map m
                     where m.alias_norm = b.nm
                       and m.vocabulary in ('claims_primary_payer','vob_insurance_co'))
)
insert into ref.payer_identity (canonical_payer_id, display_name, entity_kind)
select distinct on (slug) slug, nm, 'unclassified'   -- nm verbatim; initcap would mangle acronyms
from fresh where char_length(slug) >= 4               -- see the >= 4 rationale in section 7a
order by slug, nm
on conflict (canonical_payer_id) do nothing;

insert into ref.payer_alias_map
  (vocabulary, alias_norm, canonical_payer_id, relationship, provenance, needs_review)
select voc.v, b.nm, pi.canonical_payer_id, 'same_payer', 'exact_match', false
from (
  select upper(btrim(v.insurance_co)) as nm
  from vob.member_benefits_latest v
  where nullif(btrim(v.insurance_co),'') is not null
  intersect
  select upper(btrim(r.primary_payer))
  from collections.cmd_explorer_charge_rollup r
  where nullif(btrim(r.primary_payer),'') is not null
) b
join ref.payer_identity pi
  on pi.canonical_payer_id =
     'pi_' || left(btrim(regexp_replace(lower(b.nm), '[^a-z0-9]+', '_', 'g'), '_'), 77)
cross join (values ('claims_primary_payer'), ('vob_insurance_co')) as voc(v)
on conflict (vocabulary, alias_norm) do nothing;

-- 8c. `vob.payer_id` as a HINT ONLY. An id is recorded against a canonical only when every VOB name
--     carrying that id already resolves to EXACTLY ONE canonical — unanimity, not a majority vote.
--     Anything else lands unmapped + needs_review, because 163 ids carry multiple names and 367 names
--     span multiple ids, so this spine is a strong hint and never an identity.
with id_names as (
  select nullif(btrim(v.payer_id),'')      as pid,
         upper(btrim(v.insurance_co))      as nm
  from vob.member_benefits_latest v
  where nullif(btrim(v.payer_id),'') is not null
    and nullif(btrim(v.insurance_co),'') is not null
  group by 1,2
), resolved as (
  select i.pid,
         count(distinct m.canonical_payer_id) as canon_n,
         min(m.canonical_payer_id)            as canon
  from id_names i
  left join ref.payer_alias_map m
    on m.vocabulary = 'vob_insurance_co' and m.alias_norm = i.nm
   and m.canonical_payer_id is not null
  group by i.pid
)
insert into ref.payer_alias_map
  (vocabulary, alias_norm, canonical_payer_id, relationship, provenance, needs_review, review_note)
select 'vob_payer_id',
       upper(btrim(r.pid)),
       case when r.canon_n = 1 then r.canon else null end,
       case when r.canon_n = 1 then 'same_payer' else 'unmapped' end,
       'vob_payer_id',
       r.canon_n <> 1,
       case when r.canon_n = 0 then 'No VOB name under this payer_id resolves to a canonical yet.'
            when r.canon_n > 1 then 'VOB names under this payer_id resolve to ' || r.canon_n ||
                                    ' different canonicals — a human decides whether this id is one '
                                    'payer or several.'
       end
from resolved r
where char_length(btrim(r.pid)) between 1 and 200
on conflict (vocabulary, alias_norm) do nothing;

-- 8d. Trigram PROPOSALS for still-unmapped claims names. `claims.similarity` — pg_trgm lives in schema
--     `claims`. Proposed only where the best-matching VOB name resolves to exactly one canonical.
--     ALWAYS needs_review = true; the similarity score is recorded as `confidence` so a reviewer can
--     triage highest-first.
-- NOTE the split into claims_names + unmapped_claims. A correlated subquery in HAVING that references
-- the grouped column (`r.primary_payer`) is SQLSTATE 42803 — "subquery uses ungrouped column from outer
-- query" — even though the reference is to the grouping expression itself. Aggregate first, then
-- anti-join against the alias map on the already-grouped alias in a plain WHERE.
with claims_names as (
  select upper(btrim(r.primary_payer)) as nm, count(*) as lines
  from collections.cmd_explorer_charge_rollup r
  where nullif(btrim(r.primary_payer),'') is not null
  group by 1
), unmapped_claims as (
  select c.nm, c.lines
  from claims_names c
  where not exists (select 1 from ref.payer_alias_map m
                     where m.vocabulary = 'claims_primary_payer'
                       and m.alias_norm = c.nm)
), vob_canon as (
  select m.alias_norm as nm, m.canonical_payer_id
  from ref.payer_alias_map m
  where m.vocabulary = 'vob_insurance_co' and m.canonical_payer_id is not null
), best as (
  select u.nm,
         (select vc.canonical_payer_id
            from vob_canon vc
           order by claims.similarity(u.nm, vc.nm) desc, vc.canonical_payer_id
           limit 1)                                            as canon,
         (select max(claims.similarity(u.nm, vc.nm)) from vob_canon vc) as sim
  from unmapped_claims u
)
insert into ref.payer_alias_map
  (vocabulary, alias_norm, canonical_payer_id, relationship, provenance, confidence,
   needs_review, review_note)
select 'claims_primary_payer',
       b.nm,
       case when b.sim >= 0.50 then b.canon else null end,
       case when b.sim >= 0.50 then 'same_payer' else 'unmapped' end,
       case when b.sim >= 0.50 then 'trigram_proposal' else 'no_candidate' end,
       round(b.sim::numeric, 3),
       true,
       case when b.sim >= 0.50
            then 'Trigram proposal — CONFIRM OR REJECT. Similarity ' || round(b.sim::numeric,3) || '.'
            else 'No VOB candidate above 0.50 similarity. Likely an acronym/expansion pair that '
                 'trigram cannot bridge (measured: 48 such names, 47,656 lines). Needs a hand-entered '
                 'alias, or stays unmapped.'
       end
from best b
where b.sim is not null
on conflict (vocabulary, alias_norm) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 9. ACTIVE GUARDS — fail loud rather than let ON CONFLICT DO NOTHING hide a defect
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

-- 9a. Slug collision. Two DIFFERENT canonical names slugging to one id would silently merge two real
--     payers into one identity — the exact confidently-wrong outcome this table exists to prevent.
do $$
declare bad int;
begin
  select count(*) into bad from (
    select 'pi_' || left(btrim(regexp_replace(lower(btrim(canonical_name)),
                                              '[^a-z0-9]+', '_', 'g'), '_'), 77) as slug,
           count(distinct upper(btrim(canonical_name))) as names
    from ref.payer_alias
    where nullif(btrim(canonical_name),'') is not null
    group by 1
    having count(distinct upper(btrim(canonical_name))) > 1
  ) x;
  if bad > 0 then
    raise exception '026 slug collision: % surrogate id(s) derive from more than one distinct '
                    'canonical payer name. Disambiguate before seeding.', bad;
  end if;
end $$;

-- 9b. The pairing CHECK is table-level, but the program asymmetry is cross-row and cannot be a CHECK
--     (Postgres will not FK to a partial unique index). Assert it here instead.
do $$
declare bad int;
begin
  select count(*) into bad
  from ref.payer_alias_map m
  join ref.payer_identity pi on pi.canonical_payer_id = m.canonical_payer_id
  where pi.entity_kind = 'program';
  if bad > 0 then
    raise exception '026 invariant violated: % alias row(s) point canonical_payer_id at a '
                    'program-kind identity. A routing program is never a resolution target — the '
                    'alias must be relationship=program_label with a NULL canonical.', bad;
  end if;
end $$;

-- 9c. Every non-null canonical must exist (the FK guarantees it) AND every identity minted by the
--     generic seed should be reachable from at least one alias. An unreachable identity is the
--     signature of an upstream canonical-name change minting a fresh id — see the column comment.
do $$
declare orphans int;
begin
  select count(*) into orphans
  from ref.payer_identity pi
  where pi.entity_kind <> 'program'
    and not exists (select 1 from ref.payer_alias_map m
                     where m.canonical_payer_id = pi.canonical_payer_id);
  if orphans > 0 then
    raise warning '026: % identity row(s) have no alias pointing at them. Expected 0 for a first '
                  'apply; a non-zero count on a RE-apply means an upstream canonical name changed '
                  'and minted a new id that needs a human merge.', orphans;
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 10. Verification (run manually after apply)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- -- Posture: 2 tables, owned by claims_admin, RLS on, one read-all policy each, reader SELECT.
-- select c.relname, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity, c.relforcerowsecurity
--   from pg_class c join pg_namespace n on n.oid=c.relnamespace
--  where n.nspname='ref' and c.relname in ('payer_identity','payer_alias_map');           -- 2 rows
-- select tablename, policyname, cmd from pg_policies
--  where schemaname='ref' and tablename in ('payer_identity','payer_alias_map');          -- 2, both SELECT
-- select has_table_privilege('claims_reader','ref.payer_identity','SELECT'),
--        has_table_privilege('claims_reader','ref.payer_alias_map','SELECT');             -- t, t
-- select count(*) from information_schema.role_table_grants
--  where table_schema='ref' and table_name in ('payer_identity','payer_alias_map')
--    and grantee in ('anon','authenticated','service_role','PUBLIC');                     -- 0
-- select indexname from pg_indexes where schemaname='ref'
--    and tablename in ('payer_identity','payer_alias_map') order by 1;                    -- 5 + 2 pkeys
--
-- -- The program asymmetry (9b) and self-administration, re-asserted as queries:
-- select count(*) from ref.payer_alias_map m join ref.payer_identity pi
--        on pi.canonical_payer_id=m.canonical_payer_id where pi.entity_kind='program';    -- 0
-- select count(*) from ref.payer_identity where administers_for = canonical_payer_id;     -- 0
-- -- administers_for cycles longer than 1 (not expressible as a CHECK):
-- with recursive walk(id, chain, cyc) as (
--   select canonical_payer_id, array[canonical_payer_id], false from ref.payer_identity
--   union all
--   select p.administers_for, w.chain || p.administers_for, p.administers_for = any(w.chain)
--     from walk w join ref.payer_identity p on p.canonical_payer_id = w.id
--    where p.administers_for is not null and not w.cyc
-- ) select count(*) from walk where cyc;                                                  -- 0
--
-- -- P0 COVERAGE REPORT — run these against the POPULATED table; they supersede the pre-apply estimate.
-- -- (i) claim volume mapped to a canonical, and the honest unmapped share:
-- with c as (select upper(btrim(primary_payer)) nm, count(*) lines
--              from collections.cmd_explorer_charge_rollup
--             where nullif(btrim(primary_payer),'') is not null group by 1)
-- select sum(lines) as total_lines,
--        sum(lines) filter (where m.canonical_payer_id is not null)                as mapped_lines,
--        round(100.0*sum(lines) filter (where m.canonical_payer_id is not null)
--                   /sum(lines),1)                                                as pct_mapped,
--        sum(lines) filter (where m.relationship = 'program_label')                as program_lines,
--        sum(lines) filter (where m.relationship = 'unmapped')                     as unmapped_lines,
--        sum(lines) filter (where m.needs_review)                                  as needs_review_lines,
--        sum(lines) filter (where m.alias_norm is null)                            as no_alias_row
--   from c left join ref.payer_alias_map m
--     on m.vocabulary='claims_primary_payer' and m.alias_norm = c.nm;
-- -- (ii) VOB members mapped:
-- select count(distinct v.member_id_bidx)                                          as members_total,
--        count(distinct v.member_id_bidx) filter (where m.canonical_payer_id is not null)
--                                                                                  as members_mapped
--   from vob.member_benefits_latest v
--   left join ref.payer_alias_map m
--     on m.vocabulary='vob_insurance_co' and m.alias_norm = upper(btrim(v.insurance_co));
-- -- (iii) the review queue, volume-ordered (this is the human work list):
-- with c as (select upper(btrim(primary_payer)) nm, count(*) lines
--              from collections.cmd_explorer_charge_rollup
--             where nullif(btrim(primary_payer),'') is not null group by 1)
-- select m.provenance, m.relationship, count(*) as names, sum(c.lines) as lines
--   from ref.payer_alias_map m join c on c.nm = m.alias_norm
--  where m.vocabulary='claims_primary_payer' and m.needs_review
--  group by 1,2 order by lines desc nulls last;
