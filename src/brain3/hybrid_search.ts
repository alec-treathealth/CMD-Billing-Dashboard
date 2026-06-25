/**
 * Brain 3 — hybrid appeal-evidence retrieval (Phase 3-C).
 *
 * Dense ANN (pgvector HNSW) + FTS (GIN) over staging.claim_signatures, fused with
 * Reciprocal Rank Fusion (k=60). The evidence pool is outcome_class=0 (CLEAN/paid)
 * claims for the SAME canonical payer as the query claim. Persists ranked matches
 * into staging.appeal_evidence and returns typed, PHI-free rows.
 *
 * Reads via claims_reader; writes via claims_admin. Both use $n params over the
 * pooler (6543) — no named prepared statements. hnsw.iterative_scan='relaxed_order'
 * (set in migration 009) keeps the HNSW scan correct under the payer pre-filter.
 */
import { makeClient, type Db } from '../db.js';

const BEID = 'af504ab6-3dcd-4aa4-a93c-27bc58de4088';

export interface AppealEvidence {
  matchClaimId: string;
  rrfScore: number;
  vectorRank: number | null;
  ftsRank: number | null;
  matchOutcome: string | null;
  matchPaymentAmt: number | null;
  payerName: string | null;
  cptCode: string | null;
}

export async function retrieveAppealEvidence(params: {
  queryClaimId: string;        // a charge_debit_id present in staging.claim_signatures
  businessEntityId?: string;
  topN?: number;
}): Promise<AppealEvidence[]> {
  const beid = params.businessEntityId ?? BEID;
  const topN = params.topN ?? 10;

  const readerUrl = process.env.CLAIMS_READER_DATABASE_URL;
  const adminUrl = process.env.CLAIMS_ADMIN_DATABASE_URL;
  if (!readerUrl || !adminUrl) throw new Error('Missing CLAIMS_*_DATABASE_URL');
  const reader: Db = makeClient(readerUrl);

  try {
    await reader.query("select set_config('app.business_entity_id', $1, false)", [beid]);

    // Query claim signature (vector + the FTS text it would generate).
    const q = await reader.query<{
      payer: string; dense: string;
      fts_text: string;
    }>(
      `select canonical_primary_payer_name as payer,
              dense_embedding::text as dense,
              coalesce(canonical_primary_payer_name,'') || ' ' || coalesce(payer_family,'') || ' ' ||
              coalesce(cpt_code,'') || ' ' || coalesce(tob_raw,'') || ' ' ||
              coalesce(residual_type,'') as fts_text
         from staging.claim_signatures
        where business_entity_id = $1 and charge_debit_id = $2`,
      [beid, params.queryClaimId],
    );
    const signature = q.rows[0];
    if (!signature) return [];
    const { payer, dense, fts_text } = signature;

    // RRF fusion of dense ANN (top 50) and FTS (top 50), same-payer CLEAN pool.
    const fused = await reader.query<{
      charge_debit_id: string; rrf_score: string;
      vector_rank: number | null; fts_rank: number | null;
      match_outcome: string | null; match_payment_amt: string | null;
      payer_name: string | null; cpt_code: string | null;
    }>(
      `with vector_ranked as (
         select charge_debit_id,
                row_number() over (order by dense_embedding <=> $2::halfvec) as vector_rank
           from staging.claim_signatures
          where business_entity_id = $1 and outcome_class = 0
            and canonical_primary_payer_name = $3 and charge_debit_id <> $4
          order by dense_embedding <=> $2::halfvec limit 50
       ),
       fts_ranked as (
         select charge_debit_id,
                row_number() over (order by ts_rank(fts_vector, query) desc) as fts_rank
           from staging.claim_signatures, plainto_tsquery('english', $5) query
          where business_entity_id = $1 and outcome_class = 0
            and fts_vector @@ query and charge_debit_id <> $4
          limit 50
       ),
       rrf as (
         select coalesce(v.charge_debit_id, f.charge_debit_id) as charge_debit_id,
                coalesce(1.0/(60 + v.vector_rank), 0) + coalesce(1.0/(60 + f.fts_rank), 0) as rrf_score,
                v.vector_rank, f.fts_rank
           from vector_ranked v full outer join fts_ranked f using (charge_debit_id)
       )
       select r.charge_debit_id, r.rrf_score, r.vector_rank, r.fts_rank,
              cs.residual_type as match_outcome,
              (pr.primary_paid + pr.secondary_paid) as match_payment_amt,
              cs.canonical_primary_payer_name as payer_name, cs.cpt_code
         from rrf r
         join staging.claim_signatures cs
           on cs.business_entity_id = $1 and cs.charge_debit_id = r.charge_debit_id
         left join staging.payment_residual pr
           on pr.business_entity_id = $1 and pr.charge_debit_id = r.charge_debit_id
        order by r.rrf_score desc limit $6`,
      [beid, dense, payer, params.queryClaimId, fts_text, topN],
    );

    const results: AppealEvidence[] = fused.rows.map((r) => ({
      matchClaimId: r.charge_debit_id,
      rrfScore: Number(r.rrf_score),
      vectorRank: r.vector_rank,
      ftsRank: r.fts_rank,
      matchOutcome: r.match_outcome,
      matchPaymentAmt: r.match_payment_amt == null ? null : Number(r.match_payment_amt),
      payerName: r.payer_name,
      cptCode: r.cpt_code,
    }));

    // Persist to staging.appeal_evidence (claims_admin).
    const admin: Db = makeClient(adminUrl);
    try {
      for (const r of results) {
        await admin.query(
          `insert into staging.appeal_evidence
             (business_entity_id, query_claim_id, match_claim_id, rrf_score,
              vector_rank, fts_rank, match_outcome, match_payment_amt)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [beid, params.queryClaimId, r.matchClaimId, r.rrfScore,
           r.vectorRank, r.ftsRank, r.matchOutcome, r.matchPaymentAmt],
        );
      }
    } finally {
      await admin.end();
    }
    return results;
  } finally {
    await reader.end();
  }
}
