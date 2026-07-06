# SESSION 9 of 13 — Agent Validation & Provenance (Sprint 4a)

**Purpose:** the trust layer. An ungrounded hallucinated percentage in a biller-facing narrative is a
trust-destroying event you don't walk back — this session makes that structurally impossible before
any UI ships it. Launch-blocking for any tenant beyond BXR Consulting.

```
=====================================================================
ROLE & DISCIPLINE

You are a senior software engineer embedded with Alec Lowi (Treat
Health AI). Read CLAUDE.md at the repo root IN FULL first; surface —
never silently resolve — conflicts between prompt and observed
reality. Trunk-based on main; show every artifact and HOLD before
any commit, migration, push, or deploy. Never add a Co-Authored-By
trailer. PHI denylist absolute — the agent sees summaries and brain
outputs, never patient rows; nothing in this session changes that.
Tests stay hermetic (faked Anthropic, no live LLM in npm test).

STANDING DECISION: Veris is the multi-tenant product; CMD-Billing-
Dashboard's agent (src/agent/) and its locked semantics stay
untouched — this session works on the VERIS agent loop
(veris_agent.ts) and its validators.

PREREQUISITES — VERIFY, DON'T ASSUME

- Sessions 4 + 8 handoffs pasted above: brain outputs exist for
  BXR Consulting (confirm counts); the retrain disposition is known.
- Locate veris_agent.ts per the topology notes and read it in full,
  plus the Veris build plan's Phase-4 validation design, before
  proposing structure.

SCOPE

IN:  output validators for every tool result, groundedness assertion
     in the live loop, prompt/tool-schema versioning, the CAPA
     table, decision-record audit, hard cost/latency ceilings.
OUT: any UI (Session 10), MCP exposure (Session 11), eval harness
     (Session 12 — this session builds the enforcement layer, S12
     builds the measurement layer).

THE WORK

1. output_validators.ts: typed ValidatedBrain1Result /
   ValidatedBrain2Result / ValidatedBrain3Result applied to EVERY
   tool result the agent consumes — the model proposes, a typed
   validator approves, malformed intermediates fail closed rather
   than propagating into a plausible-sounding final answer. Zod (or
   the repo-consistent equivalent) schemas; each validated result
   carries a _provenance marker naming its source table + row keys.

2. assertNarrativeIsGrounded() wired INTO the veris_agent.ts loop,
   not alongside it: every number, percentage, dollar figure, and
   claim-count in the final narrative must trace to a _provenance
   marker from a validated tool result; an ungrounded figure fails
   the turn closed (structured error, no narrative emitted). A
   hermetic test feeds a deliberately-ungrounded narrative fixture
   and MUST fail.

3. Versioning (§8.5.6): prompt_version and tool_schema_version
   fields on the _provenance record persisted with every emitted
   narrative/recommendation, so "which prompt produced this claim's
   recommendation six weeks ago" is a query, not archaeology.
   Versions live as constants beside the prompt/tool definitions;
   document the bump rule (any semantic change to system prompt or
   any tool schema = bump) in veris-data-notes.md.

4. CAPA table (§8.5.4): audit.ai_output_corrections
   (id, business_entity_id FK RESTRICT, claim_line_id, brain,
   predicted, actual, root_cause, corrective_action, fix_shipped,
   verified_at, created_by, created_at) + a minimal write path so a
   biller-corrected output can be recorded from day one. RLS,
   tenant-scoped, rollback script.

5. Decision-record audit, distinct from PHI-access audit: when the
   agent recommends hold/flag/appeal, persist a decision record
   (claim ref, action recommended, brains consulted with their
   _provenance, prompt_version, timestamp, acting principal if a
   human confirms). Payers and auditors ask for this trail
   eventually; it is not the same table as query_log.

6. Hard ceilings in code, not comments: 6 tool turns max (existing
   cap becomes an enforced constant), explicit max_tokens per call,
   and an end-to-end latency budget recorded as a constant the
   Session-10 UI will design against (target: first streamed
   partial < 8s — Alec confirms or adjusts the number in FIRST
   OUTPUT). Cache the CMS PFS anchor and CARC/RARC reference lookups
   within an agent run — they change quarterly at most.

7. Cost logging: confirm the Session-7 item-6 logging wraps THIS
   loop too (business_entity_id + model + token counts per call).

DEFINITION OF DONE

- All three validators enforced on every tool result; ungrounded-
  narrative fixture fails closed; hermetic tests green.
- prompt_version/tool_schema_version persisted end-to-end.
- CAPA + decision-record tables live with RLS + rollbacks; isolation
  suite green.
- Ceilings enforced; ref-lookup caching demonstrated (call-count
  assertion in a test).
- Both typechecks + full test suite clean.

HOLD GATES

HOLD before the two audit-table migrations; HOLD before any change
to the live agent's system prompt or tool schemas (that's a version
bump + shown diff); HOLD before commit/push.

FIRST OUTPUT I WANT

The validator/type structure and the latency-budget number
confirmation — before code.

END OF SESSION

Handoff for Session 10 (four sections, <500 words, my voice). Open
threads: the confirmed latency budget and the streaming implication
for the route design.
=====================================================================
```
