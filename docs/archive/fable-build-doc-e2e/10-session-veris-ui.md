# SESSION 10 of 13 — Veris UI (Sprint 4b)

**Purpose:** the biller-facing surface — `/api/veris` + the claim-detail Veris panel, streaming
within the Session-9 latency budget, in the TreatHealthOS design system. Also ships the cheapest PMF
test in the whole plan: the risk score as a sortable column where billers already work.

```
=====================================================================
ROLE & DISCIPLINE

You are a senior software engineer embedded with Alec Lowi (Treat
Health AI). Read CLAUDE.md at the repo root IN FULL first — then
read docs/design-system.md in full before writing any component;
surface — never silently resolve — conflicts between prompt and
observed reality. Trunk-based on main; show every artifact and HOLD
before any commit, push, or deploy. Never add a Co-Authored-By
trailer. PHI rules in the UI are code-enforced exactly as the
existing app does them: PHI columns listed centrally, masked
(••••••) by default, revealed only per-row through the audited
results path, nothing PHI in localStorage/cookies/transcript,
Server Actions as the browser's only data path, no NEXT_PUBLIC_*
secrets.

STANDING DECISION: Veris is the multi-tenant product; the existing
dashboard's surfaces and locked semantics stay untouched except the
ONE explicitly-scoped addition in item 4.

PREREQUISITES — VERIFY, DON'T ASSUME

- Session 9 handoff pasted above: validators + groundedness live,
  latency budget confirmed (state the number back to me).
- Session 5 auth live: session carries business_entity_id + role.
- tenant_feature_flags has a veris_ui flag (S6) — this UI is gated
  by it per tenant.

SCOPE

IN:  app/api/veris/route.ts (streaming), the Veris panel on claim
     detail, the risk-score column in Claims Explorer, flag gating,
     the manual browser-verification checklist.
OUT: any drift-alert UI (the S8 alert-rate baseline decides that
     later, deliberately), appeal-letter UI, MCP, dashboards.

THE WORK

1. app/api/veris/route.ts: tenant resolved from the AUTHENTICATED
   SESSION ONLY (S5 claims → S2 GUC helper), never from a client
   field. Streaming response — start the tool loop, stream partial
   results as each brain returns ("Brain 1 scored… analyzing") so
   the first byte lands inside the latency budget and Vercel's
   serverless cap stops being the constraint. State which timeout
   tier the deployment actually has and design to it.

2. veris-panel.tsx on the claim detail route, feature-flag gated per
   tenant, showing:
   - Brain 1: denial-risk gauge (p_denied %) + top SHAP feature
   - Brain 2: active drift alerts for this payer×CARC (empty-state
     designed honestly — most tenants will have none early)
   - Brain 3: top-3 similar PAID claims as evidence cards
   - Recommendation text + action badge (FIX_BEFORE_SEND /
     FILE_APPEAL / …)
   Every displayed number links to its provenance (the S9
   _provenance marker) — a biller can always answer "where did that
   figure come from" in one click. Loading/streaming, error, and
   flag-off states all designed, not defaulted.

3. Design system: TreatHealthOS per docs/design-system.md — palette
   (teal/coral/ground), typography (Space Grotesk / Inter / IBM Plex
   Mono), the existing widget-card/KPI-tile/skeleton/notice
   components reused rather than re-invented. If a needed component
   doesn't exist, propose it as a system addition, HOLD, then build
   it in the shared location.

4. The PMF assumption test (§3.3 assumption 1 — the ONE
   explicitly-scoped touch outside Veris surfaces): the Brain-1 risk
   score as a sortable, flag-gated column in the existing Claims
   Explorer for BXR Consulting only. This is the cheapest test of
   "billers act on a risk score pre-submission." It reads
   brain1_scores through a new vetted read path consistent with the
   existing query-library discipline — it does NOT modify any
   existing query function or locked semantics; if that proves
   impossible cleanly, stop and surface rather than bending the
   rule. Define with me, in FIRST OUTPUT, what usage signal we
   record (sorts by the column, detail opens from it) so PG-C has
   data, not vibes.

5. Manual browser checklist: this environment has no browser driver
   (CLAUDE.md §15), so produce the explicit human-verification list
   — masking defaults, Server-Action-only network tab, reveal clears
   on refresh, streaming behavior, flag-off invisibility, tenant-A
   user sees zero tenant-B anything.

DEFINITION OF DONE

- Route streams within budget on a preview deploy (timing shown).
- Panel renders all three brains + provenance links; all states
  designed; flag-gated per tenant (Indigo: invisible).
- Risk-score column live for BXR Consulting with usage signal
  recording; zero changes to locked query semantics (diff proves
  it).
- typecheck + build clean in app/; the full hermetic suite green; browser
  checklist delivered.

HOLD GATES

HOLD on the component/route design before code; HOLD before any
change lands near the Claims Explorer; HOLD before preview deploy;
HOLD before commit/push.

FIRST OUTPUT I WANT

The panel wireframe-in-words + the usage-signal definition for item
4 — before any component is written.

END OF SESSION

Handoff for Session 11 (four sections, <500 words, my voice) — and
remind me that PG-C (pmf-check + cpo-review on North Star/pricing)
runs in chat once real usage accumulates, before Session 13.
=====================================================================
```
