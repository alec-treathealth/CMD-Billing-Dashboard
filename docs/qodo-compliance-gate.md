# Qodo Compliance Gate — required status check contract

This document pins the exact string that must be configured as a required
status check for the [`Qodo Compliance Gate`](../.github/workflows/qodo-compliance-gate.yml)
workflow, and captures the rename hazard so it does not silently break merges.

## Required status check name

Configure this **exact** string in branch protection on both `main` and
`staging`:

```
Qodo Compliance Gate / gate
```

GitHub composes this string as `<workflow name> / <job id>`, so the two halves
are load-bearing:

| Half | Source | Current value |
|------|--------|---------------|
| Left of ` / ` | `name:` at the top of `qodo-compliance-gate.yml` | `Qodo Compliance Gate` |
| Right of ` / ` | The key under `jobs:` (not `jobs.<key>.name`) | `gate` |

## Do not rename without a coordinated update

If either half changes, GitHub keeps waiting for the old check name — it
reports "Expected — Waiting for status to be reported" indefinitely and the
branch becomes un-mergeable. GitHub does not warn you at rename time; the
mismatch only surfaces on the next PR.

Before editing `name:` or the `gate` job key:

1. Open **Settings → Branches → Branch protection rules** for both `main`
   and `staging` (or use the branch-protection REST API).
2. In "Require status checks to pass before merging", remove the old
   `Qodo Compliance Gate / gate` entry and add the new
   `<new-name> / <new-job-key>` entry.
3. Land the workflow rename in the same PR that documents the new string
   here.
4. After merge, open a throwaway PR and confirm the new check appears in
   the merge-box status list before closing.

There is no in-repo enforcement of this contract. The workflow file, this
doc, and the branch-protection UI are the only sources of truth — keep them
in sync manually.

## Checklist file discovery (hardcoded)

Qodo Merge's compliance tool reads the repo-level checklist from a **fixed
filename at the repo root**:

```
pr_compliance_checklist.yaml
```

Per the [Qodo custom-compliance docs](https://docs.qodo.ai/v1/features/custom-compliance),
`pr_compliance_checklist.yaml` is a hardcoded name. Moving it to `.qodo/`,
`.github/`, or renaming it (e.g. `compliance.yaml`) makes it invisible to the
tool — no error, no warning, checklist just goes silent. The workflow's
`checklist_discovery` job asserts:

1. The file exists at exactly `pr_compliance_checklist.yaml` (repo root).
2. It has a top-level `pr_compliances:` key.
3. No stray copies exist under `.qodo/`, `.github/`, `.pr_agent/`, or `.qodo-merge/`
   (would suggest someone thought the name was flexible and left a decoy).

If that job fails on a PR, either the checklist has been moved/renamed
(fix by moving it back to the root with the exact name) or the YAML shape
drifted (fix by restoring the `pr_compliances:` list).

Qodo does not expose a signal that says "I read your checklist on PR #N," so
this file-existence guard is the closest thing to a "Qodo is reading it"
assertion available in-repo.

## Related

- Workflow: [`.github/workflows/qodo-compliance-gate.yml`](../.github/workflows/qodo-compliance-gate.yml)
- Checklist file: [`pr_compliance_checklist.yaml`](../pr_compliance_checklist.yaml)
- Override for renamed labels: repo/org variable `QODO_BLOCKING_LABELS`
  (comma-separated). Default: `Possible security concern,Failed compliance check`.
