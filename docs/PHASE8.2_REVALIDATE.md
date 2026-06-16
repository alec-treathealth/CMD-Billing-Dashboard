# Phase 8.2 — Exact dashboard freshness via cache invalidation

The dashboard's non-PHI aggregate readers (`app/lib/server.ts`) are wrapped in
Next's `unstable_cache` with a **15-minute `revalidate` fallback** and a shared
tag, `dashboard-aggregates`. Phase 8.2 adds a way to drop that cache **immediately**
after an ingest so the dashboard reflects new data without waiting up to 15 minutes.
The 15-minute fallback remains as a safety net if the call is never made.

## The endpoint

```
POST /api/revalidate
Authorization: Bearer <REVALIDATE_SECRET>
Content-Type: application/json

{ "tag": "dashboard-aggregates" }   # body optional; defaults to this tag
```

- **POST only** — any other verb returns `405`.
- **Authenticated** with `REVALIDATE_SECRET` (constant-time Bearer compare). A
  missing/empty secret fails closed (`401`) — the endpoint is never open.
- **Closed tag allowlist** — only `dashboard-aggregates` may be invalidated. Any
  other/arbitrary tag returns `400` and invalidates nothing.
- Responses are generic JSON: `{ "revalidated": true }` on success, otherwise
  `{ "error": "..." }`. No PHI, no DB access, no token/body logging.

## Required environment variables

| Var | Where | Purpose |
|-----|-------|---------|
| `REVALIDATE_SECRET` | Next app (Vercel) **and** ingest host | Authorizes the endpoint. Distinct from `RESULTS_API_SECRET`. |
| `REVALIDATE_URL` | Ingest host only | The deployed endpoint URL the ingest POSTs to, e.g. `https://<host>/api/revalidate`. |

Set a strong random `REVALIDATE_SECRET`. Never commit a real URL or secret.

## Ingest integration (already wired)

`src/ingest.ts` calls `notifyDashboardRevalidate()` (in `src/revalidateClient.ts`)
right after `refreshAggregateMatviews(db)`. It is:

- **env-gated** — a no-op unless **both** `REVALIDATE_URL` and `REVALIDATE_SECRET`
  are set, so local `npm run ingest` is never blocked; and
- **non-fatal** — any network/HTTP error is swallowed and logged generically
  (counts/no PHI, no secret); ingest success never depends on it.

## n8n / CMD pull instructions

After the daily Supabase ingest **and** the matview refresh
(`select claims.refresh_aggregate_matviews()` — or `vob.refresh_ai_matviews()` if
also refreshed) succeed, add a final HTTP step:

1. **Method:** `POST`
2. **URL:** the deployed `…/api/revalidate` (store as an n8n credential/env, not inline)
3. **Header:** `Authorization: Bearer {{$env.REVALIDATE_SECRET}}`
4. **Body (JSON):** `{ "tag": "dashboard-aggregates" }`
5. Treat non-2xx as a soft warning — the 15-minute fallback still refreshes the
   dashboard, so a failed revalidate should not fail the pipeline.

A `curl` equivalent for manual/ops use:

```bash
curl -fsS -X POST "$REVALIDATE_URL" \
  -H "Authorization: Bearer $REVALIDATE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"tag":"dashboard-aggregates"}'
```

## What is intentionally NOT changed

- PHI reveal / `query_id` / results behavior, `claims_reader`, and the audit
  chokepoint are untouched.
- `/claims`, `/claims/[claimId]`, `/ask`, VOB, and dashboard UI are unchanged.
- No row-level data is cached, exposed, or logged anywhere on this path.
