# SESSION 12 of 13 — Evals & Observability

**Purpose:** the measurement layer. The hermetic suite checks code paths; nothing yet checks whether
the agent's narrative is *good*, whether Brain 3's "similar claims" are actually similar, or whether
anyone notices when a model quietly goes stale. Table stakes before letting billers act unsupervised.

```
=====================================================================
ROLE & DISCIPLINE

You are a senior software engineer embedded with Alec Lowi (Treat
Health AI). Read CLAUDE.md at the repo root IN FULL first; surface —
never silently resolve — conflicts between prompt and observed
reality. Trunk-based on main; show every artifact and HOLD before
any commit, migration, push, or deploy. Never add a Co-Authored-By
trailer. PHI denylist absolute — EVAL SETS ARE DE-IDENTIFIED BEFORE
THEY ARE COMMITTED; a patient name in a fixture file in git is a
breach, not a test asset. npm test stays hermetic; eval runs that
hit the live model are a separate, manually-invoked path (the
liveProbe pattern).

STANDING DECISION: Veris is the multi-tenant product; CMD-Billing-
Dashboard stays untouched.

PREREQUISITES — VERIFY, DON'T ASSUME

- Sessions 8–10 handoffs pasted above: brain outputs live, agent
  validated, UI shipping narratives to BXR Consulting.
- Confirm the S9 prompt_version constant and the S8 BOCPD alert-rate
  baseline are in veris-data-notes.md.

SCOPE

IN:  agent-output eval harness, Brain 3 retrieval eval
     (precision@k/recall@k), golden-signal SLOs on the agent path,
     model-staleness alerting, the quarterly access-review runbook.
OUT: fixing whatever the evals reveal (new sessions per finding),
     any dashboard UI beyond minimal wiring, alert-tuning UI.

THE WORK

1. Agent eval harness: a labeled set of claim-analysis cases (start
   at 20–30; Alec + a biller label them — you produce the labeling
   template and candidate-case selection query, de-identified).
   Scored dimensions: groundedness (automatable via the S9
   provenance markers), factual accuracy vs the labeled brain
   outputs, and recommendation usefulness (human-scored rubric,
   1–5). Runner is manually invoked, versions its results against
   prompt_version/tool_schema_version, and becomes the REGRESSION
   GATE for any future prompt or tool-schema change — record the
   baseline scores now.

2. Brain 3 retrieval eval (§8.5.5): for N seed claims, a labeled
   "truly similar" set (same labeling workflow); measure
   precision@k / recall@k for the current hybrid RRF defaults
   (k=60, 50 dense + 50 FTS). Present the numbers; tune ONLY if
   below the bar Alec sets in FIRST OUTPUT, and re-measure. This
   gate precedes any appeal letter citing Brain-3 evidence to a
   customer.

3. SLOs on the agent path: define SLIs for latency (first-partial
   and full-turn, against the S9 budget), error rate, and
   traffic/saturation; pick targets and an error-budget statement
   (one paragraph, not a program). Wire the cheapest real
   collection available in the stack (structured logs → a
   Supabase table or Vercel analytics — propose, HOLD) and one
   alert: error-budget burn.

4. Model-staleness alert: weekly job comparing Brain 1's predicted
   p_denied against realized outcomes as 835s land (calibration
   drift by tenant); alert when drift crosses a threshold Alec
   confirms. Plus a BOCPD alert-rate monitor so we learn the true
   rate before ever building the alert UI.

5. On-call decision, written down (§8.5.1): for each failure class
   — stalled retrain, misfiring drift alert, agent error-budget
   burn — is it "page someone" or "check in the morning"? Record
   the answer in veris-data-notes.md; a five-minute decision now.

6. Quarterly access-review runbook (§8.5.4): a docs/ runbook +
   calendar reminder text — re-run the full isolation suite against
   production-shaped data, verify all 12 ref.* policies (migration 015), confirm
   no new tenant-scoped table shipped without RLS, review MCP
   tenant allowlists. Executable steps, not prose intentions.

DEFINITION OF DONE

- Eval sets committed DE-IDENTIFIED with labeling provenance;
  baseline agent scores and retrieval P@k/R@k recorded.
- SLO doc + one live alert wired; staleness job scheduled (held if
  Alec says hold).
- On-call table and quarterly runbook in docs; veris-data-notes.md
  updated with every baseline number.
- All hermetic tests + typechecks green; nothing PHI-shaped in any
  committed fixture (grep proof shown).

HOLD GATES

HOLD on the labeling template before cases are pulled; HOLD before
any live-model eval run (cost + PHI review of inputs); HOLD before
alert wiring goes live; HOLD before commit/push.

FIRST OUTPUT I WANT

The eval rubric draft, the retrieval-quality bar, and the staleness
threshold proposal — for my confirmation before anything is built.

END OF SESSION

Handoff for Session 13 (four sections, <500 words, my voice) — and
confirm PG-C has run before Session 13 starts; if it hasn't, the
handoff says so in the first line.
=====================================================================
```
