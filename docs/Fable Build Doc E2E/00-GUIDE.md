# Veris Prompt Library — Operator's Guide

**Owner:** Alec Lowi · Treat Health AI **Executes:** the Veris/Indigo Master Plan, end to end, as 13 gated Claude Code sessions **Repo:** `alec-treathealth/CMD-Billing-Dashboard` (local: `/Users/aleclowi/CMD-Billing-Dashboard`)

---

## What this library is

The master plan's Section 9 was one mega-prompt covering five sprints. That degrades in practice — a single Claude Code session loses fidelity long before Sprint 3, and your own handoff discipline exists because of exactly that. This library decomposes the plan into **13 self-contained session prompts**, each sized to one clean Claude Code session, each ending with a handoff that becomes the opening context of the next. Nothing from the plan is dropped; the 8.5 review lenses (VPE, DB-design, tribal-knowledge, QMS, RAG, AI-SaaS-ops) are baked into the sessions where they bind.

One deliberate deviation from the plan, flagged honestly: the plan draws Sprint 2 and the Indigo Track as parallel. With you \+ Syed as the whole team, they aren't. This library **sequences** them (S4 → S5 → S6) per the plan's own VPE-lens critique (§8.5.1). If Syed takes a lane independently, S5–S6 can run concurrently with S4 — the prompts don't assume it.

---

## The session map

| \# | Session | Plan source | Blocks on | Unblocks |
| :---- | :---- | :---- | :---- | :---- |
| S1 | Ground truth & ADR ratification | §1, §9 FIRST OUTPUT, Sprint 0 | PG-A | everything |
| S2 | Tenancy foundation & isolation test | Sprint 0, §4.1, §8.5.2 | S1 | S3, S5 |
| S3 | ETL \+ reference data | Sprint 1, Veris Phases 0–1 | S1 answers, S2 | S4 |
| S4 | Python ML runtime | Sprint 2, Veris Phase 2 | S3 | S8 retrain, S9 |
| S5 | Real auth (`business_entity_id` in session) | Indigo Track, §6.1 | S2 | S6, S7, S10 |
| S6 | Per-tenant CMD ingest \+ feature flags | Indigo Track, §4.2–4.3 | S5 | S7 |
| S7 | **Production Readiness Gate** \+ first Indigo ingest | §9 gate, PG-B | S2–S6, BAA signed | S8+ on real 2-tenant data |
| S8 | 835/ERA ingestion \+ Brain 1 retrain | Sprint 3, Veris Phase 3 | S4, S7 | Brain 2 live, S9 |
| S9 | Agent validation & provenance | Sprint 4a, §8.5.4, §8.5.6 | S4 | S10, S11 |
| S10 | Veris UI | Sprint 4b, Veris Phase (UI) | S5, S9 | PG-C |
| S11 | Internal MCP servers | §7.3 | S9 | team leverage |
| S12 | Evals & observability | §6.3, §8.5.5 | S8–S10 | trust at scale |
| S13 | GTM instrumentation | Sprint 5, §7.4 | PG-C | tenant \#3 pitch |

Dependency shape:

```
PG-A → S1 → S2 → S3 → S4 ─────────────┐
              └→ S5 → S6 → [S7 GATE] → S8 → S9 → S10 → [PG-C] → S13
                                              └→ S11        S12
```

---

## The three product gates (not coding sessions)

These run in **chat / Claude Desktop**, not Claude Code. They exist because the CPO/PMF lenses catch things a build session structurally can't — a session mid-migration will always vote to keep building.

**PG-A — before S1.** Run `/cs:cpo-review` on the Section-1 ADR and the §3 market thesis, then the andreessen forcing questions. The master plan pre-answers most of this; the gate is *ratification in writing*, not re-derivation. You must be able to answer, without squinting: (1) what market is pulling this out of you — OON BH billers with real budget, or your own two facilities? (2) why now — what changed (Stedi-era 835 access, Claude-class reasoning, your 3-year labeled dataset)? (3) which single signal will prove PMF (a biller changing pre-submission behavior on the risk score is the plan's own answer — §3.3 assumption 1)? (4) what kills this (no CAS-level 835 → Brain 2 dead → §2.3's hard prerequisite)? The output is one paragraph in Veris's CLAUDE.md — S1 writes it.

**PG-B — before S7 opens the gate to real Indigo data.** Three confirmations, in writing: the Indigo BAA/DPA is signed (with the pooled-training clause status noted separately — they are two clauses, §8.5.4); Indigo tolerates shared-Postgres RLS tenancy (§3.3 assumption 3 — this changes the architecture if wrong, so it must precede ingest, not follow it); and the risk-score behavior test (§3.3 assumption 1\) has a defined measurement plan before the UI ships it.

