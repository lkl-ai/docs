#!/usr/bin/env bash
# Generates STATUS.md at the repo root by delegating to a Node helper.
# Safe to run locally (uses `gh` if available, writes no-op if unchanged)
# and in CI. See .github/workflows/repo-status.yml for the scheduled job.
#
# The Node implementation lives alongside this shim because the rest of
# the repo is Node/ESM — avoids fragile shell-quoting for JSON work.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
exec node scripts/generate-status.mjs
