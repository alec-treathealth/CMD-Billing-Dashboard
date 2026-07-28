# SESSION 13 of 13 — GTM Instrumentation (Sprint 5)

**Purpose:** turn the running system into a sellable one. The KPIs that pitch tenant #3, per-tenant
unit economics as a query instead of an investigation, and a structural guard that makes pooled
cross-tenant training impossible until the contract says otherwise.

```
=====================================================================
ROLE & DISCIPLINE

You are a senior software engineer embedded with Alec Lowi (Treat
Health AI). Read CLAUDE.md at the repo root IN FULL first; surface —
never silently resolve — conflicts between prompt and observed
reality. Trunk-based on main; show every artifact and HOLD before
any commit, migration, push, or deploy. Never add a Co-Authored-By
trailer. PHI denylist absolute — every KPI in this session is an
AGGREGATE; no patient-level figure leaves the DB. Parameterized
queries, allowlists, claims_reader for reads, port 6543.

STANDING DECISION: Veris is the multi-tenant product; CMD-Billing-
Dashboard stays untouched.

PREREQUISITES — VERIFY, DON'T ASSUME

- Product gate PG-C has run: Alec brings the North Star metric and
  the pricing-model decision (per-claim / %-recovered / per-seat)
  from that session. If either is missing, STOP — this session
  instruments a decision; it does not make one by default.
- Sessions 7–8: both tenants have claim + ERA data (confirm counts).
- Session 7 item 6: per-call cost logging exists (confirm).

SCOPE

IN:  RCM KPI definitions as SQL (matviews where warranted), the
     "misses caught" metric, per-tenant cost-attribution readout,
     pricing-usage instrumentation, the pooled-training contract
     guard, a prioritized Phase-7 source backlog.
OUT: pricing pages, billing/invoicing systems, sales collateral,
     new data-source integrations (backlogged, not built).

THE WORK

1. KPI layer, per tenant, defined as reviewed SQL over existing
   tables (matview + scheduled refresh only where the query cost
   demands it — propose per KPI):
   - Net collection rate
   - Denial rate by payer × CPT
   - Days in AR (distribution, not just mean)
   - First-pass resolution rate
   - Appeal win rate
   - MISSES CAUGHT — the metric unique to this architecture: dollar
     value of allowed-vs-paid gaps surfaced by the system (Brain-1
     flags + drift alerts) that predate biller action. Define the
     attribution rule precisely WITH me in FIRST OUTPUT (what
     counts as "surfaced by the tool" vs "would have been caught
     anyway") — this number is the sales pitch to tenant #3 and it
     must survive skeptical scrutiny.
   Each KPI: definition paragraph in docs, the SQL, and a current
   snapshot for both tenants.

2. Cost attribution: a per-tenant readout over the call logs —
   Anthropic spend by tenant × model × surface (agent vs any NL
   path), monthly. Join against the PG-C pricing model to show
   margin per tenant. Simple table/matview + a minimal internal
   view; no product UI.

3. Pricing-usage instrumentation: whatever PG-C chose, count its
   unit — claims analyzed, dollars recovered (ties to Misses
   Caught), or active seats — as durable, tenant-scoped counters
   from Indigo day one, so the first invoice is a query.

4. Pooled-training contract guard (§6.3/§8.5.4, structural not
   honor-system): core.business_entity gains
   pooled_training_consent (enum: none / pending / signed, +
   effective_date, doc_ref). The Session-4 Actions workflow gains a
   hard check: any job whose feature/training scope spans more than
   one business_entity_id fails unless EVERY included tenant is
   'signed'. Single-tenant legs are untouched. Counsel review of
   the clause itself is Alec's parallel track — this session makes
   the system incapable of jumping the gun.

5. Phase-7 backlog, ordered by ROI as the build plan ranks it
   (Stedi if still stubbed → CARC/RARC quarterly cron → CMS LCD/NCD
   chunking → payer EOB corpus → NPPES-when-NPI-exists → Kipu →
   prior-auth APIs), each with a one-line effort/unblock note in
   docs — scoped, not started.

6. veris-data-notes.md: KPI baselines for both tenants, cost/margin
   snapshot, the Misses-Caught attribution rule verbatim.

DEFINITION OF DONE

- Six KPIs defined, reviewed, snapshotted per tenant; Misses-Caught
  rule ratified in writing.
- Cost/margin readout live; pricing counters recording.
- Training guard proven: a deliberately multi-tenant test job fails
  with consent='none' and passes with both 'signed' (synthetic).
- Backlog doc committed; isolation suite + tests + typechecks green.

HOLD GATES

HOLD on each KPI definition before its SQL; HOLD on the
Misses-Caught rule; HOLD before the workflow guard lands (it
touches the training pipeline); HOLD before commit/push.

FIRST OUTPUT I WANT

The Misses-Caught attribution rule proposal and the KPI-by-KPI
matview-or-not plan — before any SQL.

END OF SESSION

This closes the library's arc. Produce a final handoff that is a
STATE-OF-THE-SYSTEM brief rather than a next-session prompt: what
is live per tenant, every baseline number, open risks, and the
backlog — the document I hand Syed, Iman, or tenant #3's technical
counterpart. Same four-section spine, but this one can run long.
=====================================================================
```
