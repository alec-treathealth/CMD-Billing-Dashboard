-- 025 — intel schema: payer policy intelligence for Qualify RAG
--
-- WHY: Monthly payer/federal policy research needs a durable, dedupable home.
--   Measured from the 2026-08-03 nine-key probe batch (scripts/payer_intel_probe.ts):
--   814 retrieved URLs -> 10 findings, 38 unreachable, 34 checked-no-change.
--   finding_hash (payer_plan|change_type|date_effective|source_url) produced
--   10/10 distinct tuples with zero collisions on that real data, including two
--   pairs sharing a source_url, which is why it is the dedup key here.
--   This is industry reference intelligence, NOT tenant data: no business_entity_id.
-- PHI DISCIPLINE: contains NO PHI. Every row originates from a public payer
--   bulletin, CMS fact sheet, Federal Register document, or standards-body page.
--   Nothing here is patient-, member-, or claim-derived, and nothing joins to a
--   PHI table. Deliberately NOT placed in `staging` (PHI/tenant RLS regime) nor
--   in `ref` (whose 13 tables share a verified owner-only/no-writer invariant set
--   in 015 that a writer role would permanently erode).
-- OWNERSHIP: schema and all three tables born owned by claims_admin via SET ROLE.
--   Reads: claims_reader (SELECT). Writes: intel_writer (INSERT, UPDATE only —
--   never DELETE, at both the grant and the policy layer).
-- IDEMPOTENT: CREATE ... IF NOT EXISTS throughout; DROP POLICY IF EXISTS before
--   every CREATE POLICY (else SQLSTATE 42710); role is CREATE-if-absent and never
--   dropped; all REVOKE/GRANT are unconditional and repeatable.
-- DEPENDENCY: extensions.halfvec / hnsw from pgvector 0.8.0, already installed in
--   schema `extensions` (see 011/012, which use the identical halfvec(1024) +
--   halfvec_cosine_ops shape). No other migration required.
-- Rollback: 025_payer_policy_intel_rollback.sql

-- Objects are born owned by claims_admin. apply_migration runs as `postgres`,
-- a non-superuser holding `GRANT claims_admin TO postgres WITH SET TRUE`.
SET ROLE claims_admin;

-- ---------------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS intel;
COMMENT ON SCHEMA intel IS
  'Non-PHI, tenant-agnostic industry reference intelligence. Payer and federal '
  'policy findings for Qualify RAG. No PHI, no business_entity_id, no joins to '
  'patient/member/claim data.';

REVOKE ALL ON SCHEMA intel FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 2. Writer role
-- ---------------------------------------------------------------------------
-- CREATE-if-absent. NEVER DROP ROLE — the rollback revokes and leaves the role.
-- No password here; credentials stay out of band in .env.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'intel_writer') THEN
    CREATE ROLE intel_writer NOLOGIN;
  END IF;
END
$$;

COMMENT ON ROLE intel_writer IS
  'Ingest role for intel.*. INSERT + UPDATE only. Deliberately has no DELETE at '
  'either the grant or the RLS-policy layer: policy findings are append-and-correct, '
  'never erased, so a compromised or buggy ingest cannot destroy history.';

-- ---------------------------------------------------------------------------
-- 3. payer_policy_run — one row per (payer key, research invocation)
-- ---------------------------------------------------------------------------
-- One payer per invocation. The probe batch measured ~50s/turn and 2 turns per
-- key; a whole-roster single invocation would run ~25-60 min and a timeout would
-- leave a half-written run with no error, so the unit of work is one key.

