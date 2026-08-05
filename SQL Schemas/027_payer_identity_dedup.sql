-- 027 — canonical payer dedup: collapse 10 duplicate-identity components, and make the
--       "these two are NOT the same payer" rulings structural instead of remembered.
--
-- WHY: 026 minted `ref.payer_identity` from a generic slug ladder, which produced SEVERAL ROWS FOR
--   ONE REAL PAYER — `pi_anthem_california`, `pi_anthem_blue_cross_of_california` and
--   `pi_bcbs_california` are one company under three ids. Left alone, D2 resolution would return
--   the same payer as multiple "candidates", which is precisely the ambiguity v3 exists to remove:
--   the user would be asked to choose between two spellings of one answer.
--
--   MEASURED (2026-08-04, live): 15 machine-proposed merge CASES collapse to 12 distinct id pairs
--   (three pairs were double-counted — two alias cases pointing at one pair, for NH, NV and MD),
--   which form 11 connected components over 23 nodes. Health Net is PARKED as uncertain (R2), so
--   **10 components execute here**, absorbing 11 nodes.
--
--   A pair is not a graph. `{pi_bcbs_california, pi_anthem_california,
--   pi_anthem_blue_cross_of_california}` is one THREE-node component; merging it as two independent
--   pairs in arbitrary order can leave a dangling reference to a node another pair already deleted.
--   Section 6 therefore resolves components, not pairs, and every absorbed node names its survivor
--   in one plan table before a single row moves.
--
-- SURVIVOR RULE (ratified R3): (1) greatest aggregate claim-line volume across the node's aliases —
--   the most-referenced id, so the fewest rows move; (2) tie-break most name aliases; (3) tie-break
--   lexicographically smallest id, for determinism. The rule picks the ID. `display_name` is a
--   SEPARATE human decision per component (section 8) — volume does not know licensee branding.
--   New Hampshire is the worked example: volume picks `pi_bcbs_new_hampshire` (86 lines vs 47) while
--   the actual NH licensee brands as Anthem, so the id and the name come from different authorities
--   on purpose.
--
-- THE POINT OF `payer_identity_never_merge`: eight review rulings said "textually similar, DIFFERENT
--   payers". Three of them name a node this very migration deletes
--   (`pi_bcbs_california`, `pi_bcbs_nevada`). A ruling that stops applying because its target got
--   merged away is the silent-heuristic failure mode relocated — the same class of defect as the
--   dominant-payer heuristic, just later and quieter. So the constraint is a TABLE with
--   `ON DELETE RESTRICT` FKs: after this migration, a future merge CANNOT delete a constrained node
--   without explicitly repointing the ruling first. The database refuses, rather than a reviewer
--   remembering. Section 7 repoints the two affected rulings and asserts the collapse case.
--
-- PHI DISCIPLINE: none. Payer identity is public reference data — company names and rulings about
--   them. Both new tables are non-PHI by construction: no member, patient, employer or dollar
--   column exists or may be added (section 11's verification block scans for the denylist). Same
--   posture as 025/026.
--
-- OWNERSHIP: born owned by `claims_admin` via `SET ROLE` (the standing apply posture — see
--   veris-data-notes.md "Apply-path privilege model"). `apply_migration` runs as `postgres`, a
--   non-superuser with SET-capable membership in `claims_admin`.
--
-- IDEMPOTENT: `IF NOT EXISTS` on both tables/indexes, `DROP POLICY IF EXISTS` before CREATE, and
--   every data step is a set operation keyed on the plan table. A second run finds zero absorbed
--   ids live, so sections 6-10 move zero rows and section 4's seed is `ON CONFLICT DO NOTHING`.
--   Re-running after success is a no-op, NOT a second merge.
--
-- ⚠ FAIL-LOUD, WHOLE-MIGRATION: `apply_migration` wraps this in ONE transaction, so the
--   "one transaction per component" requirement is satisfied more strongly than asked — either all
--   10 components land or none do. Consequence, deliberate: a never-merge collapse (section 7) or a
--   post-condition failure (section 10) aborts EVERY component, not just the offending one. That is
--   the correct posture. A never-merge collapse means the merge plan itself is wrong, and a plan that
--   is wrong about one payer has not earned the benefit of the doubt on the other nine.
--
-- DEPENDENCY: 026 (both tables, applied live 2026-08-04). Reads nothing outside `ref`.
--
-- Rollback: 027_payer_identity_dedup_rollback.sql — and read its DATA-LOSS header first: the
--   rollback restores the split identities but CANNOT restore which alias pointed where.

set role claims_admin;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. ref.payer_identity_never_merge — adjudicated "NOT the same payer" rulings
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- The pair is UNORDERED (A-is-not-B == B-is-not-A) but stored ONCE, normalized so that
-- id_low < id_high. Without that CHECK the same ruling could exist twice in opposite orders and a
-- lookup that only checked one direction would silently miss it.
--
-- ON DELETE RESTRICT on BOTH sides is the entire mechanism. It is not defensive decoration: it is
-- what converts "remember to re-check the rulings when you merge" into "the merge fails".

create table if not exists ref.payer_identity_never_merge (
  id_low   text not null,
  id_high  text not null,
  reason   text not null,
  ruled_by text not null,
  ruled_at timestamptz not null default now(),

  constraint payer_identity_never_merge_pkey primary key (id_low, id_high),

  constraint payer_identity_never_merge_low_fkey
    foreign key (id_low)  references ref.payer_identity (canonical_payer_id) on delete restrict,
  constraint payer_identity_never_merge_high_fkey
    foreign key (id_high) references ref.payer_identity (canonical_payer_id) on delete restrict,

  -- Normalized ordering. Also makes a self-pair (id_low = id_high) unrepresentable, so "these two
  -- are not the same payer" can never degenerate into a statement about one payer.
  constraint payer_identity_never_merge_ordered check (id_low < id_high),
  constraint payer_identity_never_merge_reason_len   check (char_length(reason) between 4 and 500),
  constraint payer_identity_never_merge_ruled_by_len check (char_length(ruled_by) between 2 and 120)
);

create index if not exists payer_identity_never_merge_high_idx
  on ref.payer_identity_never_merge (id_high);

comment on table ref.payer_identity_never_merge is
  'Adjudicated rulings that two canonical payer identities are DIFFERENT companies despite textual '
  'similarity. Pairs are unordered but stored once, normalized id_low < id_high. Both FKs are '
  'ON DELETE RESTRICT so a later merge cannot silently delete a node a ruling depends on — the '
  'merge must repoint the ruling first, or it fails. Non-PHI: public payer reference data.';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. ref.payer_identity_merge_log — the audit trail for every absorbed identity
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- R5: `payer_identity` keeps its grain — ONE ROW PER LIVE PAYER. Absorbed rows are DELETED, not
-- tombstoned with a `merged_into` column. A tombstone is a footgun: every future query would have to
-- remember to filter it, and the one that forgets resurrects a duplicate candidate in the UI. The
-- history lives here instead, where nothing resolving a payer will ever accidentally read it.
--
-- NO FK on absorbed_id — by design. It names a row this migration deletes; an FK would be
-- unsatisfiable. survivor_id likewise carries no FK, so a later legitimate merge of a survivor is
-- not blocked by its own history.

create table if not exists ref.payer_identity_merge_log (
  absorbed_id            text not null,
  survivor_id            text not null,
  absorbed_display_name  text not null,
  aliases_repointed      integer not null,
  merged_at              timestamptz not null default now(),
  migration_no           text not null,

  constraint payer_identity_merge_log_pkey primary key (absorbed_id),
  constraint payer_identity_merge_log_distinct check (absorbed_id <> survivor_id),
  constraint payer_identity_merge_log_absorbed_shape check (absorbed_id ~ '^pi_[a-z0-9_]+$'),
  constraint payer_identity_merge_log_survivor_shape check (survivor_id ~ '^pi_[a-z0-9_]+$'),
  constraint payer_identity_merge_log_migration_no_len check (char_length(migration_no) between 3 and 20)
);

create index if not exists payer_identity_merge_log_survivor_idx
  on ref.payer_identity_merge_log (survivor_id);

comment on table ref.payer_identity_merge_log is
  'Append-only record of canonical payer identities absorbed by a merge: which id disappeared, into '
  'which survivor, and how many alias rows moved. Deliberately carries NO foreign keys — absorbed_id '
  'names a deleted row. This is the reason payer_identity needs no merged_into tombstone column. '
  'Non-PHI: public payer reference data.';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. RLS + grants — identical posture to 026 (RLS on, one read-all SELECT policy, reader SELECT)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

alter table ref.payer_identity_never_merge enable row level security;
alter table ref.payer_identity_merge_log   enable row level security;

drop policy if exists payer_identity_never_merge_read_all on ref.payer_identity_never_merge;
create policy payer_identity_never_merge_read_all
  on ref.payer_identity_never_merge for select using (true);

drop policy if exists payer_identity_merge_log_read_all on ref.payer_identity_merge_log;
create policy payer_identity_merge_log_read_all
  on ref.payer_identity_merge_log for select using (true);

grant select on ref.payer_identity_never_merge to claims_reader;
grant select on ref.payer_identity_merge_log   to claims_reader;

-- No write grant to any non-owner role. Both tables are maintained by migrations and by the
-- (not yet built) human-review surface, which will need its own narrow writer role — deliberately
-- NOT minted here, because a writer with no caller is a standing surface with no owner.

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. Seed the 6 distinct DO-NOT-MERGE rulings — against CURRENT ids, BEFORE any merge
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Order matters and is not cosmetic. Seeding pre-merge means section 7's repoint has to actually
-- move these rows, which EXERCISES the mechanism instead of sidestepping it. Seeding post-merge
-- would let us write the already-correct answer and never test that a stale ruling gets carried
-- forward.
--
-- 8 review cases → 6 distinct pairs: `pi_blue_shield_california`/`pi_bcbs_california` was raised
-- twice (by "BLUESHIELD OF CA" and by "BS OF CA") and
-- `pi_independence_administrators`/`pi_independence_pennsylvania` twice likewise. A pair adjudicated
-- twice is one ruling, and the PK enforces that.
--
-- least()/greatest() normalize the ordering rather than hand-sorted literals — a hand-sorted pair is
-- a silent CHECK violation waiting for the first id that sorts differently than it reads.

insert into ref.payer_identity_never_merge (id_low, id_high, reason, ruled_by)
select least(a, b), greatest(a, b), reason, 'alec@treathealth.ai (027 review, 2026-08-04)'
  from (values
    ('pi_bcbs_north_carolina', 'pi_bcbs_south_carolina',
     'Different states. Separate BCBS licensees; the shared tokens are BCBS + CAROLINA.'),
    ('pi_blue_shield_california', 'pi_bcbs_california',
     'Blue Shield of California and Anthem Blue Cross of California are different companies. '
     'California is the one state where the Cross and Shield licences never merged.'),
    ('pi_capital_blue_cross_pennsylvania', 'pi_bcbs_pennsylvania',
     'Capital Blue Cross is a distinct central-PA licensee, not the statewide plan.'),
    ('pi_health_plan_of_nevada', 'pi_bcbs_nevada',
     'Health Plan of Nevada is a UnitedHealth/Sierra entity, unrelated to the NV BCBS licensee.'),
    ('pi_independence_administrators', 'pi_independence_pennsylvania',
     'TPA versus the plan it administers. Merging them would erase the administers_for '
     'relationship that makes self-funded coverage legible.'),
    ('pi_medicare', 'pi_united_healthcare_medicare_advantage',
     'Traditional Medicare versus a Medicare Advantage plan. Different payers, different '
     'adjudication, and the reimbursement question a rep asks differs between them.')
  ) as v(a, b, reason)
on conflict (id_low, id_high) do nothing;

-- Guard: all 12 referenced ids must exist, or a ruling silently failed to land. The FKs already
-- enforce this (an absent id raises 23503), so this block converts that into a named, countable
-- assertion rather than a bare constraint error 20 statements from its cause.
do $$
declare
  n integer;
begin
  select count(*) into n from ref.payer_identity_never_merge;
  if n <> 6 then
    raise exception '027 section 4: expected 6 never-merge rulings, found %. The seed did not land whole.', n;
  end if;
end
$$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 5. The merge plan — 10 components, 11 absorbed nodes, resolved as a graph before anything moves
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- One row per ABSORBED node, naming its component's survivor. Component 1 has two absorbed rows
-- pointing at one survivor — that is the three-node component, expressed without ever forming an
-- intermediate pairwise state.
--
-- Volumes in the comments are live claim-line counts measured 2026-08-04 and are the survivor rule's
-- input, recorded so a reviewer can audit the choice without re-running the query.

create temporary table _027_plan (
  component     integer not null,
  absorbed_id   text    not null primary key,
  survivor_id   text    not null
) on commit drop;

insert into _027_plan (component, absorbed_id, survivor_id) values
  -- Component 1 — California, THREE nodes. Survivor 271,018 lines / 12 aliases; the absorbed carry
  -- 44,246 / 2 and 174 / 2. Note pi_bcbs_california is also a never-merge target (section 7).
  (1, 'pi_anthem_blue_cross_of_california', 'pi_anthem_california'),
  (1, 'pi_bcbs_california',                 'pi_anthem_california'),
  -- Component 2 — New Hampshire. 86 lines survives 47. Volume and branding disagree here; see §8.
  (2, 'pi_anthem_new_hampshire',            'pi_bcbs_new_hampshire'),
  -- Component 3 — Nevada. 68 survives 0. pi_bcbs_nevada is also a never-merge target (section 7).
  (3, 'pi_bcbs_nevada',                     'pi_anthem_nevada'),
  -- Component 4 — Georgia. 1,244 survives 678.
  (4, 'pi_bcbs_georgia',                    'pi_anthem_georgia'),
  -- Component 5 — Indiana. 813 survives 404.
  (5, 'pi_bcbs_indiana',                    'pi_anthem_indiana'),
  -- Component 6 — Kentucky. 1,464 survives 88.
  (6, 'pi_bcbs_kentucky',                   'pi_anthem_kentucky'),
  -- Component 7 — Ohio. 2,170 survives 0.
  (7, 'pi_bcbs_ohio',                       'pi_anthem_ohio'),
  -- Component 8 — Maryland. 230 survives 102 (CareFirst is also the correct licensee name).
  (8, 'pi_bcbs_maryland',                   'pi_carefirst_maryland'),
  -- Component 9 — Premera. 372 survives 112.
  (9, 'pi_premera_bcbs',                    'pi_premera_washington'),
  -- Component 10 — Federal Employee Program. 374 survives 12.
  (10, 'pi_bcbs_fep',                       'pi_bcbs_federal');

-- PARKED, deliberately absent from the plan (R2): pi_healthnet / pi_health_net_california. Health
-- Net California may be a distinct subsidiary rather than a spelling variant, and a wrong merge here
-- is unrecoverable without knowing which alias pointed where. Recorded in veris-data-notes.md as an
-- open domain question. Also parked, same reason: ambetter_florida/ambetter_health,
-- anthem_bcbs/anthem_california, bcbs_pennsylvania/highmark_pennsylvania,
-- bcbs_washington/regence_washington.

-- Plan integrity guards — every one of these has a plausible authoring mistake behind it.
do $$
declare
  bad text;
  n   integer;
begin
  -- (a) A node cannot be both absorbed and a survivor. That would mean the component was not fully
  --     resolved, and the merge order would silently decide the outcome.
  select string_agg(p.absorbed_id, ', ') into bad
    from _027_plan p
   where exists (select 1 from _027_plan q where q.survivor_id = p.absorbed_id);
  if bad is not null then
    raise exception '027 section 5: node(s) appear as BOTH absorbed and survivor: %. The component graph is unresolved.', bad;
  end if;

  -- (b) Every id in the plan must exist live. A typo'd id would otherwise repoint nothing and delete
  --     nothing, and the migration would report success having done half the work.
  select string_agg(x.id, ', ') into bad
    from (select absorbed_id as id from _027_plan
          union select survivor_id from _027_plan) x
   where not exists (select 1 from ref.payer_identity i where i.canonical_payer_id = x.id);
  if bad is not null then
    raise exception '027 section 5: plan references identities that do not exist live: %', bad;
  end if;

  -- (c) Shape assertion: 11 absorbed nodes across 10 components.
  select count(*) into n from _027_plan;
  if n <> 11 then
    raise exception '027 section 5: expected 11 absorbed nodes, plan has %', n;
  end if;
  select count(distinct component) into n from _027_plan;
  if n <> 10 then
    raise exception '027 section 5: expected 10 components, plan has %', n;
  end if;
end
$$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 6. Repoint the DO-NOT-MERGE rulings absorbed → survivor, and assert no ruling collapses
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- THIS RUNS BEFORE the alias repoint and before the delete, because it is the step that can veto the
-- whole plan. If substituting survivors makes a ruling's two sides equal, the plan is asserting that
-- A and B are the same payer while a human ruling says they are not — the machine loses, loudly.
--
-- Implemented as delete-then-reinsert rather than UPDATE: the repointed pair may already exist as a
-- row (two rulings can converge on one pair once their targets merge), and an in-place UPDATE would
-- hit the primary key instead of deduplicating. `ON CONFLICT DO NOTHING` makes convergence a
-- non-event, which is the correct semantics — two rulings that become the same ruling ARE one ruling.

create temporary table _027_never_merge_remapped as
select least(low_new, high_new)  as id_low,
       greatest(low_new, high_new) as id_high,
       reason,
       ruled_by,
       ruled_at
  from (
    select coalesce(pl.survivor_id, nm.id_low)  as low_new,
           coalesce(ph.survivor_id, nm.id_high) as high_new,
           nm.reason, nm.ruled_by, nm.ruled_at
      from ref.payer_identity_never_merge nm
      left join _027_plan pl on pl.absorbed_id = nm.id_low
      left join _027_plan ph on ph.absorbed_id = nm.id_high
  ) s;

do $$
declare
  collapsed text;
  n_before  integer;
  n_after   integer;
begin
  -- THE VETO. A collapse means the merge plan and a human ruling contradict each other.
  select string_agg(format('%s (reason: %s)', id_low, reason), ' | ')
    into collapsed
    from _027_never_merge_remapped
   where id_low = id_high;
  if collapsed is not null then
    raise exception
      '027 section 6: MERGE PLAN VIOLATES A NEVER-MERGE RULING. Repointing would collapse: %. '
      'The whole migration is aborted deliberately — fix the plan, not the ruling.', collapsed;
  end if;

  select count(*) into n_before from ref.payer_identity_never_merge;
  delete from ref.payer_identity_never_merge;
  insert into ref.payer_identity_never_merge (id_low, id_high, reason, ruled_by, ruled_at)
  select id_low, id_high, reason, ruled_by, ruled_at from _027_never_merge_remapped
  on conflict (id_low, id_high) do nothing;
  select count(*) into n_after from ref.payer_identity_never_merge;

  -- No ruling may be LOST. Rows may merge (n_after < n_before) only via a genuine convergence, which
  -- for this data set does not occur — so assert equality and force a re-read if that ever changes.
  if n_after <> n_before then
    raise exception '027 section 6: never-merge count changed % -> % during repoint. A ruling was lost or converged unexpectedly.',
      n_before, n_after;
  end if;

  -- And nothing may still point at a node about to be deleted.
  select string_agg(nm.id_low || '/' || nm.id_high, ', ') into collapsed
    from ref.payer_identity_never_merge nm
   where exists (select 1 from _027_plan p where p.absorbed_id in (nm.id_low, nm.id_high));
  if collapsed is not null then
    raise exception '027 section 6: never-merge rows still reference an absorbed id: %', collapsed;
  end if;
end
$$;

drop table _027_never_merge_remapped;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 7. Repoint payer_alias_map.canonical_payer_id, then administers_for
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- The alias PK is (vocabulary, alias_norm) and this UPDATE touches neither, so it cannot conflict.
-- The relationship/canonical pairing CHECK is likewise untouched: a non-null canonical stays non-null.

-- Per-absorbed alias counts, captured BEFORE the update — after it, they are indistinguishable from
-- the survivor's own aliases, and the merge log would lose the only number that says how much moved.
create temporary table _027_alias_counts as
select p.absorbed_id, count(m.alias_norm)::integer as n
  from _027_plan p
  left join ref.payer_alias_map m on m.canonical_payer_id = p.absorbed_id
 group by p.absorbed_id;

do $$
declare
  moved integer;
begin
  update ref.payer_alias_map m
     set canonical_payer_id = p.survivor_id
    from _027_plan p
   where m.canonical_payer_id = p.absorbed_id;
  get diagnostics moved = row_count;
  raise notice '027 section 7: repointed % alias row(s) to survivors', moved;

  -- administers_for: zero rows carry it today (verified live 2026-08-04, all 33 nodes null), so this
  -- moves nothing. It runs anyway — the carve-out administrators are an OPEN item, and the day one
  -- is set is exactly the day a migration that skipped this step would orphan it.
  update ref.payer_identity i
     set administers_for = p.survivor_id,
         updated_at = now()
    from _027_plan p
   where i.administers_for = p.absorbed_id;
  get diagnostics moved = row_count;
  raise notice '027 section 7: repointed % administers_for reference(s)', moved;
end
$$;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 8. display_name per component — the licensee-correct branding (R3)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Set explicitly per survivor, NOT derived. Every one of these is a human call that a rule would get
-- wrong: NH's id says BCBS while its licensee is Anthem; Maryland's licensee is CareFirst, not
-- "BCBS Maryland"; Premera is Blue Cross only, never Blue Shield.
--
-- ⚠ CONVENTION DIVERGENCE, recorded not hidden: 026 seeded every display_name in UPPER CASE (it
-- dropped initcap() because it mangled acronyms — BCBS became Bcbs). These 10 names land in mixed
-- case, as ratified. The other ~189 identities keep upper case, so display_name is now mixed-
-- convention. That is a display-layer inconsistency, not a data defect, and completing the pass is
-- a follow-up rather than something to guess at here.

update ref.payer_identity set display_name = v.name, updated_at = now()
  from (values
    ('pi_anthem_california',    'Anthem Blue Cross of California'),
    ('pi_bcbs_new_hampshire',   'Anthem Blue Cross and Blue Shield of New Hampshire'),
    ('pi_anthem_nevada',        'Anthem Blue Cross and Blue Shield of Nevada'),
    ('pi_anthem_georgia',       'Anthem Blue Cross and Blue Shield of Georgia'),
    ('pi_anthem_indiana',       'Anthem Blue Cross and Blue Shield of Indiana'),
    ('pi_anthem_kentucky',      'Anthem Blue Cross and Blue Shield of Kentucky'),
    ('pi_anthem_ohio',          'Anthem Blue Cross and Blue Shield of Ohio'),
    ('pi_carefirst_maryland',   'CareFirst BlueCross BlueShield'),
    ('pi_premera_washington',   'Premera Blue Cross'),
    ('pi_bcbs_federal',         'Blue Cross Blue Shield Federal Employee Program')
  ) as v(id, name)
 where ref.payer_identity.canonical_payer_id = v.id;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 9. Write the merge log, then delete the absorbed identities
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Log BEFORE delete: `absorbed_display_name` is only readable while the row exists.

insert into ref.payer_identity_merge_log
  (absorbed_id, survivor_id, absorbed_display_name, aliases_repointed, migration_no)
select p.absorbed_id, p.survivor_id, i.display_name, coalesce(c.n, 0), '027'
  from _027_plan p
  join ref.payer_identity i on i.canonical_payer_id = p.absorbed_id
  left join _027_alias_counts c on c.absorbed_id = p.absorbed_id
on conflict (absorbed_id) do nothing;

-- The delete. Both FKs into payer_identity are NO ACTION, so if section 7 had missed an alias row
-- this raises 23503 and rolls the migration back rather than orphaning a reference. That is a
-- deliberate reliance on the constraint as a second opinion, not an assumption that section 7 worked.
delete from ref.payer_identity i
 where i.canonical_payer_id in (select absorbed_id from _027_plan);

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 10. Post-conditions — asserted IN the migration, so a failure rolls back instead of shipping
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

do $$
declare
  bad text;
  n   integer;
begin
  -- (a) Zero absorbed ids survive anywhere: identity, alias map, administers_for, never_merge.
  select string_agg(p.absorbed_id, ', ') into bad from _027_plan p
   where exists (select 1 from ref.payer_identity  i where i.canonical_payer_id = p.absorbed_id)
      or exists (select 1 from ref.payer_alias_map m where m.canonical_payer_id = p.absorbed_id)
      or exists (select 1 from ref.payer_identity  i where i.administers_for    = p.absorbed_id)
      or exists (select 1 from ref.payer_identity_never_merge nm
                  where p.absorbed_id in (nm.id_low, nm.id_high));
  if bad is not null then
    raise exception '027 section 10: absorbed id(s) still referenced after merge: %', bad;
  end if;

  -- (b) Every survivor still exists. Deleting a survivor would be catastrophic and silent.
  select string_agg(distinct p.survivor_id, ', ') into bad from _027_plan p
   where not exists (select 1 from ref.payer_identity i where i.canonical_payer_id = p.survivor_id);
  if bad is not null then
    raise exception '027 section 10: survivor(s) missing after merge: %', bad;
  end if;

  -- (c) merge_log accounts for every absorbed node, exactly once.
  select count(*) into n from ref.payer_identity_merge_log where migration_no = '027';
  if n <> 11 then
    raise exception '027 section 10: merge_log has % rows for 027, expected 11', n;
  end if;

  -- (d) The 6 rulings survived, and every one references a LIVE identity.
  select count(*) into n from ref.payer_identity_never_merge;
  if n <> 6 then
    raise exception '027 section 10: never_merge has % rows, expected 6', n;
  end if;

  -- (e) No alias row was orphaned or nulled by the repoint. A resolving relationship must still name
  --     a canonical — the 026 pairing CHECK would have caught a null, but not a *count* change.
  select count(*) into n from ref.payer_alias_map
   where relationship in ('same_payer','carve_out','tpa','employer_self_funded')
     and canonical_payer_id is null;
  if n <> 0 then
    raise exception '027 section 10: % resolving alias row(s) lost their canonical', n;
  end if;

  -- (f) The RESTRICT semantics are what we claim. Checking the catalog, not the DDL text, because
  --     the DDL text is what we WROTE and the catalog is what POSTGRES DID.
  select count(*) into n from pg_constraint
   where conrelid = 'ref.payer_identity_never_merge'::regclass
     and contype = 'f' and confdeltype = 'r';
  if n <> 2 then
    raise exception '027 section 10: expected 2 ON DELETE RESTRICT FKs on never_merge, catalog reports %', n;
  end if;

  raise notice '027: all post-conditions green — 10 components merged, 11 nodes absorbed, 6 rulings live';
end
$$;

-- (g) EXERCISE the guard rather than trusting it. "ON DELETE RESTRICT protects the rulings" is a
--     claim about DDL until something tries to break it.
--
--     The probe uses a THROWAWAY identity, not one of the six real ones, and the reason is the whole
--     point of the test: every real never-merge node also has alias rows pointing at it, so deleting
--     one raises foreign_key_violation from EITHER constraint — and a probe that cannot tell which
--     one fired would pass even if never_merge weren't protecting anything. The throwaway has zero
--     alias rows, so never_merge is the only possible blocker. The constraint name is then read from
--     the error itself rather than inferred.
do $$
declare
  probe_id   constant text := 'pi_zz_027_probe';
  partner    text;
  refused_by text := null;
begin
  insert into ref.payer_identity (canonical_payer_id, display_name, entity_kind, notes)
  values (probe_id, 'ZZ 027 RESTRICT PROBE', 'unclassified',
          'Transient probe row created and removed inside migration 027. If this row is visible, 027 aborted mid-flight.');

  select id_low into partner from ref.payer_identity_never_merge order by id_low limit 1;
  insert into ref.payer_identity_never_merge (id_low, id_high, reason, ruled_by)
  values (least(partner, probe_id), greatest(partner, probe_id),
          'Transient 027 probe pairing — asserts ON DELETE RESTRICT actually refuses.', '027 self-test');

  begin
    delete from ref.payer_identity where canonical_payer_id = probe_id;
  exception when foreign_key_violation then
    get stacked diagnostics refused_by = constraint_name;
  end;

  if refused_by is null then
    raise exception '027 section 10g: deleting a never-merge-constrained identity was ALLOWED. ON DELETE RESTRICT is not protecting the rulings.';
  end if;
  if refused_by not like 'payer_identity_never_merge%' then
    raise exception '027 section 10g: delete was refused by %, not by the never_merge FK. The probe proved the wrong thing.', refused_by;
  end if;

  -- Clean up in dependency order. The identity delete MUST succeed now that the ruling is gone —
  -- if it does not, RESTRICT is over-blocking and that is equally a defect.
  delete from ref.payer_identity_never_merge where probe_id in (id_low, id_high);
  delete from ref.payer_identity where canonical_payer_id = probe_id;
  if exists (select 1 from ref.payer_identity where canonical_payer_id = probe_id) then
    raise exception '027 section 10g: probe identity survived its own cleanup';
  end if;

  raise notice '027 section 10g: verified — % refused the delete, probe removed cleanly', refused_by;
end
$$;

-- Final count re-assertion AFTER the probe, so the probe cannot leave the tables changed.
do $$
declare
  n_id integer; n_nm integer;
begin
  select count(*) into n_id from ref.payer_identity;
  select count(*) into n_nm from ref.payer_identity_never_merge;
  if n_nm <> 6 then
    raise exception '027: never_merge is % rows after the probe, expected 6', n_nm;
  end if;
  raise notice '027: final state — % live identities, % never-merge rulings', n_id, n_nm;
end
$$;

drop table _027_alias_counts;

reset role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- 11. Verification (run manually after apply)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
--
-- -- Posture on both new tables (expect: claims_admin / true / false, twice):
-- select c.relname, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity, c.relforcerowsecurity
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'ref' and c.relname in ('payer_identity_never_merge','payer_identity_merge_log');
--
-- -- Exactly one SELECT policy each, zero non-SELECT:
-- select tablename, policyname, cmd from pg_policies
--  where schemaname = 'ref' and tablename like 'payer_identity_%merge%';
--
-- -- Grants: claims_reader SELECT only; ZERO to anon/authenticated/service_role/PUBLIC:
-- select grantee, table_name, string_agg(privilege_type, ',') from information_schema.role_table_grants
--  where table_schema = 'ref' and table_name in ('payer_identity_never_merge','payer_identity_merge_log')
--  group by 1,2 order by 1;
--
-- -- Identity count fell by exactly 11 (199 -> 188), and no duplicate display_name remains among the
-- -- merged components:
-- select count(*) from ref.payer_identity;                                          -- 188
-- select count(*) from ref.payer_identity_merge_log where migration_no = '027';      -- 11
-- select count(*) from ref.payer_identity_never_merge;                               -- 6
--
-- -- The two repointed rulings now name survivors (expect pi_anthem_california and pi_anthem_nevada):
-- select id_low, id_high from ref.payer_identity_never_merge
--  where id_low like '%anthem%' or id_high like '%anthem%' order by 1;
--
-- -- PHI denylist scan on both new tables — expect 0 rows:
-- select table_name, column_name from information_schema.columns
--  where table_schema = 'ref' and table_name in ('payer_identity_never_merge','payer_identity_merge_log')
--    and column_name ~* 'patient|member|client|subscriber|employer|dob|ssn|amount|charge|paid';
--
-- -- Alias rows now concentrated on survivors (component 1 should hold 15 + 5 + 7 = 27):
-- select canonical_payer_id, count(*) from ref.payer_alias_map
--  where canonical_payer_id in ('pi_anthem_california','pi_anthem_ohio','pi_bcbs_federal')
--  group by 1 order by 2 desc;
--
-- -- Security advisors — expect {"lints":[]} for these two tables:
-- --   (Supabase MCP: get_advisors type=security)