**PG-C — after S10, before S13.** Real usage exists now. Run `/andreessen:pmf-check` (the signal scorer) against actual biller behavior, and `/cs:cpo-review` on North Star metric \+ pricing model (per-claim vs %-recovered vs seat — §6.3). S13 instruments whatever you decide here; don't let S13 pick the pricing model by default.

---

## The per-session ritual

1. **Open a fresh Claude Code session** at the repo root (`/Users/aleclowi/CMD-Billing-Dashboard` — never `app/`; deploys from `app/` pick up the wrong config).  
2. **Paste the previous session's handoff first**, then the session prompt file, whole, in one message. (S1 has no predecessor — paste the prompt alone.)  
3. **Answer the FIRST OUTPUT questions** before letting any code get written. Every session opens with verification questions; they are the cheap insurance against the "assumed uuid, silent RLS no-op" class of bug (§8.5.2).  
4. **Work artifact-by-artifact through the HOLDs.** Diff shown → you say go → it lands. `npm test` \+ both typechecks before any commit is proposed — the session prompts encode this, but it's your job to actually read the diffs.  
5. **End every session with the handoff.** Each prompt's final instruction invokes your prompt-handoff pattern (Who you are / Where we are / Open threads / Pick up here). Save it; it's the top of the next session's paste.  
6. **Update `docs/veris-data-notes.md`** with anything learned the hard way — join keys, field quirks, timings. This is the §8.5.3 tribal-knowledge rule; S1 creates the file, every session feeds it.

**When a session goes sideways:** if it passes \~25–30 turns with work remaining, cut a handoff and resume fresh — don't push a degrading context through a migration. If Claude observes something in the live schema or CLAUDE.md that conflicts with the prompt, the prompts instruct it to stop and surface; when that fires, resolve it yourself in writing before continuing. If scope creep appears ("while we're in here…"), the answer is: new session, new prompt — the SCOPE block in each file is the contract.

---

## Skill invocation map

Invoke these inside or alongside the named session. `senior-engineer`, `zero-hallucination-coder` discipline, and `prompt-handoff` apply to **every** session and aren't repeated below.

| Session | Skills to invoke |
| :---- | :---- |
| S1 | `desktop-commander:terminal`, `engineering-skills:senior-architect` |
| S2 | `engineering-advanced-skills:database-schema-designer`, `sql-database-assistant` |
| S3 | `engineering-skills:senior-data-engineer`, `data:write-query` |
| S4 | `engineering-skills:senior-ml-engineer`, `engineering-advanced-skills:ci-cd-pipeline-builder` |
| S5 | `engineering-skills:senior-fullstack`, `engineering-skills:senior-secops`, `hipaa-compliance` |
| S6 | `engineering-skills:senior-backend`, `engineering-advanced-skills:env-secrets-manager` |
| S7 | `hipaa-compliance`, `soc2-owasp-compliance`, `engineering-advanced-skills:ship-gate` |
| S8 | `engineering-skills:senior-data-engineer` (+ `n8n-builder` only if you choose the n8n path) |
| S9 | `engineering-skills:senior-prompt-engineer`, `ai-llm-saas-expert`, `prompt-governance` |
| S10 | `product-skills:ui-design-system`, `treatmh-departments`, `frontend-design`, `senior-frontend` |
| S11 | `engineering-advanced-skills:mcp-server-builder`, `mcp-builder` |
| S12 | `slo-architect`, `engineering-advanced-skills:observability-designer`, `senior-prompt-engineer` (evals) |
| S13 | `product-skills:product-analytics`, `finance-skills:saas-metrics-coach`, `llm-cost-optimizer` |
| PG-A/C | `/cs:cpo-review`, `andreessen` (pmf-check), `product-skills:product-strategist` |

---

## Universal invariants (already inside every prompt — listed here so you can audit)

PHI denylist absolute (`patient_last`, `patient_first`, `member_id`, `dob` never in logs, prompts, summaries, brain features, or embedding inputs) · gate-review with HOLD before commit/migration/push/ deploy · no `Co-Authored-By` ever · parameterized queries \+ column allowlists · `claims_reader` for reads · Supavisor 6543, no named prepared statements · idempotent-forward **and** written rollback per migration · composite indexes lead with `business_entity_id` · `ON DELETE RESTRICT` on tenant FKs · tenant GUC set server-side only · CMD-Billing-Dashboard's locked semantics untouched · conflicts between prompt and observed reality get surfaced, never silently resolved.  