CREATE TABLE IF NOT EXISTS intel.payer_policy_run (
  run_id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_key             text        NOT NULL CHECK (length(payer_key) BETWEEN 1 AND 64),
  window_start          date        NOT NULL,
  window_end            date        NOT NULL,
  -- Window membership is decided by PUBLICATION date, pinned after the 2026-08-03
  -- batch surfaced one finding published 2026-07-01 inside a window opening
  -- 2026-07-03, and another approved 06-01/effective 06-08 but bulletined 07-24.
  window_filter         text        NOT NULL DEFAULT 'date_published'
                                    CHECK (window_filter IN ('date_published')),
  model                 text        NOT NULL CHECK (length(model) BETWEEN 1 AND 128),
  status                text        NOT NULL CHECK (status IN ('ok', 'failed')),
  -- Which gate failed, when status='failed'. A well-formed response that silently
  -- means "nothing happened" is the failure mode this whole column exists for.
  failure_gate          text        NULL CHECK (failure_gate IS NULL OR length(failure_gate) <= 64),
  stop_reason           text        NULL CHECK (stop_reason IS NULL OR length(stop_reason) <= 32),
  findings_count        integer     NOT NULL DEFAULT 0 CHECK (findings_count >= 0),
  search_requests_used  integer     NOT NULL DEFAULT 0 CHECK (search_requests_used >= 0),
  fetch_requests_used   integer     NOT NULL DEFAULT 0 CHECK (fetch_requests_used >= 0),
  input_tokens          bigint      NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens         bigint      NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  thinking_tokens       bigint      NOT NULL DEFAULT 0 CHECK (thinking_tokens >= 0),
  service_tier          text        NULL,
  inference_geo         text        NULL,
  -- DELIBERATE deviation from the numeric(12,2) money convention: this is an
  -- observability metric, not a ledger amount. Measured per-key cost was ~$1.70
  -- and the search component ~$0.09; 4dp keeps a cheaper future model's per-run
  -- cost from rounding to zero.
  cost_usd              numeric(12,4) NULL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  turn_count            integer     NOT NULL DEFAULT 0 CHECK (turn_count >= 0),
  wall_ms               integer     NULL CHECK (wall_ms IS NULL OR wall_ms >= 0),
  started_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz NULL,
  CONSTRAINT payer_policy_run_window_ck CHECK (window_end >= window_start)
);

COMMENT ON TABLE intel.payer_policy_run IS
  'One research invocation for one payer key. status=failed means a gate tripped; '
  'findings from a failed run must not be treated as authoritative.';

CREATE INDEX IF NOT EXISTS idx_ppr_key_window
  ON intel.payer_policy_run (payer_key, window_end DESC);

-- ---------------------------------------------------------------------------
-- 4. payer_policy_finding
-- ---------------------------------------------------------------------------
-- INVARIANT: 'no_change' and 'unreachable' outcomes NEVER appear here. They live
-- only in payer_policy_run_check and are never embedded. There is no column in
-- this table capable of expressing them, which is the structural guarantee.

