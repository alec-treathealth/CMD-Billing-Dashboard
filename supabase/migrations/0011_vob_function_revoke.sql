-- =============================================================================
-- 0011_vob_function_revoke.sql
-- CMD Billing Dashboard — Revoke PUBLIC EXECUTE from VOB/RAG functions
--
-- Migration 0010 added GRANT EXECUTE to claims_reader/claims_admin but did not
-- revoke from PUBLIC. PostgreSQL auto-grants EXECUTE to PUBLIC when a function
-- is created, leaving =X/postgres in the proacl for all three functions.
--
-- Schema-level USAGE revoke in 0010 (revoke all on schema vob/rag from public,
-- anon, authenticated, service_role) provides current mitigation — those roles
-- cannot reach the function namespace. This migration adds defense-in-depth by
-- removing PUBLIC EXECUTE at the function level so that any future accidental
-- schema USAGE grant cannot expose these functions.
--
-- No data changes. No table or schema changes. Safe to apply at any time.
-- =============================================================================

begin;

revoke execute on function rag.match_document_chunks(
  extensions.vector(1536), integer, bigint, bigint, text[]
) from public;

revoke execute on function vob.get_service_history(bigint, bigint, bigint, text)
  from public;

revoke execute on function vob.refresh_ai_matviews()
  from public;

commit;
