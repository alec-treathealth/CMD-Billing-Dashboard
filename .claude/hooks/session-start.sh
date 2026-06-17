#!/bin/bash
# SessionStart hook: pin git author identity for this repo.
#
# Claude commit/PR attribution suppression lives in .claude/settings.json
# (attribution.commit/pr = ""), which Claude Code reads directly. This script
# handles the part git owns — the commit author — so every fresh session
# authors as the user rather than the container default. Idempotent.
set -euo pipefail

git config user.name "alec-treathealth"
git config user.email "alec@treathealth.ai"