CREATE TABLE IF NOT EXISTS intel.payer_policy_finding (
  finding_id       bigserial   PRIMARY KEY,
  -- sha256 of payer_plan|change_type|date_effective|source_url. Validated on real
  -- data: 10/10 distinct, zero collisions, and it correctly separated two findings
  -- that shared a source_url but differed on change_type.
  finding_hash     text        NOT NULL UNIQUE CHECK (length(finding_hash) BETWEEN 32 AND 128),
  run_id           uuid        NULL REFERENCES intel.payer_policy_run (run_id) ON DELETE SET NULL,
  payer_key        text        NOT NULL CHECK (length(payer_key) BETWEEN 1 AND 64),
  payer_plan       text        NOT NULL CHECK (length(payer_plan) BETWEEN 1 AND 512),
  change_type      text        NOT NULL CHECK (change_type IN
                                 ('reimbursement','coverage','prior_auth','edit',
                                  'modifier','unit','code_set','transparency')),
  -- The body that actually originated the change. Payers adopt CPT/HCPCS/revenue
  -- codes; they rarely author them, so a payer announcement is almost always a
  -- reimbursement/coverage/edit/modifier/unit/prior_auth change to how existing
  -- codes are paid. 'unit' and 'code_set' went unused in the first batch and are
  -- retained deliberately — code_set is exactly what an AMA/NUBC finding would be.
  originator       text        NOT NULL CHECK (originator IN ('payer','AMA','NUBC','CMS','CDC-NCHS')),
  summary          text        NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  codes_affected   text[]      NOT NULL DEFAULT '{}',
  -- 9/10 of the first batch came back 'unclear' and neither in_network nor
  -- out_of_network was ever emitted: public payer bulletins do not distinguish
  -- them. Retained because OON allowed amounts live in TiC MRFs, a source not yet
  -- wired. Defaulted, and deliberately NOT indexed until it carries signal.
  scope            text        NOT NULL DEFAULT 'unclear'
                               CHECK (scope IN ('in_network','out_of_network','both','unclear')),
  self_funded_relevant boolean NOT NULL DEFAULT false,
  -- The model emits the string 'unknown' when a date is not establishable; ingest
  -- maps that to NULL. Never infer date_published from date_effective.
  date_published   date        NULL,
  date_approved    date        NULL,
  date_effective   date        NULL,
  source_url       text        NOT NULL CHECK (length(source_url) BETWEEN 1 AND 2048),
  source_domain    text        NOT NULL CHECK (length(source_domain) BETWEEN 1 AND 253),
  -- DERIVED at ingest from the domain map, not model-emitted. Under a primary-only
  -- allowed_domains map a model-emitted tier is a tautology — the first batch
  -- returned primary 10/10. 'secondary' stays legal so widening the map is a
  -- one-line change rather than a migration.
  source_tier      text        NOT NULL CHECK (source_tier IN ('primary','secondary')),
  -- confidence and status are ORTHOGONAL and must never be collapsed into one
  -- filter:
  --   confidence = did the MODEL verify the claim?      (epistemic, model-emitted)
  --   status     = did OUR PIPELINE verify the source?  (provenance, computed)
  -- First batch: confidence was needs_verification on 7/10, and every one of those
  -- was an incomplete retrieval ("section text not retrieved", "PDF not parsed"),
  -- not genuine doubt — which is precisely why they are separate columns.
  confidence       text        NOT NULL CHECK (confidence IN ('confirmed','needs_verification')),
  -- 'quarantined' = source_url was NOT in the run's retrieved-URL set. A quarantined
  -- row is retained for audit but must be excluded from retrieval.
  status           text        NOT NULL DEFAULT 'needs_verification'
                               CHECK (status IN ('confirmed','needs_verification','quarantined')),
  embed_text       text        NOT NULL CHECK (length(embed_text) BETWEEN 1 AND 8000),
  -- Nullable on purpose. BGE-M3 (src/brain2, src/brain3) is the ONE embedding path
  -- in this repo and has never produced a production row; the ingest worker writes
  -- findings unembedded and a separate BGE-M3 pass fills this. Same halfvec(1024)
  -- as staging.claim_signatures and ref.carc_embeddings — do not introduce a
  -- second dim or a second embedding path.
  embedding        extensions.halfvec(1024) NULL,
  -- Because embeddings may never arrive, full-text is the day-one retrieval path.
  embed_tsv        tsvector GENERATED ALWAYS AS (to_tsvector('english', embed_text)) STORED,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE intel.payer_policy_finding IS
  'A dated, citation-backed payer or federal policy finding. Non-PHI. Deduped on '
  'finding_hash. status=quarantined means the source_url failed the retrieved-set '
  'provenance check and the row must be excluded from retrieval.';

-- Vector ANN. Matches 011/012 exactly: halfvec_cosine_ops, m=16, ef_construction=64.
CREATE INDEX IF NOT EXISTS idx_ppf_embedding_hnsw
  ON intel.payer_policy_finding
  USING hnsw (embedding extensions.halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Day-one retrieval, independent of whether embeddings ever land.
CREATE INDEX IF NOT EXISTS idx_ppf_embed_tsv
  ON intel.payer_policy_finding USING gin (embed_tsv);

-- The primary browse/filter path: this payer family, most recent effective first.
CREATE INDEX IF NOT EXISTS idx_ppf_key_effective
  ON intel.payer_policy_finding (payer_key, date_effective DESC NULLS LAST);

-- Window/recency queries run on publication date, matching window_filter.
CREATE INDEX IF NOT EXISTS idx_ppf_published
  ON intel.payer_policy_finding (date_published DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_ppf_codes
  ON intel.payer_policy_finding USING gin (codes_affected);

-- ---------------------------------------------------------------------------
-- 5. payer_policy_run_check — the ONLY home for no_change and unreachable
-- ---------------------------------------------------------------------------
-- The first batch produced 38 unreachable rows against 10 findings, all as free
-- text, which made 'budget exhausted' (12/38 — a tuning defect you fix) and
-- 'login gated' (4/38 — a permanent wall you route around) indistinguishable.
-- reason_code exists so the monthly run can learn which sources to stop trying.

CREATE TABLE IF NOT EXISTS intel.payer_policy_run_check (
  check_id     bigserial   PRIMARY KEY,
  run_id       uuid        NOT NULL REFERENCES intel.payer_policy_run (run_id) ON DELETE CASCADE,
  payer        text        NOT NULL CHECK (length(payer) BETWEEN 1 AND 256),
  outcome      text        NOT NULL CHECK (outcome IN ('no_change','unreachable')),
  reason_code  text        NULL CHECK (reason_code IS NULL OR reason_code IN
                             ('login_gated','pdf_not_parsed','content_not_retrieved',
                              'budget_exhausted','not_published','other')),
  reason       text        NULL CHECK (reason IS NULL OR length(reason) <= 4000),
  url          text        NULL CHECK (url IS NULL OR length(url) <= 2048),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- An unreachable row is only actionable with a reason_code; a no_change row
  -- does not need one.
  CONSTRAINT pprc_unreachable_needs_code
    CHECK (outcome <> 'unreachable' OR reason_code IS NOT NULL)
);

COMMENT ON TABLE intel.payer_policy_run_check IS
  'Per-run record of sources checked with no in-window change, or that could not '
  'be read. These rows NEVER become findings and are NEVER embedded. reason_code '
  'separates retryable budget exhaustion from permanent login gating.';

CREATE INDEX IF NOT EXISTS idx_pprc_run ON intel.payer_policy_run_check (run_id);
CREATE INDEX IF NOT EXISTS idx_pprc_outcome_code
  ON intel.payer_policy_run_check (outcome, reason_code);

-- ---------------------------------------------------------------------------
-- 6. RLS — mirrors the 015 ref.* pattern, plus the writer policies 015 lacks
-- ---------------------------------------------------------------------------
-- 015's ref.* shape is SELECT USING(true) with NO write policies, so mutation is
-- owner-only. That invariant is why this feature is not in `ref`: it needs a
-- writer. Here the read policy matches 015, and INSERT/UPDATE are granted to
-- intel_writer explicitly. There is NO DELETE policy anywhere, so DELETE is
-- blocked by policy even if a grant were ever added by mistake.

ALTER TABLE intel.payer_policy_run       ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel.payer_policy_finding   ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel.payer_policy_run_check ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payer_policy_run_read_all       ON intel.payer_policy_run;
DROP POLICY IF EXISTS payer_policy_finding_read_all   ON intel.payer_policy_finding;
DROP POLICY IF EXISTS payer_policy_run_check_read_all ON intel.payer_policy_run_check;

CREATE POLICY payer_policy_run_read_all
  ON intel.payer_policy_run FOR SELECT USING (true);
CREATE POLICY payer_policy_finding_read_all
  ON intel.payer_policy_finding FOR SELECT USING (true);
CREATE POLICY payer_policy_run_check_read_all
  ON intel.payer_policy_run_check FOR SELECT USING (true);

DROP POLICY IF EXISTS payer_policy_run_insert       ON intel.payer_policy_run;
DROP POLICY IF EXISTS payer_policy_run_update       ON intel.payer_policy_run;
DROP POLICY IF EXISTS payer_policy_finding_insert   ON intel.payer_policy_finding;
DROP POLICY IF EXISTS payer_policy_finding_update   ON intel.payer_policy_finding;
DROP POLICY IF EXISTS payer_policy_run_check_insert ON intel.payer_policy_run_check;

CREATE POLICY payer_policy_run_insert
  ON intel.payer_policy_run FOR INSERT TO intel_writer WITH CHECK (true);
CREATE POLICY payer_policy_run_update
  ON intel.payer_policy_run FOR UPDATE TO intel_writer USING (true) WITH CHECK (true);
CREATE POLICY payer_policy_finding_insert
  ON intel.payer_policy_finding FOR INSERT TO intel_writer WITH CHECK (true);
CREATE POLICY payer_policy_finding_update
  ON intel.payer_policy_finding FOR UPDATE TO intel_writer USING (true) WITH CHECK (true);
CREATE POLICY payer_policy_run_check_insert
  ON intel.payer_policy_run_check FOR INSERT TO intel_writer WITH CHECK (true);
-- Intentionally absent: any UPDATE policy on run_check, and any DELETE policy anywhere.

-- ---------------------------------------------------------------------------
-- 7. Grants — least privilege, nothing to anon/authenticated/PUBLIC
-- ---------------------------------------------------------------------------

GRANT USAGE ON SCHEMA intel TO claims_reader, intel_writer;

GRANT SELECT ON intel.payer_policy_run       TO claims_reader;
GRANT SELECT ON intel.payer_policy_finding   TO claims_reader;
GRANT SELECT ON intel.payer_policy_run_check TO claims_reader;

GRANT INSERT, UPDATE ON intel.payer_policy_run     TO intel_writer;
GRANT INSERT, UPDATE ON intel.payer_policy_finding TO intel_writer;
GRANT INSERT         ON intel.payer_policy_run_check TO intel_writer;
-- No DELETE, no TRUNCATE, to anyone but the owner. Sequences the writer must advance:
GRANT USAGE, SELECT ON SEQUENCE intel.payer_policy_finding_finding_id_seq TO intel_writer;
GRANT USAGE, SELECT ON SEQUENCE intel.payer_policy_run_check_check_id_seq TO intel_writer;

REVOKE ALL ON intel.payer_policy_run       FROM PUBLIC;
REVOKE ALL ON intel.payer_policy_finding   FROM PUBLIC;
REVOKE ALL ON intel.payer_policy_run_check FROM PUBLIC;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- 8. Verification (run manually after apply)
-- ---------------------------------------------------------------------------
-- Expect 3 tables, all rls_on, all owned by claims_admin:
--   SELECT c.relname, c.relrowsecurity AS rls_on, pg_get_userbyid(c.relowner) AS owner
--     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'intel' AND c.relkind = 'r' ORDER BY 1;
--
-- Expect embedding halfvec/1024, matching staging.claim_signatures:
--   SELECT a.attname, t.typname, a.atttypmod
--     FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
--    WHERE a.attrelid = 'intel.payer_policy_finding'::regclass
--      AND a.attname IN ('embedding','embed_tsv');
--
-- Expect 6 indexes on the finding table incl. hnsw + gin(embed_tsv) + gin(codes_affected):
--   SELECT indexname, indexdef FROM pg_indexes
--    WHERE schemaname = 'intel' ORDER BY tablename, indexname;
--
-- Expect 8 policies: 3 SELECT/true, 4 writer INSERT/UPDATE, 1 run_check INSERT.
-- Expect ZERO rows with cmd = 'DELETE':
--   SELECT tablename, policyname, cmd, roles::text FROM pg_policies
--    WHERE schemaname = 'intel' ORDER BY 1, 3, 2;
--
-- Expect intel_writer to hold INSERT/UPDATE but NOT DELETE:
--   SELECT table_name, privilege_type FROM information_schema.table_privileges
--    WHERE table_schema = 'intel' AND grantee = 'intel_writer' ORDER BY 1, 2;
--
-- Expect no grants to anon/authenticated/PUBLIC (0 rows):
--   SELECT * FROM information_schema.table_privileges
--    WHERE table_schema = 'intel' AND grantee IN ('anon','authenticated','PUBLIC');
